import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	AccountDeletionInProgressError,
	assertAccountWritable,
} from '#worker/account/deletion-state.ts'
import {
	accountSuspendedErrorCode,
	accountSuspendedMessage,
	isAccountSuspended,
} from '#worker/account/account-suspension.ts'
import { checkRateLimit } from '#app/rate-limit.ts'
import { findPublicOwnerIdentityByHandle } from '#worker/identity/user-lookup.ts'
import { attestedPackageStamp } from '#worker/credentials/package-stamp.ts'
import {
	buildCredentialPlacementRefusedWebhookError,
	credentialPlacementRefusedCode,
	readCredentialPlacementRefusalFromInvocationBody,
} from '#worker/credentials/placement-refusal.ts'
import { resolveCredential } from '#worker/credentials/resolve-credential.ts'
import { PackageSecretAccessDeniedError } from '#mcp/secrets/package-access.ts'
import { planEnablementRuns } from '#worker/enablements/run-gate.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	listPackageWebhooks,
	webhookHmacVerification,
} from '#worker/package-registry/manifest.ts'
import { resolveSavedPackageRef } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { describeWebhookNotOn } from './approval.ts'
import {
	handleWebhookSubscriptionChallenge,
	webhookChallengeAllowsGet,
	webhookChallengeAllowsPost,
} from './challenge.ts'
import {
	buildWebhookDeliveryIdempotencyKey,
	buildWebhookTimestampBodyPayload,
	isWebhookTimestampWithinTolerance,
	parseWebhookReplayTimestamp,
	matchWebhookIngressUrlSecret,
	providedWebhookHmacValues,
	verifyWebhookHmacSignature,
} from './crypto.ts'
import {
	dispatchWebhookInvocation,
	readWebhookInvocationResult,
	recordWebhookDelivery,
} from './delivery.ts'
import {
	createWebhookDispatchQueueMessage,
	enqueueWebhookDispatch,
	getWebhookDispatchQueueMessageBytes,
	webhookDispatchQueueMessageMaxBytes,
	withSpilledWebhookDispatchPayload,
} from './dispatch-queue-producer.ts'
import {
	deleteWebhookDispatchPayload,
	storeWebhookDispatchPayload,
} from './dispatch-payload-store.ts'
import { collectSafeWebhookHeaders } from './headers.ts'
import {
	buildWebhookCallerIdempotencyHashParams,
	buildWebhookExportParams,
	readWebhookCallerIdempotencyKey,
	resolveWebhookParamsModeFirstArg,
} from './params.ts'
import { stripUntrustedWebhookSyntheticFields } from './synthetic.ts'
import {
	clearWebhookEndpointPreviousHmacSecret,
	clearWebhookEndpointPreviousUrlSecret,
	listWebhookEndpointsByName,
} from './repo.ts'
import {
	resolveWebhookHmacVerificationSecrets,
	type WebhookHmacVerificationSecret,
} from './signing-secret.ts'
import {
	isWebhookPreviousUrlLive,
	webhookDefaultReplayToleranceSeconds,
	webhookIdempotencyKeyHeader,
	webhookMaxPayloadBytes,
	webhookRateLimitConfigFor,
	webhookSyncInvocationTimeoutMs,
} from './types.ts'

