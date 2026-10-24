import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	credentialPlacementRefusedCode,
	readCredentialPlacementRefusalFromInvocationBody,
} from '#worker/credentials/placement-refusal.ts'
import {
	decryptWebhookUrlSecret,
	encryptWebhookUrlSecret,
	userWebhookUrlSecretContext,
} from '#mcp/secrets/crypto.ts'
import {
	authorize,
	authorizePackageWrite,
	checkPermission,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { getUniqueConstraintField } from '#worker/database-errors.ts'
import { listEnablementsForInstance } from '#worker/enablements/repo.ts'
import { resolvePublicUsername } from '#worker/identity/user-lookup.ts'
import {
	listPackageWebhooks,
	type PackageWebhookManifestEntry,
	webhookHmacVerification,
} from '#worker/package-registry/manifest.ts'
import { resolveSavedPackage } from '#worker/package-invocations/module-artifacts.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	dispatchWebhookUrlApply,
	type WebhookUrlApplyDestination,
	type WebhookUrlApplyResult,
} from './apply.ts'
import {
	generateWebhookUrlSecret,
	hashWebhookUrlSecret,
	webhookUrlSecretMatches,
} from './crypto.ts'
import { WebhookEndpointIdRaceError } from './errors.ts'
import {
	formatWebhookUrlHandle,
	parseWebhookUrlHandle,
	webhookUrlHostFromOrigin,
} from './handle.ts'
import { buildWebhookApprovalUrl } from './approval.ts'
import { buildWebhookEndpointUrl } from './public-url.ts'
import { attestedPackageStamp } from '#worker/credentials/package-stamp.ts'
import { resolveCredential } from '#worker/credentials/resolve-credential.ts'
import {
	getWebhookEndpointByIdForUser,
	getWebhookEndpointByKey,
	listWebhookEndpointsForUser,
	setWebhookEndpointHmacVerificationState,
	upsertWebhookEndpointSecret,
} from './repo.ts'
import { encryptWebhookVerificationSnapshot } from './hmac-rotation.ts'
import {
	defaultWebhookVerification,
	resolveHmacCiphertextForMint,
} from './signing-secret.ts'
import {
	isWebhookPreviousUrlLive,
	webhookIdempotencyKeyHeader,
	webhookMaxPayloadBytes,
	type WebhookEndpointRecord,
} from './types.ts'

import { utf8ByteLength } from '@kody-internal/shared/backup-restore-safety.ts'
import { readPreExecutionPackageInvocationInfrastructureCode } from '#worker/package-invocations/infrastructure-codes.ts'
import {
	dispatchWebhookInvocation,
	readWebhookInvocationResult,
	recordWebhookDelivery,
} from './delivery.ts'
import { collectSafeWebhookHeaders } from './headers.ts'
import {
	buildWebhookExportParams,
	resolveWebhookParamsModeFirstArg,
} from './params.ts'
import {
	buildFreshSyntheticWebhookIdempotencyKey,
	buildWebhookInputModeMismatchMessage,
	buildWebhookNotMintedMessage,
	stripUntrustedWebhookSyntheticFields,
} from './synthetic.ts'

export type ListedWebhook = {
	packageId: string
	packageKodyId: string
	packageName: string
	name: string
	exportName: string
	description: string | null
	responseMode: 'ack' | 'sync'
	inputMode: 'request' | 'params'
	rateLimitPerMinute: number
	verification: PackageWebhookManifestEntry['verification']
	replay: PackageWebhookManifestEntry['replay']
	challenge: PackageWebhookManifestEntry['challenge']
	minted: boolean
	/** Endpoint id when minted; null when this row is the unminted declaration. */
	endpointId: string | null
	/** User-set label when several URLs share this declared name. */
	instanceLabel: string | null
	handle: string | null
	urlHost: string | null
	/**
	 * True once a person has approved the webhook: it has a live enablement.
	 * Minting alone leaves this false, and deliveries answer 409 until then.
	 */
	approved: boolean
	/** Where to approve it; null when not minted or already approved. */
	approvalUrl: string | null
	/**
	 * False for mints that predate encrypted secret storage: the hash alone
	 * cannot rebuild the URL, so apply / reveal need a rotate first.
	 */
	urlRecoverable: boolean
	createdAt: string | null
	rotatedAt: string | null
	/** ISO timestamp while the previous URL still accepts deliveries. */
	previousUrlActiveUntil: string | null
}

