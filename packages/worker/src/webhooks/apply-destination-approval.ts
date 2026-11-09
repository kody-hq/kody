import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getJoinedIntegration } from '#worker/integrations/service.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	countWebhookSecretPlaceholdersInFormBody,
	countWebhookUrlPlaceholdersInFormBody,
	isFormUrlEncodedContentType,
	webhookUrlApplyHttpMethods,
	webhookUrlApplyPlaceholder,
	webhookUrlApplySecretPlaceholder,
	type WebhookUrlApplyHttpDestination,
} from './apply.ts'
import { formatWebhookUrlHandle, parseWebhookUrlHandle } from './handle.ts'
import { getWebhookEndpointByIdForUser } from './repo.ts'

const connectWebhookApplyPath = '/connect/webhook-apply'

export type HttpApplyDestinationSnapshot = {
	method: (typeof webhookUrlApplyHttpMethods)[number]
	url: string
	headers: Array<{ name: string; value: string }>
	body: string
	secretName: string | null
	integration: string | null
	/** Stable credential id for secretName / integration auth; null when none. */
	credentialId: string | null
	injectionSites: Array<string>
	auth: string
}

export type WebhookApplyDestinationApprovalView = {
	handle: string
	fingerprint: string
	packageId: string
	packageKodyId: string
	packageName: string
	webhookName: string
	destination: HttpApplyDestinationSnapshot
	alreadyGranted: boolean
}

type PendingOrGrantRow = {
	user_id: string
	webhook_endpoint_id: string
	destination_fingerprint: string
	destination_json: string
	package_id: string
	webhook_name: string
	credential_id?: string | null
	created_at?: string
	updated_at?: string
	approved_at?: string
}

function normalizeHttpMethod(
	method: WebhookUrlApplyHttpDestination['method'] | undefined,
): (typeof webhookUrlApplyHttpMethods)[number] {
	const normalized = (method ?? 'POST').toUpperCase()
	if (
		(webhookUrlApplyHttpMethods as ReadonlyArray<string>).includes(normalized)
	) {
		return normalized as (typeof webhookUrlApplyHttpMethods)[number]
	}
	return 'POST'
}

function listInjectionSites(destination: {
	url: string
	headers: Record<string, string>
	body: string
}) {
	const sites: Array<string> = []
	const fragmentIndex = destination.url.indexOf('#')
	const urlWithoutFragment =
		fragmentIndex === -1
			? destination.url
			: destination.url.slice(0, fragmentIndex)
	if (urlWithoutFragment.includes(webhookUrlApplyPlaceholder)) sites.push('url')
	if (urlWithoutFragment.includes(webhookUrlApplySecretPlaceholder)) {
		sites.push(`url:${webhookUrlApplySecretPlaceholder}`)
	}
	for (const [name, value] of Object.entries(destination.headers)) {
		if (value.includes(webhookUrlApplyPlaceholder)) {
			sites.push(`header:${name}`)
		}
		if (value.includes(webhookUrlApplySecretPlaceholder)) {
			sites.push(`header:${name}:${webhookUrlApplySecretPlaceholder}`)
		}
	}
	const contentType =
		Object.entries(destination.headers).find(
			([name]) => name.toLowerCase() === 'content-type',
		)?.[1] ?? null
	const bodyHasUrlLiteral = destination.body.includes(
		webhookUrlApplyPlaceholder,
	)
	const bodyHasUrlFormEncoded =
		isFormUrlEncodedContentType(contentType) &&
		countWebhookUrlPlaceholdersInFormBody(destination.body) >= 1
	if (bodyHasUrlLiteral || bodyHasUrlFormEncoded) sites.push('body')
	const bodyHasSecretLiteral = destination.body.includes(
		webhookUrlApplySecretPlaceholder,
	)
	const bodyHasSecretFormEncoded =
		isFormUrlEncodedContentType(contentType) &&
		countWebhookSecretPlaceholdersInFormBody(destination.body) >= 1
	if (bodyHasSecretLiteral || bodyHasSecretFormEncoded) {
		sites.push(`body:${webhookUrlApplySecretPlaceholder}`)
	}
	return sites
}