function decodePathComponent(value: string) {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

/**
 * Pick the minted endpoint under a declared name whose current (or still-live
 * previous) URL secret matches the ingress path. Name alone is not identity
 * when several URLs share that name.
 */
export async function resolveWebhookEndpointForIngress(input: {
	db: D1Database
	userId: string
	packageId: string
	webhookName: string
	urlSecret: string
	now?: string
}): Promise<{
	endpoint: Awaited<ReturnType<typeof listWebhookEndpointsByName>>[number]
	secretMatch: 'current' | 'previous'
} | null> {
	const endpoints = await listWebhookEndpointsByName({
		db: input.db,
		userId: input.userId,
		packageId: input.packageId,
		webhookName: input.webhookName,
	})
	const now = input.now ?? new Date().toISOString()
	for (const endpoint of endpoints) {
		const secretMatch = await matchWebhookIngressUrlSecret({
			candidate: input.urlSecret,
			currentHash: endpoint.urlSecretHash,
			previousHash: endpoint.previousUrlSecretHash,
		})
		if (secretMatch === 'current') {
			return { endpoint, secretMatch }
		}
		if (secretMatch === 'previous' && isWebhookPreviousUrlLive(endpoint, now)) {
			return { endpoint, secretMatch }
		}
	}
	return null
}

export function parseWebhookIngressPath(pathname: string) {
	const parts = pathname.split('/').filter(Boolean)
	if (
		parts.length !== 5 ||
		!parts[0]?.startsWith('@') ||
		parts[0].length <= 1 ||
		parts[1] !== 'webhooks'
	) {
		return null
	}
	const username = decodePathComponent(parts[0].slice(1))
	const packageKodyId = decodePathComponent(parts[2] ?? '')
	const webhookName = decodePathComponent(parts[3] ?? '')
	const urlSecret = decodePathComponent(parts[4] ?? '')
	if (!username || !packageKodyId || !webhookName || !urlSecret) return null
	return { username, packageKodyId, webhookName, urlSecret }
}

export function isWebhookIngressRequest(pathname: string) {
	return parseWebhookIngressPath(pathname) !== null
}

/** Retire rotate-overlap only after the new URL is accepted for dispatch. */
async function retirePreviousWebhookUrlIfConfirmed(input: {
	env: Env
	endpoint: {
		id: string
		userId: OwnerId
		urlSecretHash: string
		previousUrlSecretHash: string | null
	}
	secretMatch: 'current' | 'previous'
}) {
	if (
		input.secretMatch !== 'current' ||
		!input.endpoint.previousUrlSecretHash
	) {
		return
	}
	await clearWebhookEndpointPreviousUrlSecret({
		db: input.env.APP_DB,
		userId: input.endpoint.userId,
		endpointId: input.endpoint.id,
		urlSecretHash: input.endpoint.urlSecretHash,
	})
}

/**
 * Retire signing-secret grace only after a delivery that verified under the
 * current declared key is accepted: ack enqueue succeeded, or sync dispatch
 * returned 2xx. Compare-and-swap against the observed previous ciphertext so a
 * concurrent rotation is not wiped.
 */
async function retirePreviousWebhookHmacIfConfirmed(input: {
	env: Env
	endpoint: { id: string; userId: OwnerId }
	matchedSource: WebhookHmacVerificationSecret['source'] | null
	previousHmacSecretEncrypted: string | null
}) {
	if (
		input.matchedSource !== 'declared' ||
		!input.previousHmacSecretEncrypted
	) {
		return
	}
	try {
		await clearWebhookEndpointPreviousHmacSecret({
			db: input.env.APP_DB,
			userId: input.endpoint.userId,
			endpointId: input.endpoint.id,
			previousHmacSecretEncrypted: input.previousHmacSecretEncrypted,
		})
	} catch (error) {
		// Bookkeeping only: never change the delivery outcome after dispatch
		// was accepted (ack already enqueued / sync about to invoke).
		console.error('webhook-previous-hmac-retire-failed', {
			endpointId: input.endpoint.id,
			error,
		})
	}
}

function notFoundResponse() {
	return jsonResponse(
		{
			ok: false,
			error: {
				code: 'not_found',
				message: 'Not found.',
			},
		},
		{ status: 404 },
	)
}

function formatPayloadLimitLabel(maxBytes: number) {
	const megabytes = maxBytes / (1024 * 1024)
	if (Number.isInteger(megabytes)) return `${megabytes} MB`
	return `${maxBytes} bytes`
}

function tooLargeResponse(maxBytes = webhookMaxPayloadBytes) {
	return jsonResponse(
		{
			ok: false,
			error: {
				code: 'payload_too_large',
				message: `Webhook payload exceeds the ${formatPayloadLimitLabel(maxBytes)} limit.`,
			},
		},
		{ status: 413 },
	)
}

function ackQueueMessageTooLargeResponse() {
	return jsonResponse(
		{
			ok: false,
			error: {
				code: 'payload_too_large',
				message:
					'Webhook payload is too large for asynchronous delivery (120 KB serialized limit).',
			},
		},
		{ status: 413 },
	)
}

function rateLimitedResponse(retryAfterSeconds: number) {
	return jsonResponse(
		{
			ok: false,
			error: {
				code: 'rate_limited',
				message: 'Too many webhook requests for this endpoint.',
			},
		},
		{
			status: 429,
			headers: {
				'Retry-After': String(retryAfterSeconds),
			},
		},
	)
}

function enablementNotOnResponse(input: {
	message: string
	approvalUrl: string | null
}) {
	return jsonResponse(
		{
			ok: false,
			error: {
				code: 'enablement_not_on',
				message: input.message,
				...(input.approvalUrl
					? { details: { approvalUrl: input.approvalUrl } }
					: {}),
			},
		},
		{ status: 409 },
	)
}

function invalidParamsResponse() {
	return jsonResponse(
		{
			ok: false,
			error: {
				code: 'invalid_params',
				message: 'inputMode "params" requires a JSON object body.',
			},
		},
		{ status: 400 },
	)
}

function unauthorizedSignatureResponse() {
	return jsonResponse(
		{
			ok: false,
			error: {
				code: 'invalid_signature',
				message: 'Webhook signature verification failed.',
			},
		},
		{ status: 401 },
	)
}

async function rejectUnauthorizedSignature(input: {
	env: Env
	endpoint: Parameters<typeof recordWebhookDelivery>[0]['endpoint']
	kodyId: string
	error: string
	payloadBytes: number
	startedAt: string
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	await recordWebhookDelivery({
		env: input.env,
		endpoint: input.endpoint,
		kodyId: input.kodyId,
		outcome: 'rejected',
		httpStatus: 401,
		error: input.error,
		payloadBytes: input.payloadBytes,
		startedAt: input.startedAt,
		waitUntil: input.waitUntil,
	})
	return unauthorizedSignatureResponse()
}

function dispatchUnavailableResponse() {
	return jsonResponse(
		{
			ok: false,
			error: {
				code: 'webhook_dispatch_unavailable',
				message: 'Webhook dispatch is temporarily unavailable. Please retry.',
			},
		},
		{ status: 503 },
	)
}

function waitUntilFrom(ctx?: ExecutionContext) {
	return ctx ? (promise: Promise<unknown>) => ctx.waitUntil(promise) : undefined
}

async function readBodyWithCap(
	request: Request,
	maxBytes: number,
): Promise<
	| { ok: true; bytes: Uint8Array }
	| { ok: false; response: Response; payloadBytes: number }
> {
	const contentLengthHeader = request.headers.get('content-length')
	if (contentLengthHeader) {
		const contentLength = Number(contentLengthHeader)
		if (Number.isFinite(contentLength) && contentLength > maxBytes) {
			return {
				ok: false,
				response: tooLargeResponse(),
				payloadBytes: contentLength,
			}
		}
	}
	const buffer = await request.arrayBuffer()
	if (buffer.byteLength > maxBytes) {
		return {
			ok: false,
			response: tooLargeResponse(),
			payloadBytes: buffer.byteLength,
		}
	}
	return { ok: true, bytes: new Uint8Array(buffer) }
}

async function runWithTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timeoutId = setTimeout(() => {
					reject(new Error('Webhook sync invocation timed out.'))
				}, timeoutMs)
			}),
		])
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId)
	}
}

