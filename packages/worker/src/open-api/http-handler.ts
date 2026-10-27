import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import {
	assertAccountWritableDb,
	withAccountWriteLease,
} from '#worker/account/deletion-state.ts'
import { getStaticRegistry } from '#mcp/capabilities/registry.ts'
import { redeemCliCredentialBootstrap } from '#worker/api-tokens/cli-credential-bootstrap.ts'
import {
	recordUsage,
	usageAttributionFieldsFromRequest,
} from '#worker/usage/record-usage.ts'
import { authenticateApiRequest } from './authenticate.ts'
import { type ApiInvocationContext } from './context.ts'
import {
	buildOpenApiDocument,
	kodyApiVersion,
	resolveApiOperation,
} from './document.ts'
import {
	ApiError,
	apiErrorResponse,
	invalidRequest,
	notFound,
	toApiError,
} from './errors.ts'
import {
	authorizeSurface,
	type SurfacePermission,
	surfacePermissionList,
} from '#worker/authorization/authorize.ts'
import {
	capabilityProxyObservationEntityId,
	invokeApiOperation,
	isCapabilityProxyOperation,
	operationAllowsCliOauth,
	isCliCredentialBootstrapRedeemOperation,
} from './invoke.ts'
import { runCapabilityProxyGatewayFetchStream } from './capability-proxy-gateway-fetch-stream.ts'
import { parseNativeInput } from './native-operation-helpers.ts'
import {
	apiOperationUsesQueryInputs,
	isCapabilityProxyGatewayFetchOperation,
	matchApiRoute,
	type ApiOperation,
} from './operations.ts'
import {
	maxApiRequestBodyBytes,
	mergeApiParams,
	readJsonBody,
	readQueryParams,
} from './request-params.ts'
import { bootstrapRedeemInputSchema } from './token-operations.ts'

export const openApiDocumentPath = '/openapi.json'

function operationNeedsAccountWriteLease(resolved: {
	readOnly: boolean
	permission: SurfacePermission
}) {
	if (!resolved.readOnly) return true
	return surfacePermissionList(resolved.permission).some(
		(permission) =>
			permission.endsWith(':write') ||
			permission.endsWith(':delete') ||
			permission.endsWith(':create') ||
			permission.endsWith(':use') ||
			permission.endsWith(':send') ||
			permission.endsWith(':publish'),
	)
}

/**
 * Serialized OpenAPI document per server origin with a strong ETag equal to
 * the SHA-256 of the body, so clients revalidate by content rather than by
 * age. Built once per isolate per origin, like the document itself.
 */
const openApiResponseMemo = new Map<
	string,
	Promise<{ text: string; etag: string }>
>()

function openApiResponseBody(serverUrl: string) {
	let memo = openApiResponseMemo.get(serverUrl)
	if (!memo) {
		memo = buildOpenApiDocument({ serverUrl }).then(async (document) => {
			const text = JSON.stringify(document)
			return { text, etag: `"${await sha256Hex(text)}"` }
		})
		memo.catch(() => openApiResponseMemo.delete(serverUrl))
		openApiResponseMemo.set(serverUrl, memo)
	}
	return memo
}

async function sha256Hex(text: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(text),
	)
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
}

/**
 * RFC 9110 If-None-Match: `*` or 1#entity-tag. Opaque tags are quoted and may
 * contain commas, so the list is not split on every comma. Weak and strong
 * tags compare by opaque value.
 */