export type MintedWebhookHandle = {
	packageId: string
	packageKodyId: string
	name: string
	endpointId: string
	instanceLabel: string | null
	handle: string
	urlHost: string
	createdAt: string
	rotatedAt: string
	previousUrlActiveUntil: string | null
	/**
	 * Where a person approves the webhook so it runs; null once it has a
	 * live enablement. Minting never turns a webhook on.
	 */
	approvalUrl: string | null
}

export type {
	WebhookUrlApplyDestination,
	WebhookUrlApplyHttpDestination,
	WebhookUrlApplyResult,
} from './apply.ts'

async function resolveOwnerUsername(input: {
	db: D1Database
	email?: string | null
	username?: string | null
}) {
	if (input.username?.trim()) return input.username.trim()
	const resolved = await resolvePublicUsername({
		db: input.db,
		email: input.email,
	})
	if (!resolved) {
		throw new Error(
			'A public username is required to mint webhook endpoint URLs.',
		)
	}
	return resolved
}

async function authorizeWebhookPackageWrite(input: {
	env: Env
	request: RequestContext
	savedPackage: SavedPackageRecord
}) {
	await authorizePackageWrite(
		{ env: input.env, request: input.request },
		{
			id: input.savedPackage.id,
			userId: input.savedPackage.userId,
			label: input.savedPackage.name,
		},
	)
}

async function resolveOwnedPackage(input: {
	db: D1Database
	userId: OwnerId
	packageId?: string
	kodyId?: string
}): Promise<SavedPackageRecord> {
	const packageIdOrKodyId = (input.packageId ?? input.kodyId ?? '').trim()
	if (!packageIdOrKodyId) {
		throw new McpCallerError('packageId or kodyId is required.')
	}
	const savedPackage = await resolveSavedPackage({
		db: input.db,
		userId: input.userId,
		packageIdOrKodyId,
	})
	if (!savedPackage) {
		throw new McpCallerError(
			`Saved package "${packageIdOrKodyId}" was not found for this user.`,
		)
	}
	return savedPackage
}

async function loadDeclaredWebhook(input: {
	env: Env
	baseUrl: string
	userId: OwnerId
	savedPackage: SavedPackageRecord
	webhookName: string
}): Promise<PackageWebhookManifestEntry> {
	const loaded = await loadPackageManifestBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
	})
	const declared = listPackageWebhooks(loaded.manifest).find(
		(webhook) => webhook.name === input.webhookName,
	)
	if (!declared) {
		throw new McpCallerError(
			`Package "${input.savedPackage.kodyId}" does not declare webhook "${input.webhookName}".`,
		)
	}
	return declared
}