function describeAuth(destination: {
	secretName: string | null
	integration: string | null
	credentialId: string | null
	headers: Record<string, string>
}) {
	if (destination.secretName) {
		const idSuffix = destination.credentialId
			? ` (credential ${destination.credentialId})`
			: ''
		return `secretName=${destination.secretName}${idSuffix}`
	}
	if (destination.integration) {
		const idSuffix = destination.credentialId
			? ` (credential ${destination.credentialId})`
			: ''
		return `integration=${destination.integration}${idSuffix}`
	}
	const authorizationHeader = Object.entries(destination.headers).find(
		([name]) => name.toLowerCase() === 'authorization',
	)
	if (authorizationHeader) {
		return `header:${authorizationHeader[0]} (caller-supplied)`
	}
	return 'none'
}

export function toHttpApplyDestinationSnapshot(
	destination: WebhookUrlApplyHttpDestination,
	options?: { credentialId?: string | null },
): HttpApplyDestinationSnapshot {
	const method = normalizeHttpMethod(destination.method)
	const url = destination.url.trim()
	const headersRecord = destination.headers ?? {}
	const body = destination.body ?? ''
	const secretName = destination.secretName?.trim() || null
	const integration = destination.integration?.trim() || null
	const credentialId = options?.credentialId?.trim() || null
	const headers = Object.entries(headersRecord)
		.map(([name, value]) => ({ name, value }))
		.sort((left, right) => {
			const byLower = left.name
				.toLowerCase()
				.localeCompare(right.name.toLowerCase())
			if (byLower !== 0) return byLower
			return left.name.localeCompare(right.name)
		})
	return {
		method,
		url,
		headers,
		body,
		secretName,
		integration,
		credentialId,
		injectionSites: listInjectionSites({
			url,
			headers: headersRecord,
			body,
		}),
		auth: describeAuth({
			secretName,
			integration,
			credentialId,
			headers: headersRecord,
		}),
	}
}

/** Current consent pin: destination shape + stable credential id (not name). */
export async function fingerprintHttpApplyDestination(
	destination: WebhookUrlApplyHttpDestination,
	options?: { credentialId?: string | null },
) {
	const snapshot = toHttpApplyDestinationSnapshot(destination, options)
	return fingerprintDestinationSnapshot(snapshot)
}

export async function fingerprintDestinationSnapshot(
	snapshot: HttpApplyDestinationSnapshot,
) {
	const material = JSON.stringify({
		method: snapshot.method,
		url: snapshot.url,
		headers: snapshot.headers,
		body: snapshot.body,
		credentialId: snapshot.credentialId,
	})
	return sha256Hex(material)
}

/** Pre-credential-id pin that keyed auth by secretName / integration string. */
export async function fingerprintHttpApplyDestinationLegacy(
	destination: WebhookUrlApplyHttpDestination,
) {
	const snapshot = toHttpApplyDestinationSnapshot(destination)
	const material = JSON.stringify({
		method: snapshot.method,
		url: snapshot.url,
		headers: snapshot.headers,
		body: snapshot.body,
		secretName: snapshot.secretName,
		integration: snapshot.integration,
	})
	return sha256Hex(material)
}

/**
 * Pending and granted rows are keyed by the owning org, so the link names
 * that org. The website re-verifies the session's membership before reading.
 */
export function buildWebhookApplyDestinationApprovalUrl(input: {
	baseUrl: string
	handle: string
	fingerprint: string
	orgSlug?: string | null
}) {
	const url = new URL(connectWebhookApplyPath, input.baseUrl)
	url.searchParams.set('handle', input.handle)
	url.searchParams.set('fingerprint', input.fingerprint)
	const orgSlug = input.orgSlug?.trim()
	if (orgSlug) url.searchParams.set('org', orgSlug)
	return url.toString()
}