function etagMatches(ifNoneMatch: string | null, etag: string) {
	if (!ifNoneMatch) return false
	const trimmed = ifNoneMatch.trim()
	if (trimmed === '*') return true
	const target = etag.trim().replace(/^W\//, '')
	for (const match of trimmed.matchAll(/(?:W\/)?"[^"]*"/g)) {
		if (match[0].replace(/^W\//, '') === target) return true
	}
	return false
}

function json(body: unknown, init: ResponseInit = {}) {
	return Response.json(body ?? null, {
		...init,
		headers: { 'Cache-Control': 'no-store', ...init.headers },
	})
}

function deprecatedForwardHeaders(
	operation: ApiOperation,
): Record<string, string> | undefined {
	if (operation.kind !== 'capability' || !operation.deprecatedForward) {
		return undefined
	}
	const { deprecatedAt, sunset } = operation.deprecatedForward
	const deprecatedUnixSeconds = Math.floor(
		new Date(`${deprecatedAt}T00:00:00.000Z`).getTime() / 1000,
	)
	return {
		Deprecation: `@${deprecatedUnixSeconds}`,
		Sunset: new Date(`${sunset}T00:00:00.000Z`).toUTCString(),
		Link: '<https://kody.codes/docs/api-versioning.md>; rel="deprecation"',
	}
}

async function readOperationParams(input: {
	request: Request
	url: URL
	match: Extract<ReturnType<typeof matchApiRoute>, { kind: 'match' }>
	inputSchema: Record<string, unknown>
}) {
	if (apiOperationUsesQueryInputs(input.match.operation.method)) {
		return mergeApiParams(
			input.match.pathParams,
			readQueryParams(input.url.searchParams, input.inputSchema),
		)
	}
	const body = await readJsonBody(input.request)
	switch (body.kind) {
		case 'too_large':
			throw new ApiError({
				status: 413,
				code: 'payload_too_large',
				message: `Request body is ${body.byteLength} bytes; the maximum is ${maxApiRequestBodyBytes} bytes.`,
			})
		case 'unsupported_media_type':
			throw new ApiError({
				status: 415,
				code: 'unsupported_media_type',
				message: 'Request body must be application/json.',
			})
		case 'ok':
			return mergeApiParams(input.match.pathParams, body.body)
		default: {
			const exhaustive: never = body
			throw new Error(`Unexpected body result: ${String(exhaustive)}`)
		}
	}
}

async function handleOperation(input: {
	request: Request
	url: URL
	env: Env
	appOrigin: string
	waitUntil: (promise: Promise<unknown>) => void
	loopbackExports?: Cloudflare.Exports
}) {
	const match = matchApiRoute(input.request.method, input.url.pathname)
	switch (match.kind) {
		case 'not_found':
			throw notFound(
				`No route for ${input.request.method} ${input.url.pathname}. See ${openApiDocumentPath}.`,
			)
		case 'method_not_allowed':
			throw new ApiError({
				status: 405,
				code: 'method_not_allowed',
				message: `Method ${input.request.method} is not allowed here.`,
				headers: { Allow: match.allow.join(', ') },
			})
		case 'match':
			break
		default: {
			const exhaustive: never = match
			throw new Error(`Unexpected route match: ${String(exhaustive)}`)
		}
	}
	const startedAt = Date.now()
	const matchedOperation = match.operation

	// ADR 0056: CLI bootstrap redeem is code-authenticated only (no Bearer).
	if (isCliCredentialBootstrapRedeemOperation(matchedOperation)) {
		if (input.request.headers.get('Authorization')) {
			throw invalidRequest(
				'Do not send Authorization on bootstrap redeem; the one-shot code is the credential.',
			)
		}
		const resolved = resolveApiOperation(
			matchedOperation,
			await getStaticRegistry(),
		)
		const params = await readOperationParams({
			request: input.request,
			url: input.url,
			match,
			inputSchema: resolved.inputSchema,
		})
		const redeemInput = parseNativeInput(bootstrapRedeemInputSchema, params)
		const redeemed = await redeemCliCredentialBootstrap({
			db: input.env.APP_DB,
			code: redeemInput.code,
			env: input.env,
			...(redeemInput.lifetime === undefined
				? {}
				: { lifetime: redeemInput.lifetime }),
			...(redeemInput.idle_ttl_seconds === undefined
				? {}
				: { idleTtlSeconds: redeemInput.idle_ttl_seconds }),
			...(redeemInput.max_lifetime_seconds === undefined
				? {}
				: { maxLifetimeSeconds: redeemInput.max_lifetime_seconds }),
		})
		input.waitUntil(
			recordUsage(
				input.env,
				{
					userId: redeemed.userId,
					eventType: 'api_call',
					entityId: matchedOperation.operationId,
					durationMs: Date.now() - startedAt,
					outcome: 'success',
				},
				{ waitUntil: input.waitUntil },
			),
		)
		return json(redeemed.token)
	}

	function recordCapabilityProxyObservation(observation: {
		userId: OwnerId
		failureCode: string
		request?: Parameters<typeof usageAttributionFieldsFromRequest>[0]
	}) {
		if (!isCapabilityProxyOperation(matchedOperation)) return
		input.waitUntil(
			recordUsage(
				input.env,
				{
					userId: observation.userId,
					eventType: 'api_call',
					entityId: capabilityProxyObservationEntityId({
						baseEntityId: matchedOperation.operationId,
						outcome: 'error',
						failureCode: observation.failureCode,
					}),
					durationMs: Date.now() - startedAt,
					outcome: 'error',
					...usageAttributionFieldsFromRequest(observation.request),
				},
				{ waitUntil: input.waitUntil },
			),
		)
	}

	let ctx
	try {
		ctx = await authenticateApiRequest({
			...input,
			// CLI `kody login` OAuth is accepted on local-execute routes (older
			// CLIs) and on POST /v1/tokens/device (mint a device kody_at_).
			// Other Open API ops stay `kody_at_`-only (ADR 0053/0055).
			allowMcpOauth: operationAllowsCliOauth(matchedOperation),
		})
	} catch (error) {
		const apiError = toApiError(error)
		if (apiError instanceof ApiError && apiError.meteringUserId) {
			recordCapabilityProxyObservation({
				userId: apiError.meteringUserId,
				failureCode: apiError.code,
			})
		}
		throw error
	}
	if (input.loopbackExports) ctx.loopbackExports = input.loopbackExports
	const resolved = resolveApiOperation(
		matchedOperation,
		await getStaticRegistry(),
	)
	// Authorize before param parse so under-scoped tokens get 403
	// insufficient_scope instead of 400 parse errors. CapabilityProxy
	// preflight failures meter here (one event); invoke still meters the hop
	// after params are accepted.
	try {
		await authorizeSurface(
			{ env: ctx.env, request: ctx.callerContext.request },
			resolved.permission,
		)
	} catch (error) {
		const apiError = toApiError(error)
		if (apiError instanceof ApiError) {
			recordCapabilityProxyObservation({
				userId: personalOrgIdForPerson(ctx.callerContext.user),
				failureCode: apiError.code,
				request: ctx.callerContext.request,
			})
		}
		throw error
	}
	if (isCapabilityProxyGatewayFetchOperation(matchedOperation)) {
		return handleCapabilityProxyGatewayFetchStream({
			request: input.request,
			ctx,
			env: input.env,
			waitUntil: input.waitUntil,
			startedAt,
			operationId: matchedOperation.operationId,
			resolved,
		})
	}
	const params = await readOperationParams({
		request: input.request,
		url: input.url,
		match,
		inputSchema: resolved.inputSchema,
	})
	const userId = personalOrgIdForPerson(ctx.callerContext.user)
	const run = () =>
		invokeApiOperation({
			operationId: matchedOperation.operationId,
			params,
			ctx,
		})
	const deprecationHeaders = deprecatedForwardHeaders(matchedOperation)
	const responseInit = deprecationHeaders ? { headers: deprecationHeaders } : {}
	const writes = operationNeedsAccountWriteLease(resolved)
	if (!writes) {
		await assertAccountWritableDb(input.env.APP_DB, userId)
		return json(await run(), responseInit)
	}
	const result = await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: userId,
		holder: `api:${matchedOperation.operationId}`,
		env: input.env,
		write: run,
	})
	return json(result, responseInit)
}

async function handleCapabilityProxyGatewayFetchStream(input: {
	request: Request
	ctx: ApiInvocationContext
	env: Env
	waitUntil: (promise: Promise<unknown>) => void
	startedAt: number
	operationId: string
	resolved: ReturnType<typeof resolveApiOperation>
}) {
	const userId = personalOrgIdForPerson(input.ctx.callerContext.user)
	const run = () =>
		runCapabilityProxyGatewayFetchStream({
			ctx: input.ctx,
			request: input.request,
		})
	let outcome: 'success' | 'error' = 'error'
	let failureCode: string | null = null
	try {
		const writes = operationNeedsAccountWriteLease(input.resolved)
		let response: Response
		if (!writes) {
			await assertAccountWritableDb(input.env.APP_DB, userId)
			response = await run()
		} else {
			response = await withAccountWriteLease({
				db: input.env.APP_DB,
				stableUserId: userId,
				holder: `api:${input.operationId}`,
				env: input.env,
				write: run,
			})
		}
		outcome = 'success'
		return response
	} catch (error) {
		const apiError = toApiError(error)
		failureCode = apiError.code
		if (apiError.status >= 500 && !(error instanceof ApiError)) {
			console.error('open-api-operation-failed', input.operationId, error)
		}
		throw apiError
	} finally {
		input.waitUntil(
			recordUsage(
				input.env,
				{
					userId: personalOrgIdForPerson(input.ctx.callerContext.user),
					eventType: 'api_call',
					entityId: capabilityProxyObservationEntityId({
						baseEntityId: input.operationId,
						outcome,
						failureCode,
					}),
					durationMs: Date.now() - input.startedAt,
					outcome,
					...usageAttributionFieldsFromRequest(input.ctx.callerContext.request),
				},
				{ waitUntil: input.waitUntil },
			),
		)
	}
}

/**
 * Serve `api.kody.codes`: `GET /openapi.json` and the `/v1` operations.
 * Called by the `KodyApi` entrypoint after the edge worker has applied
 * rate limits, header stripping, and size caps.
 */
export async function handleOpenApiRequest(input: {
	request: Request
	env: Env
	appOrigin: string
	waitUntil: (promise: Promise<unknown>) => void
	loopbackExports?: Cloudflare.Exports
}): Promise<Response> {
	const url = new URL(input.request.url)
	try {
		if (url.pathname === openApiDocumentPath) {
			if (input.request.method !== 'GET' && input.request.method !== 'HEAD') {
				throw new ApiError({
					status: 405,
					code: 'method_not_allowed',
					message: 'Use GET.',
					headers: { Allow: 'GET, HEAD' },
				})
			}
			const { text, etag } = await openApiResponseBody(url.origin)
			const headers = { 'Cache-Control': 'public, max-age=300', ETag: etag }
			if (etagMatches(input.request.headers.get('If-None-Match'), etag)) {
				return new Response(null, { status: 304, headers })
			}
			return new Response(text, {
				headers: { ...headers, 'Content-Type': 'application/json' },
			})
		}
		if (url.pathname === '/' && input.request.method === 'GET') {
			return json({
				name: 'Kody API',
				version: kodyApiVersion,
				openapi: `${url.origin}${openApiDocumentPath}`,
			})
		}
		return await handleOperation({ ...input, url })
	} catch (error) {
		const apiError = toApiError(error)
		if (apiError.status >= 500 && !(error instanceof ApiError)) {
			console.error('open-api-request-failed', url.pathname, error)
		}
		return apiErrorResponse(apiError)
	}
}