/** Declared webhooks on the owner's packages that the caller may read. */
export async function listWebhooksForUser(input: {
	env: Env
	request: RequestContext
	baseUrl: string
	userId: OwnerId
	packageId?: string
	kodyId?: string
}): Promise<Array<ListedWebhook>> {
	const access = await computeEffectivePermissions({
		env: input.env,
		request: input.request,
	})
	const packages = (
		await listSavedPackagesByUserId(input.env.APP_DB, {
			userId: input.userId,
		})
	).filter(
		(entry) =>
			checkPermission(access, 'package:read', packageResource(entry)).allowed,
	)
	const packageFilter = (input.packageId ?? input.kodyId ?? '').trim()
	const filteredPackages = packageFilter
		? packages.filter(
				(entry) => entry.id === packageFilter || entry.kodyId === packageFilter,
			)
		: packages

	const mintedByPackageName = new Map<string, Array<WebhookEndpointRecord>>()
	for (const mint of await listWebhookEndpointsForUser({
		db: input.env.APP_DB,
		userId: input.userId,
	})) {
		const key = `${mint.packageId}:${mint.webhookName}`
		const rows = mintedByPackageName.get(key) ?? []
		rows.push(mint)
		mintedByPackageName.set(key, rows)
	}
	for (const rows of mintedByPackageName.values()) {
		rows.sort(
			(left, right) =>
				left.createdAt.localeCompare(right.createdAt) ||
				left.id.localeCompare(right.id),
		)
	}

	const manifests = await Promise.all(
		filteredPackages.map((savedPackage) =>
			loadPackageManifestBySourceId({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				sourceId: savedPackage.sourceId,
			}).catch((error) => {
				console.warn('Failed to load package manifest for webhooks', {
					packageId: savedPackage.id,
					sourceId: savedPackage.sourceId,
					error,
				})
				return null
			}),
		),
	)

	const allMints = [...mintedByPackageName.values()].flat()
	const approvedEndpointIds = new Set<string>()
	await Promise.all(
		allMints.map(async (mint) => {
			const enablements = await listEnablementsForInstance({
				db: input.env.APP_DB,
				orgId: mint.userId,
				triggerKind: 'webhook',
				instanceId: mint.id,
			})
			if (enablements.length > 0) approvedEndpointIds.add(mint.id)
		}),
	)

	const listed: Array<ListedWebhook> = []
	const urlHost = webhookUrlHostFromOrigin(input.baseUrl)
	for (const [index, savedPackage] of filteredPackages.entries()) {
		const loaded = manifests[index]
		if (!loaded) continue
		for (const webhook of listPackageWebhooks(loaded.manifest)) {
			const mints =
				mintedByPackageName.get(`${savedPackage.id}:${webhook.name}`) ?? []
			const base = {
				packageId: savedPackage.id,
				packageKodyId: savedPackage.kodyId,
				packageName: savedPackage.name,
				name: webhook.name,
				exportName: webhook.exportName,
				description: webhook.description,
				responseMode: webhook.responseMode,
				inputMode: webhook.inputMode,
				rateLimitPerMinute: webhook.rateLimitPerMinute,
				verification: webhook.verification,
				replay: webhook.replay,
				challenge: webhook.challenge,
			}
			if (mints.length === 0) {
				listed.push({
					...base,
					minted: false,
					endpointId: null,
					instanceLabel: null,
					handle: null,
					urlHost: null,
					approved: false,
					approvalUrl: null,
					urlRecoverable: false,
					createdAt: null,
					rotatedAt: null,
					previousUrlActiveUntil: null,
				})
				continue
			}
			for (const mint of mints) {
				const approved = approvedEndpointIds.has(mint.id)
				listed.push({
					...base,
					minted: true,
					endpointId: mint.id,
					instanceLabel: mint.instanceLabel,
					handle: formatWebhookUrlHandle(mint.id),
					urlHost,
					approved,
					approvalUrl: !approved
						? buildWebhookApprovalUrl({
								baseUrl: input.baseUrl,
								orgSlug: input.request.org.slug,
								packageKodyId: savedPackage.kodyId,
								webhookName: webhook.name,
								endpointId: mint.id,
							})
						: null,
					urlRecoverable: mint.urlSecretEncrypted != null,
					createdAt: mint.createdAt,
					rotatedAt: mint.rotatedAt,
					previousUrlActiveUntil: isWebhookPreviousUrlLive(mint)
						? mint.previousUrlSecretExpiresAt
						: null,
				})
			}
		}
	}

	return listed.sort(
		(left, right) =>
			left.packageKodyId.localeCompare(right.packageKodyId) ||
			left.name.localeCompare(right.name) ||
			(left.createdAt ?? '').localeCompare(right.createdAt ?? '') ||
			(left.endpointId ?? '').localeCompare(right.endpointId ?? ''),
	)
}