function methodNotAllowedResponse(allow: string) {
	return jsonResponse(
		{
			ok: false,
			error: {
				code: 'method_not_allowed',
				message: 'Method not allowed.',
			},
		},
		{ status: 405, headers: { Allow: allow } },
	)
}

async function resolveWebhookChallengeSecret(input: {
	env: Env
	userId: OwnerId
	packageId: string
	baseUrl: string
	secretName: string
}) {
	const resolved = await resolveCredential({
		env: input.env,
		orgId: input.userId,
		actor: null,
		packageStamp: attestedPackageStamp(input.packageId),
		baseUrl: input.baseUrl,
		credential: { use: 'webhook-secret', name: input.secretName },
	}).catch((error: unknown) => {
		if (error instanceof PackageSecretAccessDeniedError) return null
		throw error
	})
	if (!resolved?.found || !resolved.value) return null
	return resolved.value
}

export async function handleWebhookIngressRequest(
	request: Request,
	env: Env,
	ctx?: ExecutionContext,
) {
	const pathname = new URL(request.url).pathname
	const route = parseWebhookIngressPath(pathname)
	if (!route) return notFoundResponse()
	if (request.method !== 'POST' && request.method !== 'GET') {
		return methodNotAllowedResponse('GET, POST')
	}

	const receivedAt = new Date().toISOString()
	const waitUntil = waitUntilFrom(ctx)
	const routeOwner = await findPublicOwnerIdentityByHandle({
		db: env.APP_DB,
		handle: route.username,
	})
	if (!routeOwner) return notFoundResponse()

	const savedPackage = await resolveSavedPackageRef(env.APP_DB, {
		userId: routeOwner.ownerId,
		ref: route.packageKodyId,
		match: 'slug',
		followRedirects: true,
	})
	if (!savedPackage) return notFoundResponse()

	// Several URLs may share a declared name; match the path secret to the
	// endpoint that owns it (current or still-live previous), not the oldest.
	const matched = await resolveWebhookEndpointForIngress({
		db: env.APP_DB,
		userId: routeOwner.ownerId,
		packageId: savedPackage.id,
		webhookName: route.webhookName,
		urlSecret: route.urlSecret,
		now: receivedAt,
	})
	// Unminted, disabled, wrong secret, or unknown name → indistinguishable 404.
	if (!matched || !matched.endpoint.enabled) {
		return notFoundResponse()
	}
	const liveEndpoint = matched.endpoint
	const secretMatch = matched.secretMatch

	const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
	let declared
	try {
		const loaded = await loadPackageManifestBySourceId({
			env,
			baseUrl,
			userId: routeOwner.ownerId,
			sourceId: savedPackage.sourceId,
		})
		declared = listPackageWebhooks(loaded.manifest).find(
			(webhook) => webhook.name === route.webhookName,
		)
	} catch {
		declared = undefined
	}

	const rateLimit = await checkRateLimit(
		env.APP_DB,
		`webhook:user:${liveEndpoint.userId}:endpoint:${liveEndpoint.id}`,
		webhookRateLimitConfigFor(declared?.rateLimitPerMinute),
	)
	if (!rateLimit.allowed) {
		return rateLimitedResponse(rateLimit.retryAfterSeconds ?? 60)
	}

	// Republished package removed/renamed the webhook → deactivate ingress.
	// Rate-limit first so a minted-but-undeclared URL cannot flush delivery
	// history without bound.
	if (!declared) {
		await recordWebhookDelivery({
			env,
			endpoint: liveEndpoint,
			kodyId: savedPackage.kodyId,
			outcome: 'rejected',
			httpStatus: 404,
			error: 'webhook_not_declared',
			payloadBytes: 0,
			startedAt: receivedAt,
			waitUntil,
		})
		return notFoundResponse()
	}

	const resolveChallengeSecret = (secretName: string) =>
		resolveWebhookChallengeSecret({
			env,
			userId: liveEndpoint.userId,
			packageId: liveEndpoint.packageId,
			baseUrl,
			secretName,
		})

	async function rejectAccountStateWithoutDelivery(input: {
		httpStatus: number
		code: string
		message: string
	}) {
		return jsonResponse(
			{
				ok: false,
				error: {
					code: input.code,
					message: input.message,
				},
			},
			{ status: input.httpStatus },
		)
	}

	async function assertOwnerAllowsChallenge(): Promise<Response | null> {
		try {
			await assertAccountWritable(env, liveEndpoint.userId)
		} catch (error) {
			if (!(error instanceof AccountDeletionInProgressError)) throw error
			return rejectAccountStateWithoutDelivery({
				httpStatus: 409,
				code: 'account_deleting',
				message: error.message,
			})
		}
		if (
			await isAccountSuspended({
				db: env.APP_DB,
				stableUserId: liveEndpoint.userId,
			})
		) {
			return rejectAccountStateWithoutDelivery({
				httpStatus: 403,
				code: accountSuspendedErrorCode,
				message: accountSuspendedMessage,
			})
		}
		return null
	}

	// Subscription challenges are answered by the platform only — never invoke
	// package code, never record delivery history, never mutate kody state.
	// Account-state rejects for challenge probes also skip delivery history.
	if (declared.challenge && request.method === 'GET') {
		const accountBlock = await assertOwnerAllowsChallenge()
		if (accountBlock) return accountBlock
		const challengeResult = await handleWebhookSubscriptionChallenge({
			request,
			challenge: declared.challenge,
			resolveSecret: resolveChallengeSecret,
		})
		if (challengeResult.kind === 'respond') {
			return challengeResult.response
		}
	}

	if (request.method !== 'POST') {
		return methodNotAllowedResponse(
			webhookChallengeAllowsGet(declared.challenge) ? 'GET, POST' : 'POST',
		)
	}

	const bodyResult = await readBodyWithCap(request, webhookMaxPayloadBytes)
	if (!bodyResult.ok) {
		await recordWebhookDelivery({
			env,
			endpoint: liveEndpoint,
			kodyId: savedPackage.kodyId,
			outcome: 'rejected',
			httpStatus: 413,
			error: 'payload_too_large',
			payloadBytes: bodyResult.payloadBytes,
			startedAt: receivedAt,
			waitUntil,
		})
		return bodyResult.response
	}
	const bodyBytes = bodyResult.bytes
	const bodyBuffer = bodyBytes.buffer.slice(
		bodyBytes.byteOffset,
		bodyBytes.byteOffset + bodyBytes.byteLength,
	) as ArrayBuffer
	const bodyText = new TextDecoder().decode(bodyBytes)

	if (declared.challenge && webhookChallengeAllowsPost(declared.challenge)) {
		const challengeResult = await handleWebhookSubscriptionChallenge({
			request,
			challenge: declared.challenge,
			resolveSecret: resolveChallengeSecret,
			bodyText,
		})
		if (challengeResult.kind === 'respond') {
			const accountBlock = await assertOwnerAllowsChallenge()
			if (accountBlock) return accountBlock
			return challengeResult.response
		}
	}

	try {
		await assertAccountWritable(env, liveEndpoint.userId)
	} catch (error) {
		if (!(error instanceof AccountDeletionInProgressError)) throw error
		await recordWebhookDelivery({
			env,
			endpoint: liveEndpoint,
			kodyId: savedPackage.kodyId,
			outcome: 'rejected',
			httpStatus: 409,
			error: 'account_deleting',
			payloadBytes: bodyBytes.byteLength,
			startedAt: receivedAt,
			waitUntil,
		})
		return jsonResponse(
			{
				ok: false,
				error: {
					code: 'account_deleting',
					message: error.message,
				},
			},
			{ status: 409 },
		)
	}

	if (
		await isAccountSuspended({
			db: env.APP_DB,
			stableUserId: liveEndpoint.userId,
		})
	) {
		await recordWebhookDelivery({
			env,
			endpoint: liveEndpoint,
			kodyId: savedPackage.kodyId,
			outcome: 'rejected',
			httpStatus: 403,
			error: accountSuspendedErrorCode,
			payloadBytes: bodyBytes.byteLength,
			startedAt: receivedAt,
			waitUntil,
		})
		return jsonResponse(
			{
				ok: false,
				error: {
					code: accountSuspendedErrorCode,
					message: accountSuspendedMessage,
				},
			},
			{ status: 403 },
		)
	}

	const rejectUnauthorized = (error: string) =>
		rejectUnauthorizedSignature({
			env,
			endpoint: liveEndpoint,
			kodyId: savedPackage.kodyId,
			error,
			payloadBytes: bodyBytes.byteLength,
			startedAt: receivedAt,
			waitUntil,
		})

	let replayTimestampToken: string | undefined
	if (declared.replay?.timestampHeader) {
		const timestampFormat = declared.replay.timestampFormat
		if (!timestampFormat) {
			return rejectUnauthorized('invalid_timestamp')
		}
		const parsedTimestamp = parseWebhookReplayTimestamp({
			headerValue: request.headers.get(declared.replay.timestampHeader),
			format: timestampFormat,
		})
		if (!parsedTimestamp.ok) {
			return rejectUnauthorized(
				parsedTimestamp.reason === 'missing'
					? 'missing_timestamp'
					: 'invalid_timestamp',
			)
		}
		const toleranceSeconds =
			declared.replay.toleranceSeconds ?? webhookDefaultReplayToleranceSeconds
		if (
			!isWebhookTimestampWithinTolerance({
				timestampMs: parsedTimestamp.timestampMs,
				nowMs: Date.parse(receivedAt),
				toleranceSeconds,
			})
		) {
			return rejectUnauthorized('timestamp_outside_tolerance')
		}
		replayTimestampToken = parsedTimestamp.timestampToken
	}

	if (declared.replay?.deliveryIdHeader) {
		const deliveryIdValue = request.headers
			.get(declared.replay.deliveryIdHeader)
			?.trim()
		if (!deliveryIdValue) {
			return rejectUnauthorized('missing_delivery_id')
		}
	}

	// A declared HMAC scheme never falls back to URL-secret-only auth.
	// Webhooks that declare no verification are permanently supported as
	// `{ type: 'url-secret' }`: senders like Gmail Pub/Sub and Microsoft Graph
	// cannot sign. The log counts requests that rely on the implicit default,
	// even ones a later check rejects.
	const verification = webhookHmacVerification(declared.verification)
	let matchedHmacSource: WebhookHmacVerificationSecret['source'] | null = null
	let observedPreviousHmacCiphertext: string | null = null
	if (!verification) {
		if (!declared.verification) {
			console.info('webhook-url-secret-only-authenticated', {
				endpointId: liveEndpoint.id,
				ownerId: liveEndpoint.userId,
				packageId: liveEndpoint.packageId,
				webhookName: liveEndpoint.webhookName,
			})
		}
	} else {
		const headerName = verification.header
		const provided = request.headers.get(headerName)
		if (!provided) {
			return rejectUnauthorized('missing_signature')
		}
		let hmacSecrets: Array<WebhookHmacVerificationSecret>
		let previousHmacSecretEncrypted: string | null = null
		try {
			const resolved = await resolveWebhookHmacVerificationSecrets({
				env,
				userId: liveEndpoint.userId,
				endpoint: liveEndpoint,
				verification,
			})
			hmacSecrets = resolved.secrets
			previousHmacSecretEncrypted = resolved.previousHmacSecretEncrypted
		} catch {
			return rejectUnauthorized(
				verification.secretName
					? `verification_secret_missing:${verification.secretName}`
					: 'verification_secret_missing:package_owned_hmac',
			)
		}
		const signedPayload = verification.signedPayload ?? 'body'
		let hmacPayload = bodyBuffer
		if (signedPayload === 'timestamp.body') {
			if (!replayTimestampToken) {
				return rejectUnauthorized('invalid_timestamp')
			}
			hmacPayload = buildWebhookTimestampBodyPayload({
				timestampToken: replayTimestampToken,
				body: bodyBuffer,
			})
		}
		const providedValues = providedWebhookHmacValues({
			provided,
			verificationHeader: headerName,
			timestampHeader: declared.replay?.timestampHeader,
			timestampFormat: declared.replay?.timestampFormat,
		})
		let matched: WebhookHmacVerificationSecret | null = null
		for (const secret of hmacSecrets) {
			for (const candidate of providedValues) {
				if (
					await verifyWebhookHmacSignature({
						algorithm: verification.type,
						secret: secret.value,
						body: hmacPayload,
						encoding: verification.encoding,
						prefix: verification.prefix,
						provided: candidate,
					})
				) {
					matched = secret
					break
				}
			}
			if (matched) break
		}
		if (!matched) {
			return rejectUnauthorized('invalid_signature')
		}
		if (matched.source === 'stored' && hmacSecrets[0]?.source === 'declared') {
			console.warn('webhook-signature-matched-stored-secret-not-declared', {
				endpointId: liveEndpoint.id,
				secretName: verification.secretName,
			})
		}
		matchedHmacSource = matched.source
		observedPreviousHmacCiphertext = previousHmacSecretEncrypted
	}

	const extraAllowedHeaders = [
		...(verification ? [verification.header] : []),
		...(declared.replay?.timestampHeader
			? [declared.replay.timestampHeader]
			: []),
		...(declared.replay?.deliveryIdHeader
			? [declared.replay.deliveryIdHeader]
			: []),
		webhookIdempotencyKeyHeader,
	]
	const safeHeaders = collectSafeWebhookHeaders(request, extraAllowedHeaders)
	const requestParams = buildWebhookExportParams({
		packageKodyId: savedPackage.kodyId,
		webhookName: route.webhookName,
		request,
		bodyText,
		receivedAt,
		headers: safeHeaders,
	})
	const paramsMode =
		declared.inputMode === 'params'
			? resolveWebhookParamsModeFirstArg(requestParams.request.json)
			: null
	if (paramsMode && !paramsMode.ok) {
		await recordWebhookDelivery({
			env,
			endpoint: liveEndpoint,
			kodyId: savedPackage.kodyId,
			outcome: 'rejected',
			httpStatus: 400,
			error: 'invalid_params',
			payloadBytes: bodyBytes.byteLength,
			startedAt: receivedAt,
			waitUntil,
		})
		return invalidParamsResponse()
	}
	const exportParams = paramsMode?.ok
		? stripUntrustedWebhookSyntheticFields(paramsMode.params)
		: requestParams
	const deliveryId = crypto.randomUUID()
	const callerIdempotencyKey = readWebhookCallerIdempotencyKey({
		request,
		json: requestParams.request.json,
		allowBodyKey: declared.inputMode === 'params',
	})
	const providerDeliveryId =
		!callerIdempotencyKey && declared.replay?.deliveryIdHeader
			? request.headers.get(declared.replay.deliveryIdHeader)?.trim()
			: undefined
	const idempotencyKey = callerIdempotencyKey
		? callerIdempotencyKey
		: providerDeliveryId
			? await buildWebhookDeliveryIdempotencyKey({
					userId: liveEndpoint.userId,
					packageId: liveEndpoint.packageId,
					webhookName: liveEndpoint.webhookName,
					deliveryId: providerDeliveryId,
				})
			: `webhook:${liveEndpoint.id}:${deliveryId}`
	// Delivery-id keys identify the event, not the HTTP attempt. Provider
	// retries change `receivedAt` and often headers; the same delivery id is
	// still that event even when body bytes differ. Matching the ledger by
	// key alone (`idempotencyParamsHash: 'ignore'`) returns the original
	// acknowledgement instead of hashing those volatile fields. A different
	// delivery id cannot reuse another event's ack because the key already
	// binds userId + packageId + webhookName + deliveryId.
	//
	// Caller Idempotency-Key (and params-mode JSON idempotencyKey) use the
	// standard include-hash ledger: same key + same payload replays; a
	// different payload is 409. Request-mode caller keys hash the JSON body
	// (not the envelope) so receivedAt does not break retries.
	const idempotencyParamsHash = providerDeliveryId
		? ('ignore' as const)
		: undefined
	const idempotencyHashParams =
		callerIdempotencyKey && declared.inputMode !== 'params'
			? buildWebhookCallerIdempotencyHashParams({
					json: requestParams.request.json,
					bodyText,
				})
			: undefined

	if (declared.responseMode === 'ack') {
		// Ack mode answers before the queue consumer runs, so the sender learns
		// here that nothing will run. The consumer checks again.
		const plan = await planEnablementRuns({
			env,
			orgId: liveEndpoint.userId,
			packageId: liveEndpoint.packageId,
			trigger: { kind: 'webhook', instanceId: liveEndpoint.id },
		})
		if (plan.runs.length === 0) {
			await recordWebhookDelivery({
				env,
				endpoint: liveEndpoint,
				kodyId: savedPackage.kodyId,
				outcome: 'rejected',
				httpStatus: 409,
				error: 'enablement_not_on',
				payloadBytes: bodyBytes.byteLength,
				startedAt: receivedAt,
				waitUntil,
			})
			return enablementNotOnResponse(
				await describeWebhookNotOn({
					env,
					baseUrl,
					endpoint: liveEndpoint,
					packageKodyId: savedPackage.kodyId,
					plan,
				}),
			)
		}
		let message = createWebhookDispatchQueueMessage({
			endpoint: {
				id: liveEndpoint.id,
				userId: liveEndpoint.userId,
				packageId: liveEndpoint.packageId,
				webhookName: liveEndpoint.webhookName,
			},
			packageKodyId: savedPackage.kodyId,
			exportName: declared.exportName,
			params: requestParams,
			...(declared.inputMode === 'params'
				? { inputMode: 'params' as const }
				: {}),
			idempotencyKey,
			...(idempotencyParamsHash ? { idempotencyParamsHash } : {}),
			...(callerIdempotencyKey ? { callerIdempotency: true as const } : {}),
			deliveryId,
			payloadBytes: bodyBytes.byteLength,
			receivedAt,
		})
		if (
			getWebhookDispatchQueueMessageBytes(message) >
			webhookDispatchQueueMessageMaxBytes
		) {
			try {
				const payloadKvKey = await storeWebhookDispatchPayload({
					kv: env.BUNDLE_ARTIFACTS_KV,
					userId: liveEndpoint.userId,
					deliveryId,
					body: bodyText,
				})
				message = withSpilledWebhookDispatchPayload(message, payloadKvKey)
			} catch (error) {
				console.error('webhook-dispatch-payload-store-failed', {
					endpointId: liveEndpoint.id,
					error,
				})
				return dispatchUnavailableResponse()
			}
		}
		if (
			getWebhookDispatchQueueMessageBytes(message) >
			webhookDispatchQueueMessageMaxBytes
		) {
			if (message.payloadKvKey) {
				await deleteWebhookDispatchPayload({
					kv: env.BUNDLE_ARTIFACTS_KV,
					key: message.payloadKvKey,
				}).catch((error) => {
					console.error('webhook-dispatch-payload-delete-failed', {
						endpointId: liveEndpoint.id,
						error,
					})
				})
			}
			await recordWebhookDelivery({
				env,
				endpoint: liveEndpoint,
				kodyId: savedPackage.kodyId,
				outcome: 'rejected',
				httpStatus: 413,
				error: 'payload_too_large_for_ack_queue',
				payloadBytes: bodyBytes.byteLength,
				invocationId: deliveryId,
				startedAt: receivedAt,
				waitUntil,
			})
			return ackQueueMessageTooLargeResponse()
		}
		try {
			await enqueueWebhookDispatch({
				queue: env.WEBHOOK_DISPATCH_QUEUE,
				message,
			})
		} catch (error) {
			if (message.payloadKvKey) {
				await deleteWebhookDispatchPayload({
					kv: env.BUNDLE_ARTIFACTS_KV,
					key: message.payloadKvKey,
				}).catch((error) => {
					console.error('webhook-dispatch-payload-delete-failed', {
						endpointId: liveEndpoint.id,
						error,
					})
				})
			}
			console.error('webhook-dispatch-enqueue-failed', {
				endpointId: liveEndpoint.id,
				error,
			})
			return dispatchUnavailableResponse()
		}
		await retirePreviousWebhookUrlIfConfirmed({
			env,
			endpoint: liveEndpoint,
			secretMatch,
		})
		await retirePreviousWebhookHmacIfConfirmed({
			env,
			endpoint: liveEndpoint,
			matchedSource: matchedHmacSource,
			previousHmacSecretEncrypted: observedPreviousHmacCiphertext,
		})
		return jsonResponse({ ok: true }, { status: 202 })
	}

	try {
		await retirePreviousWebhookUrlIfConfirmed({
			env,
			endpoint: liveEndpoint,
			secretMatch,
		})
		const response = await runWithTimeout(
			dispatchWebhookInvocation({
				env,
				baseUrl,
				endpoint: liveEndpoint,
				packageKodyId: savedPackage.kodyId,
				exportName: declared.exportName,
				params: exportParams,
				idempotencyKey,
				claimOwner: deliveryId,
				...(idempotencyParamsHash ? { idempotencyParamsHash } : {}),
				...(idempotencyHashParams ? { idempotencyHashParams } : {}),
			}),
			webhookSyncInvocationTimeoutMs,
		)
		if (response.status === 409) {
			await recordWebhookDelivery({
				env,
				endpoint: liveEndpoint,
				kodyId: savedPackage.kodyId,
				outcome: 'rejected',
				httpStatus: 409,
				error: `invocation_status_409`,
				payloadBytes: bodyBytes.byteLength,
				invocationId: deliveryId,
				result: readWebhookInvocationResult(response.body),
				invocationBody: response.body,
				startedAt: receivedAt,
				waitUntil,
				request: response.request,
			})
			return jsonResponse(response.body, { status: 409 })
		}
		const ok = response.status >= 200 && response.status < 300
		const placementRefusal = ok
			? null
			: readCredentialPlacementRefusalFromInvocationBody(response.body)
		await recordWebhookDelivery({
			env,
			endpoint: liveEndpoint,
			kodyId: savedPackage.kodyId,
			outcome: ok ? 'delivered' : 'failed',
			httpStatus: ok ? response.status : 502,
			error: ok
				? null
				: placementRefusal
					? credentialPlacementRefusedCode
					: `invocation_status_${response.status}`,
			payloadBytes: bodyBytes.byteLength,
			invocationId: deliveryId,
			result: readWebhookInvocationResult(response.body),
			invocationBody: response.body,
			startedAt: receivedAt,
			waitUntil,
			request: response.request,
		})
		if (!ok) {
			return jsonResponse(
				{
					ok: false,
					error: placementRefusal
						? buildCredentialPlacementRefusedWebhookError(placementRefusal.slot)
						: {
								code: 'invocation_failed',
								message: 'Bound package export invocation failed.',
							},
				},
				{ status: 502 },
			)
		}
		// Sync: retire only after a successful invocation. A 409/502/timeout
		// must leave previous_* so providers still retrying the old key keep
		// working for the rest of the grace window.
		await retirePreviousWebhookHmacIfConfirmed({
			env,
			endpoint: liveEndpoint,
			matchedSource: matchedHmacSource,
			previousHmacSecretEncrypted: observedPreviousHmacCiphertext,
		})
		return jsonResponse(response.body, { status: response.status })
	} catch (error) {
		await recordWebhookDelivery({
			env,
			endpoint: liveEndpoint,
			kodyId: savedPackage.kodyId,
			outcome: 'failed',
			httpStatus: 502,
			error: error instanceof Error ? error.message : 'invocation_failed',
			payloadBytes: bodyBytes.byteLength,
			invocationId: deliveryId,
			startedAt: receivedAt,
			waitUntil,
		})
		return jsonResponse(
			{
				ok: false,
				error: {
					code: 'invocation_failed',
					message: 'Bound package export invocation failed.',
				},
			},
			{ status: 502 },
		)
	}
}