export function buildWebhookApplyDestinationApprovalRequiredMessage(input: {
	approvalUrl: string
	destination: HttpApplyDestinationSnapshot
}) {
	const headerLines = input.destination.headers.map(
		(header) => `${header.name}=${header.value}`,
	)
	const credentialNote = input.destination.credentialId
		? [
				'',
				`This approval is pinned to credential ${input.destination.credentialId}. Rotating that credential's value keeps the approval; replacing it under the same name requires a fresh Allow.`,
			]
		: []
	return [
		'HTTP webhookUrlApply requires owner approval for this outbound registration (prompt-injection / confused-deputy protection). This uses the same account approval flow as secret host approval (/connect/secrets), secret package grants, and locked-package publish approval: send the owner the approval_url, wait for them to Allow on the website, then retry. Agents cannot grant access.',
		'',
		`approval_url: ${input.approvalUrl}`,
		`method: ${input.destination.method}`,
		`url: ${input.destination.url}`,
		`${webhookUrlApplyPlaceholder}/${webhookUrlApplySecretPlaceholder} injection sites: ${input.destination.injectionSites.join(', ') || '(none)'}`,
		`headers: ${headerLines.length > 0 ? headerLines.join('; ') : '(none)'}`,
		`body: ${input.destination.body.length > 0 ? input.destination.body : '(none)'}`,
		`auth: ${input.destination.auth}`,
		...credentialNote,
	].join('\n')
}

async function lookupLiveSecretCredentialId(input: {
	db: D1Database
	userId: string
	packageId: string
	secretName: string
}): Promise<string | null> {
	// Match webhook-secret apply: package bucket first, then user; kind=secret;
	// live and unexpired only (same filters as findSecretForUse).
	const now = new Date().toISOString()
	const packageRow = await input.db
		.prepare(
			`SELECT e.id AS id
			FROM secret_entries e
			JOIN secret_buckets b ON b.id = e.bucket_id
			WHERE b.user_id = ? AND b.scope = 'package' AND b.binding_key = ?
				AND e.name = ? AND e.kind = 'secret'
				AND e.deleted_at IS NULL AND b.deleted_at IS NULL
				AND (e.expires_at IS NULL OR e.expires_at > ?)
				AND (b.expires_at IS NULL OR b.expires_at > ?)
			LIMIT 1`,
		)
		.bind(input.userId, input.packageId, input.secretName, now, now)
		.first<{ id: string }>()
	if (packageRow?.id) return packageRow.id
	const userRow = await input.db
		.prepare(
			`SELECT e.id AS id
			FROM secret_entries e
			JOIN secret_buckets b ON b.id = e.bucket_id
			WHERE b.user_id = ? AND b.scope = 'user' AND b.binding_key = ''
				AND e.name = ? AND e.kind = 'secret'
				AND e.deleted_at IS NULL AND b.deleted_at IS NULL
				AND (e.expires_at IS NULL OR e.expires_at > ?)
				AND (b.expires_at IS NULL OR b.expires_at > ?)
			LIMIT 1`,
		)
		.bind(input.userId, input.secretName, now, now)
		.first<{ id: string }>()
	return userRow?.id ?? null
}

async function resolveDestinationCredentialId(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
	packageId: string
	destination: WebhookUrlApplyHttpDestination
}): Promise<string | null> {
	const secretName = input.destination.secretName?.trim() || ''
	const integrationName = input.destination.integration?.trim() || ''
	if (secretName && integrationName) {
		throw new Error('Provide either integration or secretName, not both.')
	}
	if (secretName) {
		const credentialId = await lookupLiveSecretCredentialId({
			db: input.env.APP_DB,
			userId: input.userId,
			packageId: input.packageId,
			secretName,
		})
		if (!credentialId) {
			throw new Error(
				`Secret "${secretName}" was not found. Save a live secret (not expired, kind secret), then retry webhookUrlApply so the owner can approve this destination for that credential.`,
			)
		}
		return credentialId
	}
	if (integrationName) {
		// Same canonical name path as getJoinedIntegration / apply.
		const joined = await getJoinedIntegration({
			env: input.env,
			userId: input.userId,
			name: integrationName,
		})
		const credentialId = joined?.connection.credentialId?.trim() || null
		if (!credentialId) {
			throw new Error(
				`Integration "${integrationName}" was not found. Connect it, then retry webhookUrlApply so the owner can approve this destination for that credential.`,
			)
		}
		return credentialId
	}
	return null
}

function rowCredentialId(row: PendingOrGrantRow): string | null {
	if (typeof row.credential_id === 'string' && row.credential_id.trim()) {
		return row.credential_id.trim()
	}
	try {
		const parsed = JSON.parse(row.destination_json) as {
			credentialId?: unknown
		}
		if (typeof parsed.credentialId === 'string' && parsed.credentialId.trim()) {
			return parsed.credentialId.trim()
		}
	} catch {
		// Invalid JSON is handled by parseDestinationJson callers.
	}
	return null
}