export async function mintWebhookUrlForUser(input: {
	env: Env
	request: RequestContext
	userId: OwnerId
	email?: string | null
	username?: string | null
	packageId?: string
	kodyId?: string
	webhookName: string
	requestUrl?: string | null
	/**
	 * Mint another URL under the same declared name. Requires a short
	 * `instanceLabel` so Settings and Triggers can tell the URLs apart.
	 */
	createInstance?: boolean
	instanceLabel?: string | null
	/**
	 * Remint / rotate a specific minted endpoint. Ignored when
	 * `createInstance` is true (always inserts a new row).
	 */
	endpointId?: string | null
}): Promise<MintedWebhookHandle> {
	const webhookName = input.webhookName.trim()
	if (!webhookName) throw new McpCallerError('webhookName is required.')
	const createInstance = input.createInstance === true
	const instanceLabel = input.instanceLabel?.trim() || null
	if (createInstance && !instanceLabel) {
		throw new McpCallerError(
			'instanceLabel is required when minting another URL under the same webhook name.',
		)
	}
	if (instanceLabel && instanceLabel.length > 64) {
		throw new McpCallerError('instanceLabel must be at most 64 characters.')
	}
	const baseUrl = getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const savedPackage = await resolveOwnedPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: input.packageId,
		kodyId: input.kodyId,
	})
	await authorizeWebhookPackageWrite({
		env: input.env,
		request: input.request,
		savedPackage,
	})
	const declared = await loadDeclaredWebhook({
		env: input.env,
		baseUrl,
		userId: input.userId,
		savedPackage,
		webhookName,
	})

	const verification =
		webhookHmacVerification(declared.verification) ?? defaultWebhookVerification

	const urlSecret = await generateWebhookUrlSecret()
	const urlSecretHash = await hashWebhookUrlSecret(urlSecret)
	const existing = createInstance
		? null
		: input.endpointId
			? await requireOwnedWebhookEndpoint({
					db: input.env.APP_DB,
					userId: input.userId,
					packageId: savedPackage.id,
					webhookName,
					endpointId: input.endpointId,
				})
			: await getWebhookEndpointByKey({
					db: input.env.APP_DB,
					userId: input.userId,
					packageId: savedPackage.id,
					webhookName,
				})
	let endpointId = existing?.id ?? crypto.randomUUID()
	let stored: WebhookEndpointRecord | null = null
	for (let attempt = 0; attempt < 2; attempt++) {
		const encrypted = await encryptWebhookUrlSecret(
			input.env,
			urlSecret,
			userWebhookUrlSecretContext(input.userId, endpointId),
		)
		const hmacSecretEncrypted = await resolveHmacCiphertextForMint({
			env: input.env,
			request: input.request,
			baseUrl,
			userId: input.userId,
			endpointId,
			packageId: savedPackage.id,
			verification,
			existingHmacEncrypted: existing?.hmacSecretEncrypted,
		})
		try {
			stored = await upsertWebhookEndpointSecret({
				db: input.env.APP_DB,
				id: endpointId,
				userId: input.userId,
				packageId: savedPackage.id,
				webhookName,
				urlSecretHash,
				urlSecretEncrypted: encrypted,
				...(hmacSecretEncrypted !== undefined ? { hmacSecretEncrypted } : {}),
				createInstance,
				instanceLabel,
			})
			break
		} catch (error) {
			if (attempt > 0) throw error
			if (error instanceof WebhookEndpointIdRaceError) {
				endpointId = error.existingId
				continue
			}
			if (!getUniqueConstraintField(error)) throw error
			if (createInstance) throw error
			const raced = await getWebhookEndpointByKey({
				db: input.env.APP_DB,
				userId: input.userId,
				packageId: savedPackage.id,
				webhookName,
			})
			if (!raced) throw error
			endpointId = raced.id
		}
	}
	if (!stored) {
		throw new Error('Unable to persist webhook URL secret.')
	}
	const declaredSecretName =
		('secretName' in verification
			? verification.secretName
			: undefined
		)?.trim() ?? ''
	if (declaredSecretName && !stored.hmacSecretName) {
		try {
			const resolved = await resolveCredential({
				env: input.env,
				orgId: input.userId,
				actor: input.request,
				packageStamp: attestedPackageStamp(savedPackage.id),
				baseUrl,
				credential: { use: 'webhook-secret', name: declaredSecretName },
			})
			if (resolved.found && resolved.value) {
				const snapshot = await encryptWebhookVerificationSnapshot({
					env: input.env,
					userId: input.userId,
					endpointId: stored.id,
					plaintext: resolved.value,
				})
				await setWebhookEndpointHmacVerificationState({
					db: input.env.APP_DB,
					userId: input.userId,
					endpointId: stored.id,
					hmacSecretName: declaredSecretName,
					hmacVerificationSecretEncrypted: snapshot,
				})
			}
		} catch (error) {
			console.warn('webhook-mint-verification-seed-failed', {
				endpointId: stored.id,
				secretName: declaredSecretName,
				error,
			})
		}
	}
	const enablements = await listEnablementsForInstance({
		db: input.env.APP_DB,
		orgId: savedPackage.userId,
		triggerKind: 'webhook',
		instanceId: stored.id,
	})

	return {
		approvalUrl:
			enablements.length > 0
				? null
				: buildWebhookApprovalUrl({
						baseUrl,
						orgSlug: input.request.org.slug,
						packageKodyId: savedPackage.kodyId,
						webhookName,
						endpointId: stored.id,
					}),
		packageId: savedPackage.id,
		packageKodyId: savedPackage.kodyId,
		name: webhookName,
		endpointId: stored.id,
		instanceLabel: stored.instanceLabel,
		handle: formatWebhookUrlHandle(stored.id),
		urlHost: webhookUrlHostFromOrigin(baseUrl),
		createdAt: stored.createdAt,
		rotatedAt: stored.rotatedAt,
		previousUrlActiveUntil: isWebhookPreviousUrlLive(stored)
			? stored.previousUrlSecretExpiresAt
			: null,
	}
}

/** Whether a URL secret already exists for this declared webhook. */
export async function isWebhookUrlMinted(input: {
	env: Env
	userId: OwnerId
	packageId?: string
	kodyId?: string
	webhookName: string
}) {
	const webhookName = input.webhookName.trim()
	if (!webhookName) throw new McpCallerError('webhookName is required.')
	const savedPackage = await resolveOwnedPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: input.packageId,
		kodyId: input.kodyId,
	})
	const existing = await getWebhookEndpointByKey({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: savedPackage.id,
		webhookName,
	})
	return existing !== null
}

export async function rotateWebhookUrlForUser(input: {
	env: Env
	request: RequestContext
	userId: OwnerId
	email?: string | null
	username?: string | null
	packageId?: string
	kodyId?: string
	webhookName: string
	requestUrl?: string | null
	/** Required when several URLs share the name; otherwise rotates the oldest. */
	endpointId?: string | null
}): Promise<MintedWebhookHandle> {
	const webhookName = input.webhookName.trim()
	if (!webhookName) throw new McpCallerError('webhookName is required.')
	const savedPackage = await resolveOwnedPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: input.packageId,
		kodyId: input.kodyId,
	})
	await authorizeWebhookPackageWrite({
		env: input.env,
		request: input.request,
		savedPackage,
	})
	const existing = input.endpointId
		? await requireOwnedWebhookEndpoint({
				db: input.env.APP_DB,
				userId: input.userId,
				packageId: savedPackage.id,
				webhookName,
				endpointId: input.endpointId,
			})
		: await getWebhookEndpointByKey({
				db: input.env.APP_DB,
				userId: input.userId,
				packageId: savedPackage.id,
				webhookName,
			})
	if (!existing) {
		throw new McpCallerError(
			'Webhook URL has not been minted. Call webhookUrlMint first.',
		)
	}
	return mintWebhookUrlForUser({
		...input,
		endpointId: existing.id,
	})
}

async function resolveMintedWebhookUrl(input: {
	env: Env
	userId: OwnerId
	email?: string | null
	username?: string | null
	handle: string
	requestUrl?: string | null
}) {
	const endpointId = parseWebhookUrlHandle(input.handle)
	if (!endpointId) {
		throw new McpCallerError('Invalid webhook URL handle.')
	}
	const endpoint = await getWebhookEndpointByIdForUser({
		db: input.env.APP_DB,
		userId: input.userId,
		endpointId,
	})
	if (!endpoint) {
		throw new McpCallerError('Webhook handle was not found for this user.')
	}
	if (!endpoint.urlSecretEncrypted) {
		throw new McpCallerError(
			'Webhook URL secret is not recoverable from this mint. Call webhookUrlRotate, then webhookUrlApply.',
		)
	}
	const urlSecret = await decryptWebhookUrlSecret(
		input.env,
		endpoint.urlSecretEncrypted,
		userWebhookUrlSecretContext(input.userId, endpoint.id),
	)
	const matches = await webhookUrlSecretMatches({
		candidate: urlSecret,
		storedHash: endpoint.urlSecretHash,
	})
	if (!matches) {
		throw new McpCallerError(
			'Webhook URL secret is inconsistent. Call webhookUrlRotate, then webhookUrlApply.',
		)
	}
	const savedPackage = await resolveOwnedPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: endpoint.packageId,
	})
	const baseUrl = getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const username = await resolveOwnerUsername({
		db: input.env.APP_DB,
		email: input.email,
		username: input.username,
	})
	const url = buildWebhookEndpointUrl({
		origin: baseUrl,
		username,
		packageKodyId: savedPackage.kodyId,
		webhookName: endpoint.webhookName,
		urlSecret,
	})
	return {
		endpoint,
		savedPackage,
		urlSecret,
		url,
		urlHost: webhookUrlHostFromOrigin(baseUrl),
		baseUrl,
	}
}