async function readGrantRow(input: {
	db: D1Database
	userId: string
	endpointId: string
	fingerprint: string
}) {
	return input.db
		.prepare(
			`SELECT *
			FROM webhook_apply_destination_grants
			WHERE user_id = ? AND webhook_endpoint_id = ? AND destination_fingerprint = ?
			LIMIT 1`,
		)
		.bind(input.userId, input.endpointId, input.fingerprint)
		.first<PendingOrGrantRow>()
}

async function readPendingRow(input: {
	db: D1Database
	userId: string
	endpointId: string
	fingerprint: string
}) {
	return input.db
		.prepare(
			`SELECT *
			FROM webhook_apply_destination_pending
			WHERE user_id = ? AND webhook_endpoint_id = ? AND destination_fingerprint = ?
			LIMIT 1`,
		)
		.bind(input.userId, input.endpointId, input.fingerprint)
		.first<PendingOrGrantRow>()
}

function legacyRowMatchesCredential(
	row: PendingOrGrantRow,
	resolvedCredentialId: string | null,
) {
	const pinned = rowCredentialId(row)
	if (resolvedCredentialId == null) {
		// No auth credential on the destination: legacy rows without a pin match.
		return pinned == null
	}
	// A pin must equal today's resolved id. Unpinned legacy rows are upgraded
	// only when migration has not yet attached an id (should be rare after 0123).
	if (pinned == null) return true
	return pinned === resolvedCredentialId
}

async function upgradeGrantFingerprint(input: {
	db: D1Database
	userId: string
	endpointId: string
	legacyFingerprint: string
	newFingerprint: string
	destination: HttpApplyDestinationSnapshot
	row: PendingOrGrantRow
}) {
	const destinationJson = JSON.stringify(input.destination)
	const credentialId = input.destination.credentialId
	await input.db.batch([
		input.db
			.prepare(
				`INSERT INTO webhook_apply_destination_grants (
					user_id,
					webhook_endpoint_id,
					destination_fingerprint,
					destination_json,
					package_id,
					webhook_name,
					credential_id,
					approved_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(user_id, webhook_endpoint_id, destination_fingerprint) DO UPDATE SET
					destination_json = excluded.destination_json,
					package_id = excluded.package_id,
					webhook_name = excluded.webhook_name,
					credential_id = excluded.credential_id,
					approved_at = excluded.approved_at`,
			)
			.bind(
				input.userId,
				input.endpointId,
				input.newFingerprint,
				destinationJson,
				input.row.package_id,
				input.row.webhook_name,
				credentialId,
				input.row.approved_at ?? new Date().toISOString(),
			),
		input.db
			.prepare(
				`DELETE FROM webhook_apply_destination_grants
				WHERE user_id = ? AND webhook_endpoint_id = ? AND destination_fingerprint = ?`,
			)
			.bind(input.userId, input.endpointId, input.legacyFingerprint),
	])
}

async function findGrantFingerprint(input: {
	db: D1Database
	userId: string
	endpointId: string
	destination: WebhookUrlApplyHttpDestination
	snapshot: HttpApplyDestinationSnapshot
}): Promise<string | null> {
	const fingerprint = await fingerprintDestinationSnapshot(input.snapshot)
	const current = await readGrantRow({
		db: input.db,
		userId: input.userId,
		endpointId: input.endpointId,
		fingerprint,
	})
	if (current) return fingerprint

	const legacyFingerprint = await fingerprintHttpApplyDestinationLegacy(
		input.destination,
	)
	if (legacyFingerprint === fingerprint) return null
	const legacy = await readGrantRow({
		db: input.db,
		userId: input.userId,
		endpointId: input.endpointId,
		fingerprint: legacyFingerprint,
	})
	if (!legacy) return null
	if (!legacyRowMatchesCredential(legacy, input.snapshot.credentialId)) {
		return null
	}
	await upgradeGrantFingerprint({
		db: input.db,
		userId: input.userId,
		endpointId: input.endpointId,
		legacyFingerprint,
		newFingerprint: fingerprint,
		destination: input.snapshot,
		row: legacy,
	})
	return fingerprint
}