export async function applyWebhookUrlForUser(input: {
	env: Env
	request: RequestContext
	userId: OwnerId
	email?: string | null
	username?: string | null
	handle: string
	destination: WebhookUrlApplyDestination
	requestUrl?: string | null
	waitUntil?: (promise: Promise<unknown>) => void
	/** Credential id pinned by destination Allow; rejects mid-flight name swaps. */
	expectedAuthCredentialId?: string | null
}): Promise<WebhookUrlApplyResult> {
	const resolved = await resolveMintedWebhookUrl(input)
	await authorizeWebhookPackageWrite({
		env: input.env,
		request: input.request,
		savedPackage: resolved.savedPackage,
	})
	return dispatchWebhookUrlApply({
		env: input.env,
		request: input.request,
		userId: input.userId,
		userEmail: input.email,
		baseUrl: resolved.baseUrl,
		packageId: resolved.savedPackage.id,
		packageKodyId: resolved.savedPackage.kodyId,
		webhookName: resolved.endpoint.webhookName,
		savedPackage: resolved.savedPackage,
		endpoint: resolved.endpoint,
		webhookUrl: resolved.url,
		urlSecret: resolved.urlSecret,
		urlHost: resolved.urlHost,
		destination: input.destination,
		waitUntil: input.waitUntil,
		expectedAuthCredentialId: input.expectedAuthCredentialId,
	})
}

type WebhookUrlRevealTarget =
	| { handle: string }
	| {
			packageId?: string
			kodyId?: string
			webhookName: string
			endpointId?: string | null
	  }

async function requireOwnedWebhookEndpoint(input: {
	db: D1Database
	userId: OwnerId
	packageId: string
	webhookName: string
	endpointId: string
}): Promise<WebhookEndpointRecord> {
	const existing = await getWebhookEndpointByIdForUser({
		db: input.db,
		userId: input.userId,
		endpointId: input.endpointId,
	})
	if (
		!existing ||
		existing.packageId !== input.packageId ||
		existing.webhookName !== input.webhookName
	) {
		throw new McpCallerError(
			'Webhook URL has not been minted. Call webhookUrlMint first.',
		)
	}
	return existing
}

async function resolveRevealHandle(input: {
	db: D1Database
	userId: OwnerId
	target: WebhookUrlRevealTarget
}) {
	if ('handle' in input.target) return input.target.handle
	const webhookName = input.target.webhookName.trim()
	if (!webhookName) throw new McpCallerError('webhookName is required.')
	const savedPackage = await resolveOwnedPackage({
		db: input.db,
		userId: input.userId,
		packageId: input.target.packageId,
		kodyId: input.target.kodyId,
	})
	const existing = input.target.endpointId
		? await requireOwnedWebhookEndpoint({
				db: input.db,
				userId: input.userId,
				packageId: savedPackage.id,
				webhookName,
				endpointId: input.target.endpointId,
			})
		: await getWebhookEndpointByKey({
				db: input.db,
				userId: input.userId,
				packageId: savedPackage.id,
				webhookName,
			})
	if (!existing) {
		throw new McpCallerError('Webhook URL has not been minted yet.')
	}
	return formatWebhookUrlHandle(existing.id)
}

/**
 * Owner-only reveal for the signed-in package settings UI (the Webhooks
 * section of `/@:username/:kodyId/settings`). The credential URL is the human
 * path: do not expose this through MCP or execute, and do not return it from
 * mint / rotate / list capabilities.
 */
export async function revealWebhookUrlForWebsite(input: {
	env: Env
	userId: OwnerId
	email?: string | null
	username?: string | null
	target: WebhookUrlRevealTarget
	requestUrl?: string | null
}) {
	const handle = await resolveRevealHandle({
		db: input.env.APP_DB,
		userId: input.userId,
		target: input.target,
	})
	const resolved = await resolveMintedWebhookUrl({ ...input, handle })
	return {
		endpointId: resolved.endpoint.id,
		handle: formatWebhookUrlHandle(resolved.endpoint.id),
		urlHost: resolved.urlHost,
		url: resolved.url,
	}
}

export type SyntheticWebhookRequestFixture = {
	method?: string
	headers?: Record<string, string>
	body?: string
	json?: unknown
	contentType?: string
}

export type SyntheticWebhookDispatchResult = {
	packageId: string
	packageKodyId: string
	webhookName: string
	inputMode: 'request' | 'params'
	synthetic: true
	status: number
	runId: string
	idempotencyKey: string
	result?: unknown
	error?: { code: string; message: string }
}

/**
 * Interactive-MCP synthetic smoke test for one minted package webhook.
 * Skips public URL + HMAC, invokes the bound export with a caller fixture,
 * marks the Activity webhook run `synthetic: true`, and burns automation
 * usage through the normal `internal:webhook:` invocation token.
 */
export async function dispatchSyntheticWebhookForUser(input: {
	env: Env
	requestContext: RequestContext
	userId: OwnerId
	baseUrl: string
	packageId?: string
	kodyId?: string
	webhookName: string
	request?: SyntheticWebhookRequestFixture
	params?: Record<string, unknown>
}): Promise<SyntheticWebhookDispatchResult> {
	const webhookName = input.webhookName.trim()
	if (!webhookName) throw new McpCallerError('webhookName is required.')

	const hasRequest = input.request !== undefined
	const hasParams = input.params !== undefined
	if (hasRequest === hasParams) {
		throw new McpCallerError(
			'Provide exactly one of `request` (inputMode request) or `params` (inputMode params).',
		)
	}

	const savedPackage = await resolveOwnedPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: input.packageId,
		kodyId: input.kodyId,
	})
	await authorize(
		{ env: input.env, request: input.requestContext },
		'package:execute',
		packageResource(savedPackage),
	)
	const declared = await loadDeclaredWebhook({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		savedPackage,
		webhookName,
	})
	const endpoint = await getWebhookEndpointByKey({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: savedPackage.id,
		webhookName,
	})
	if (!endpoint) {
		throw new McpCallerError(
			buildWebhookNotMintedMessage({
				kodyId: savedPackage.kodyId,
				webhookName,
			}),
		)
	}

	const providedMode: 'request' | 'params' = hasParams ? 'params' : 'request'
	if (declared.inputMode !== providedMode) {
		throw new McpCallerError(
			buildWebhookInputModeMismatchMessage({
				webhookName,
				inputMode: declared.inputMode,
				provided: providedMode,
			}),
		)
	}

	const startedAt = new Date().toISOString()
	const invocationId = crypto.randomUUID()
	const idempotencyKey = buildFreshSyntheticWebhookIdempotencyKey()

	let exportParams: Record<string, unknown>
	let payloadBytes: number

	if (declared.inputMode === 'params') {
		const resolved = resolveWebhookParamsModeFirstArg(input.params)
		if (!resolved.ok) {
			throw new McpCallerError(
				'params fixture must be a JSON object for inputMode "params".',
			)
		}
		exportParams = {
			...stripUntrustedWebhookSyntheticFields(resolved.params),
			synthetic: true,
		}
		payloadBytes = utf8ByteLength(JSON.stringify(exportParams) ?? '{}')
	} else {
		const fixture = input.request ?? {}
		const headers = new Headers()
		try {
			for (const [name, value] of Object.entries(fixture.headers ?? {})) {
				if (typeof value === 'string') headers.set(name, value)
			}
			if (fixture.contentType) {
				headers.set('content-type', fixture.contentType)
			}
		} catch (error) {
			throw new McpCallerError(
				`Invalid request fixture header: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		let bodyText: string
		if (typeof fixture.body === 'string') {
			bodyText = fixture.body
		} else if (fixture.json !== undefined) {
			bodyText = JSON.stringify(fixture.json)
			if (!headers.has('content-type')) {
				headers.set('content-type', 'application/json')
			}
		} else {
			bodyText = ''
		}
		payloadBytes = utf8ByteLength(bodyText)
		if (payloadBytes > webhookMaxPayloadBytes) {
			throw new McpCallerError(
				`Fixture exceeds the ${String(webhookMaxPayloadBytes)}-byte webhook payload limit (${String(payloadBytes)} bytes).`,
			)
		}
		const method = (fixture.method ?? 'POST').toUpperCase()
		let request: Request
		try {
			request = new Request('https://kody.synthetic/webhook', {
				method,
				headers,
				body: method === 'GET' || method === 'HEAD' ? undefined : bodyText,
			})
		} catch (error) {
			throw new McpCallerError(
				`Invalid request fixture method: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		const hmacVerification = webhookHmacVerification(declared.verification)
		const extraAllowedHeaders = [
			...(hmacVerification ? [hmacVerification.header] : []),
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
			webhookName,
			request,
			bodyText,
			receivedAt: startedAt,
			headers: safeHeaders,
		})
		exportParams = {
			...requestParams,
			synthetic: true,
		}
	}

	if (payloadBytes > webhookMaxPayloadBytes) {
		throw new McpCallerError(
			`Fixture exceeds the ${String(webhookMaxPayloadBytes)}-byte webhook payload limit (${String(payloadBytes)} bytes).`,
		)
	}

	const finish = async (inputFinish: {
		status: number
		outcome: 'delivered' | 'failed'
		error?: string | null
		result?: unknown
		errorBody?: { code: string; message: string }
		request?: Awaited<ReturnType<typeof dispatchWebhookInvocation>>['request']
	}): Promise<SyntheticWebhookDispatchResult> => {
		const record = await recordWebhookDelivery({
			...(inputFinish.errorBody
				? { invocationBody: { error: inputFinish.errorBody } }
				: {}),
			env: input.env,
			endpoint,
			kodyId: savedPackage.kodyId,
			outcome: inputFinish.outcome,
			httpStatus:
				inputFinish.outcome === 'delivered' ? inputFinish.status : 502,
			error: inputFinish.error ?? null,
			payloadBytes,
			invocationId,
			result: inputFinish.result,
			startedAt,
			requirePersistence: true,
			synthetic: true,
			request: inputFinish.request,
		})
		if (!record) {
			throw new Error('Webhook synthetic delivery record was not persisted.')
		}
		return {
			packageId: savedPackage.id,
			packageKodyId: savedPackage.kodyId,
			webhookName,
			inputMode: declared.inputMode,
			synthetic: true,
			status: inputFinish.status,
			runId: record.id,
			idempotencyKey,
			...(inputFinish.outcome === 'delivered'
				? { result: inputFinish.result }
				: {
						error: inputFinish.errorBody ?? {
							code: 'invocation_failed',
							message:
								inputFinish.error ??
								`Webhook export invocation failed with HTTP ${inputFinish.status}.`,
						},
					}),
		}
	}

	let response: Awaited<ReturnType<typeof dispatchWebhookInvocation>>
	try {
		response = await dispatchWebhookInvocation({
			env: input.env,
			baseUrl: input.baseUrl,
			endpoint,
			packageKodyId: savedPackage.kodyId,
			exportName: declared.exportName,
			params: exportParams,
			idempotencyKey,
		})
		const retryableCode =
			readPreExecutionPackageInvocationInfrastructureCode(response)
		if (retryableCode) {
			throw new Error(
				`Retryable package invocation infrastructure response: ${retryableCode}.`,
			)
		}
	} catch (error) {
		if (error instanceof McpCallerError) throw error
		const message = error instanceof Error ? error.message : 'invocation_failed'
		return await finish({
			status: 502,
			outcome: 'failed',
			error: message,
			errorBody: {
				code: 'invocation_failed',
				message,
			},
		})
	}

	const ok = response.status >= 200 && response.status < 300
	const result = readWebhookInvocationResult(response.body)
	if (ok) {
		return await finish({
			status: response.status,
			outcome: 'delivered',
			result,
			request: response.request,
		})
	}
	const errorRecord =
		response.body && typeof response.body === 'object'
			? ((response.body as Record<string, unknown>)['error'] as
					| Record<string, unknown>
					| undefined)
			: undefined
	const placementRefused = Boolean(
		readCredentialPlacementRefusalFromInvocationBody(response.body),
	)
	return await finish({
		status: response.status,
		outcome: 'failed',
		error: placementRefused
			? credentialPlacementRefusedCode
			: `invocation_status_${response.status}`,
		request: response.request,
		result,
		errorBody: {
			code: placementRefused
				? credentialPlacementRefusedCode
				: String(errorRecord?.['code'] ?? 'invocation_failed'),
			message: String(
				errorRecord?.['message'] ??
					`Webhook export invocation failed with HTTP ${response.status}.`,
			),
		},
	})
}