export async function hasWebhookApplyDestinationGrant(input: {
	db: D1Database
	userId: string
	endpointId: string
	fingerprint: string
}) {
	const row = await readGrantRow(input)
	return row != null
}

export async function upsertWebhookApplyDestinationPending(input: {
	db: D1Database
	userId: string
	endpointId: string
	fingerprint: string
	destination: HttpApplyDestinationSnapshot
	packageId: string
	webhookName: string
	now?: string
}) {
	const now = input.now ?? new Date().toISOString()
	const destinationJson = JSON.stringify(input.destination)
	await input.db
		.prepare(
			`INSERT INTO webhook_apply_destination_pending (
				user_id,
				webhook_endpoint_id,
				destination_fingerprint,
				destination_json,
				package_id,
				webhook_name,
				credential_id,
				created_at,
				updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id, webhook_endpoint_id, destination_fingerprint) DO UPDATE SET
				destination_json = excluded.destination_json,
				package_id = excluded.package_id,
				webhook_name = excluded.webhook_name,
				credential_id = excluded.credential_id,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.userId,
			input.endpointId,
			input.fingerprint,
			destinationJson,
			input.packageId,
			input.webhookName,
			input.destination.credentialId,
			now,
			now,
		)
		.run()
}

export async function approveWebhookApplyDestination(input: {
	db: D1Database
	userId: string
	endpointId: string
	fingerprint: string
	now?: string
}) {
	const pending = await readPendingRow(input)
	if (!pending) {
		const existing = await readGrantRow(input)
		if (existing) return { status: 'already_granted' as const }
		throw new Error(
			'No pending webhook apply destination matches this approval link.',
		)
	}
	const now = input.now ?? new Date().toISOString()
	const credentialId = rowCredentialId(pending)
	await input.db.batch([
		input.db
			.prepare(
				`INSERT INTO webhook_apply_destination_grants (
					user_id,
					webhook_endpoint_id,
					destination_fingerprint,
					destination_json,
					package_id,
					webhook_name,
					credential_id,
					approved_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(user_id, webhook_endpoint_id, destination_fingerprint) DO UPDATE SET
					destination_json = excluded.destination_json,
					package_id = excluded.package_id,
					webhook_name = excluded.webhook_name,
					credential_id = excluded.credential_id,
					approved_at = excluded.approved_at`,
			)
			.bind(
				input.userId,
				input.endpointId,
				input.fingerprint,
				pending.destination_json,
				pending.package_id,
				pending.webhook_name,
				credentialId,
				now,
			),
		input.db
			.prepare(
				`DELETE FROM webhook_apply_destination_pending
				WHERE user_id = ? AND webhook_endpoint_id = ? AND destination_fingerprint = ?`,
			)
			.bind(input.userId, input.endpointId, input.fingerprint),
	])
	return { status: 'approved' as const }
}

export async function rejectWebhookApplyDestination(input: {
	db: D1Database
	userId: string
	endpointId: string
	fingerprint: string
}) {
	await input.db
		.prepare(
			`DELETE FROM webhook_apply_destination_pending
			WHERE user_id = ? AND webhook_endpoint_id = ? AND destination_fingerprint = ?`,
		)
		.bind(input.userId, input.endpointId, input.fingerprint)
		.run()
	return { status: 'rejected' as const }
}

function parseDestinationJson(raw: string): HttpApplyDestinationSnapshot {
	const parsed = JSON.parse(raw) as Partial<HttpApplyDestinationSnapshot>
	if (
		typeof parsed !== 'object' ||
		parsed == null ||
		typeof parsed.method !== 'string' ||
		typeof parsed.url !== 'string'
	) {
		throw new Error('Stored webhook apply destination is invalid.')
	}
	const secretName =
		typeof parsed.secretName === 'string' ? parsed.secretName : null
	const integration =
		typeof parsed.integration === 'string' ? parsed.integration : null
	const credentialId =
		typeof parsed.credentialId === 'string' ? parsed.credentialId : null
	const headers = Array.isArray(parsed.headers) ? parsed.headers : []
	const headersRecord = Object.fromEntries(
		headers.map((header) => [header.name, header.value]),
	)
	return {
		method: parsed.method as HttpApplyDestinationSnapshot['method'],
		url: parsed.url,
		headers,
		body: typeof parsed.body === 'string' ? parsed.body : '',
		secretName,
		integration,
		credentialId,
		injectionSites: Array.isArray(parsed.injectionSites)
			? parsed.injectionSites
			: listInjectionSites({
					url: parsed.url,
					headers: headersRecord,
					body: typeof parsed.body === 'string' ? parsed.body : '',
				}),
		auth:
			typeof parsed.auth === 'string'
				? parsed.auth
				: describeAuth({
						secretName,
						integration,
						credentialId,
						headers: headersRecord,
					}),
	}
}

export async function loadWebhookApplyDestinationApprovalView(input: {
	db: D1Database
	userId: string
	handle: string
	fingerprint: string
}): Promise<WebhookApplyDestinationApprovalView | null> {
	const endpointId = parseWebhookUrlHandle(input.handle)
	if (!endpointId) return null
	const endpoint = await getWebhookEndpointByIdForUser({
		db: input.db,
		userId: input.userId,
		endpointId,
	})
	if (!endpoint) return null

	const grant = await readGrantRow({
		db: input.db,
		userId: input.userId,
		endpointId,
		fingerprint: input.fingerprint,
	})
	const pending =
		grant == null
			? await readPendingRow({
					db: input.db,
					userId: input.userId,
					endpointId,
					fingerprint: input.fingerprint,
				})
			: null
	const row = grant ?? pending
	if (!row) return null

	const savedPackage = await getSavedPackageById(input.db, {
		userId: input.userId,
		packageId: row.package_id,
	})
	if (!savedPackage) return null

	return {
		handle: formatWebhookUrlHandle(endpoint.id),
		fingerprint: input.fingerprint,
		packageId: savedPackage.id,
		packageKodyId: savedPackage.kodyId,
		packageName: savedPackage.name,
		webhookName: row.webhook_name,
		destination: parseDestinationJson(row.destination_json),
		alreadyGranted: grant != null,
	}
}

export async function requireWebhookApplyDestinationGrantOrPending(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
	/** Slug of the verified caller org that owns `userId`'s rows. */
	orgSlug: string | null
	handle: string
	destination: WebhookUrlApplyHttpDestination
	baseUrl: string
}): Promise<
	| { status: 'granted'; fingerprint: string; credentialId: string | null }
	| {
			status: 'approval_required'
			fingerprint: string
			approvalUrl: string
			destination: HttpApplyDestinationSnapshot
			message: string
	  }
> {
	const endpointId = parseWebhookUrlHandle(input.handle)
	if (!endpointId) {
		throw new Error('Invalid webhook URL handle.')
	}
	const endpoint = await getWebhookEndpointByIdForUser({
		db: input.env.APP_DB,
		userId: input.userId,
		endpointId,
	})
	if (!endpoint) {
		throw new Error('Webhook handle was not found for this user.')
	}

	const credentialId = await resolveDestinationCredentialId({
		env: input.env,
		userId: input.userId,
		packageId: endpoint.packageId,
		destination: input.destination,
	})
	const snapshot = toHttpApplyDestinationSnapshot(input.destination, {
		credentialId,
	})
	const grantedFingerprint = await findGrantFingerprint({
		db: input.env.APP_DB,
		userId: input.userId,
		endpointId,
		destination: input.destination,
		snapshot,
	})
	if (grantedFingerprint) {
		return {
			status: 'granted',
			fingerprint: grantedFingerprint,
			credentialId,
		}
	}

	const fingerprint = await fingerprintDestinationSnapshot(snapshot)
	await upsertWebhookApplyDestinationPending({
		db: input.env.APP_DB,
		userId: input.userId,
		endpointId,
		fingerprint,
		destination: snapshot,
		packageId: endpoint.packageId,
		webhookName: endpoint.webhookName,
	})
	const approvalUrl = buildWebhookApplyDestinationApprovalUrl({
		baseUrl: input.baseUrl,
		handle: formatWebhookUrlHandle(endpoint.id),
		fingerprint,
		orgSlug: input.orgSlug,
	})
	return {
		status: 'approval_required',
		fingerprint,
		approvalUrl,
		destination: snapshot,
		message: buildWebhookApplyDestinationApprovalRequiredMessage({
			approvalUrl,
			destination: snapshot,
		}),
	}
}
