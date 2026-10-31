import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { canonicalJsonStringify } from '@kody-internal/shared/canonical-json.ts'
import { toHex } from '@kody-internal/shared/hex.ts'
import {
	decryptMcpEventSubscriptionSecret,
	encryptMcpEventSubscriptionSecret,
	userMcpEventSubscriptionSecretContext,
} from '#mcp/secrets/crypto.ts'
import {
	mcpEventSecretRotationGraceMs,
	type McpEventDeliveryErrorCategory,
} from './constants.ts'

/**
 * Subscription identity: draft (principal, delivery.url, name, arguments)
 * plus the connection profile that granted subscribe. Kody's principal is
 * the stable user id plus the OAuth client the grant was issued to. Profile
 * is part of the id so a refresh from a different (or unrestricted) grant
 * cannot overwrite another grant's stored limits.
 */
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
export type McpEventSubscriptionKey = {
	userId: OwnerId
	oauthClientId: string
	connectionProfileName: string | null
	/** Profile (ADR 0092) of the subscribing credential; part of the id when set. */
	profileId?: string | null
	eventName: string
	arguments: Record<string, unknown>
	callbackUrl: string
}

export type McpEventSubscriptionRecord = {
	id: string
	userId: OwnerId
	oauthClientId: string
	connectionProfileName: string | null
	profileId: string | null
	eventName: string
	argumentsJson: string
	callbackUrl: string
	refreshBefore: string | null
	verifiedAt: string | null
	active: boolean
	lastDeliveryAt: string | null
	lastError: McpEventDeliveryErrorCategory | null
	createdAt: string
	updatedAt: string
}

type McpEventSubscriptionRow = {
	id: string
	user_id: OwnerId
	oauth_client_id: string
	connection_profile_name: string | null
	profile_id: string | null
	event_name: string
	arguments_json: string
	callback_url: string
	secret_encrypted: string
	previous_secret_encrypted: string | null
	previous_secret_expires_at: string | null
	refresh_before: string | null
	verified_at: string | null
	active: number
	last_delivery_at: string | null
	last_error: string | null
	created_at: string
	updated_at: string
}

const selectColumns = `id, user_id, oauth_client_id, connection_profile_name, profile_id,
	event_name, arguments_json, callback_url, secret_encrypted,
	previous_secret_encrypted, previous_secret_expires_at, refresh_before,
	verified_at, active, last_delivery_at, last_error, created_at, updated_at`

const deliveryErrorCategories: ReadonlySet<string> =
	new Set<McpEventDeliveryErrorCategory>([
		'connection_refused',
		'timeout',
		'tls_error',
		'http_4xx',
		'http_5xx',
		'challenge_failed',
	])

function toRecord(row: McpEventSubscriptionRow): McpEventSubscriptionRecord {
	return {
		id: row.id,
		userId: row.user_id,
		oauthClientId: row.oauth_client_id,
		connectionProfileName: row.connection_profile_name,
		profileId: row.profile_id ?? null,
		eventName: row.event_name,
		argumentsJson: row.arguments_json,
		callbackUrl: row.callback_url,
		refreshBefore: row.refresh_before,
		verifiedAt: row.verified_at,
		active: row.active === 1,
		lastDeliveryAt: row.last_delivery_at,
		lastError:
			row.last_error && deliveryErrorCategories.has(row.last_error)
				? (row.last_error as McpEventDeliveryErrorCategory)
				: null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

export function canonicalMcpEventArgumentsJson(
	value: Record<string, unknown>,
): string {
	return canonicalJsonStringify(value)
}

/**
 * Deterministic `sub_` id over the canonical key. A routing handle only
 * (sent as `X-MCP-Subscription-Id`); it is never accepted as input.
 */
export async function buildMcpEventSubscriptionId(
	key: McpEventSubscriptionKey,
): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(
			canonicalJsonStringify({
				userId: key.userId,
				oauthClientId: key.oauthClientId,
				connectionProfileName: key.connectionProfileName,
				...(key.profileId ? { profileId: key.profileId } : {}),
				eventName: key.eventName,
				arguments: key.arguments,
				callbackUrl: key.callbackUrl,
			}),
		),
	)
	return `sub_${toHex(new Uint8Array(digest)).slice(0, 32)}`
}

export async function getMcpEventSubscription(input: {
	db: D1Database
	userId: OwnerId
	id: string
}): Promise<McpEventSubscriptionRecord | null> {
	const row = await input.db
		.prepare(
			`SELECT ${selectColumns} FROM mcp_event_subscriptions
			 WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.userId, input.id)
		.first<McpEventSubscriptionRow>()
	return row ? toRecord(row) : null
}

export async function countLiveMcpEventSubscriptionsForPrincipal(input: {
	db: D1Database
	userId: OwnerId
	oauthClientId: string
	now: Date
}): Promise<number> {
	const row = await input.db
		.prepare(
			`SELECT COUNT(*) AS count FROM mcp_event_subscriptions
			 WHERE user_id = ? AND oauth_client_id = ?
			   AND (refresh_before IS NULL OR refresh_before > ?)${andLiveDeletedAtSql()}`,
		)
		.bind(input.userId, input.oauthClientId, input.now.toISOString())
		.first<{ count: number }>()
	return row?.count ?? 0
}

/**
 * Verification is cached per (principal, url, secret): a recent row for
 * this principal and callback whose current signing secret matches
 * `secret`. Secret rotation must re-challenge; URL-only cache hits would
 * skip proving the receiver still accepts the new secret.
 */
export async function findRecentMcpEventCallbackVerification(input: {
	db: D1Database
	env: Pick<Env, 'SECRET_STORE_KEY'>
	userId: OwnerId
	oauthClientId: string
	callbackUrl: string
	secret: string
	verifiedSince: Date
}): Promise<string | null> {
	const rows = await input.db
		.prepare(
			`SELECT id, secret_encrypted, verified_at FROM mcp_event_subscriptions
			 WHERE user_id = ? AND oauth_client_id = ? AND callback_url = ?
			   AND verified_at IS NOT NULL AND verified_at > ?
			${andLiveDeletedAtSql()} ORDER BY verified_at DESC`,
		)
		.bind(
			input.userId,
			input.oauthClientId,
			input.callbackUrl,
			input.verifiedSince.toISOString(),
		)
		.all<{
			id: string
			secret_encrypted: string
			verified_at: string
		}>()
	for (const row of rows.results ?? []) {
		try {
			const stored = await decryptMcpEventSubscriptionSecret(
				input.env,
				row.secret_encrypted,
				userMcpEventSubscriptionSecretContext(input.userId, row.id),
			)
			if (stored === input.secret) return row.verified_at
		} catch {
			// Corrupt or foreign ciphertext cannot prove this secret; keep looking.
		}
	}
	return null
}

/**
 * Idempotent create-or-refresh. Key columns are immutable; secret, grant,
 * profile binding, and verification are replaced. A changed secret keeps
 * the previous ciphertext as a co-signer for a short rotation window.
 */
export async function upsertMcpEventSubscription(input: {
	db: D1Database
	env: Pick<Env, 'SECRET_STORE_KEY'>
	id: string
	key: McpEventSubscriptionKey
	connectionProfileName: string | null
	secret: string
	refreshBefore: Date
	verifiedAt: string
	now: Date
}): Promise<McpEventSubscriptionRecord> {
	const context = userMcpEventSubscriptionSecretContext(
		input.key.userId,
		input.id,
	)
	const existingRow = await input.db
		.prepare(
			`SELECT ${selectColumns} FROM mcp_event_subscriptions
			 WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.key.userId, input.id)
		.first<McpEventSubscriptionRow>()
	let previousSecretEncrypted: string | null = null
	let previousSecretExpiresAt: string | null = null
	if (existingRow) {
		const existingSecret = await decryptMcpEventSubscriptionSecret(
			input.env,
			existingRow.secret_encrypted,
			context,
		)
		if (existingSecret !== input.secret) {
			previousSecretEncrypted = existingRow.secret_encrypted
			previousSecretExpiresAt = new Date(
				input.now.getTime() + mcpEventSecretRotationGraceMs,
			).toISOString()
		} else {
			previousSecretEncrypted = existingRow.previous_secret_encrypted
			previousSecretExpiresAt = existingRow.previous_secret_expires_at
		}
	}
	const secretEncrypted = await encryptMcpEventSubscriptionSecret(
		input.env,
		input.secret,
		context,
	)
	const nowIso = input.now.toISOString()
	await input.db
		.prepare(
			`INSERT INTO mcp_event_subscriptions (
				id, user_id, oauth_client_id, connection_profile_name, profile_id,
				event_name, arguments_json, callback_url, secret_encrypted,
				previous_secret_encrypted, previous_secret_expires_at,
				refresh_before, verified_at, active, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				connection_profile_name = excluded.connection_profile_name,
				profile_id = excluded.profile_id,
				secret_encrypted = excluded.secret_encrypted,
				previous_secret_encrypted = excluded.previous_secret_encrypted,
				previous_secret_expires_at = excluded.previous_secret_expires_at,
				refresh_before = excluded.refresh_before,
				verified_at = excluded.verified_at,
				active = 1,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.id,
			input.key.userId,
			input.key.oauthClientId,
			input.connectionProfileName,
			input.key.profileId ?? null,
			input.key.eventName,
			canonicalMcpEventArgumentsJson(input.key.arguments),
			input.key.callbackUrl,
			secretEncrypted,
			previousSecretEncrypted,
			previousSecretExpiresAt,
			input.refreshBefore.toISOString(),
			input.verifiedAt,
			nowIso,
			nowIso,
		)
		.run()
	const saved = await getMcpEventSubscription({
		db: input.db,
		userId: input.key.userId,
		id: input.id,
	})
	if (!saved) {
		throw new Error(`MCP event subscription ${input.id} was not persisted.`)
	}
	return saved
}

export async function deleteMcpEventSubscription(input: {
	db: D1Database
	userId: OwnerId
	id: string
}): Promise<boolean> {
	const result = await input.db
		.prepare(
			`DELETE FROM mcp_event_subscriptions WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.userId, input.id)
		.run()
	return (result.meta?.changes ?? 0) > 0
}

export async function deleteExpiredMcpEventSubscriptions(input: {
	db: D1Database
	userId: OwnerId
	now: Date
}): Promise<void> {
	await input.db
		.prepare(
			`DELETE FROM mcp_event_subscriptions
			 WHERE user_id = ? AND refresh_before IS NOT NULL AND refresh_before <= ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.userId, input.now.toISOString())
		.run()
}

/** Active, unexpired, verified subscriptions for one user's event name. */
export async function listDeliverableMcpEventSubscriptions(input: {
	db: D1Database
	userId: OwnerId
	eventName: string
	now: Date
}): Promise<Array<McpEventSubscriptionRecord>> {
	const result = await input.db
		.prepare(
			`SELECT ${selectColumns} FROM mcp_event_subscriptions
			 WHERE user_id = ? AND event_name = ? AND active = 1
			   AND verified_at IS NOT NULL
			   AND (refresh_before IS NULL OR refresh_before > ?)${andLiveDeletedAtSql()}
			 ORDER BY id`,
		)
		.bind(input.userId, input.eventName, input.now.toISOString())
		.all<McpEventSubscriptionRow>()
	return (result.results ?? []).map(toRecord)
}

/** True when the stored current secret decrypts to `secret`. */
export async function mcpEventSubscriptionSecretMatches(input: {
	db: D1Database
	env: Pick<Env, 'SECRET_STORE_KEY'>
	userId: OwnerId
	id: string
	secret: string
}): Promise<boolean> {
	const row = await input.db
		.prepare(
			`SELECT secret_encrypted FROM mcp_event_subscriptions
			 WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.userId, input.id)
		.first<{ secret_encrypted: string }>()
	if (!row) return false
	const stored = await decryptMcpEventSubscriptionSecret(
		input.env,
		row.secret_encrypted,
		userMcpEventSubscriptionSecretContext(input.userId, input.id),
	)
	return stored === input.secret
}

/**
 * Current secret plus, inside the rotation window, the previous one (for
 * Standard Webhooks multi-signature).
 */
export async function readMcpEventSubscriptionSigningSecrets(input: {
	db: D1Database
	env: Pick<Env, 'SECRET_STORE_KEY'>
	userId: OwnerId
	id: string
	now: Date
}): Promise<Array<string>> {
	const row = await input.db
		.prepare(
			`SELECT secret_encrypted, previous_secret_encrypted, previous_secret_expires_at
			 FROM mcp_event_subscriptions WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.userId, input.id)
		.first<
			Pick<
				McpEventSubscriptionRow,
				| 'secret_encrypted'
				| 'previous_secret_encrypted'
				| 'previous_secret_expires_at'
			>
		>()
	if (!row) {
		throw new Error(`MCP event subscription ${input.id} not found.`)
	}
	const context = userMcpEventSubscriptionSecretContext(input.userId, input.id)
	const secrets = [
		await decryptMcpEventSubscriptionSecret(
			input.env,
			row.secret_encrypted,
			context,
		),
	]
	if (
		row.previous_secret_encrypted &&
		row.previous_secret_expires_at &&
		row.previous_secret_expires_at > input.now.toISOString()
	) {
		secrets.push(
			await decryptMcpEventSubscriptionSecret(
				input.env,
				row.previous_secret_encrypted,
				context,
			),
		)
	}
	return secrets
}

export async function recordMcpEventDeliveryOutcome(input: {
	db: D1Database
	userId: OwnerId
	id: string
	now: Date
	outcome: { ok: true } | { ok: false; error: McpEventDeliveryErrorCategory }
}): Promise<void> {
	const nowIso = input.now.toISOString()
	if (input.outcome.ok) {
		await input.db
			.prepare(
				`UPDATE mcp_event_subscriptions
				 SET last_delivery_at = ?, last_error = NULL, updated_at = ?
				 WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
			)
			.bind(nowIso, nowIso, input.userId, input.id)
			.run()
		return
	}
	await input.db
		.prepare(
			`UPDATE mcp_event_subscriptions
			 SET last_error = ?, updated_at = ?
			 WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.outcome.error, nowIso, input.userId, input.id)
		.run()
}

/**
 * Revoke cleanup. With `userId`, only that user's grant to the client is
 * gone (shared client registrations survive); without it, the client
 * registration itself was deleted and no principal can use it.
 */
export async function deleteMcpEventSubscriptionsForOauthClient(input: {
	db: D1Database
	oauthClientId: string
	userId?: string
}): Promise<number> {
	const result =
		input.userId === undefined
			? await input.db
					.prepare(
						`DELETE FROM mcp_event_subscriptions WHERE oauth_client_id = ?${andLiveDeletedAtSql()}`,
					)
					.bind(input.oauthClientId)
					.run()
			: await input.db
					.prepare(
						`DELETE FROM mcp_event_subscriptions
						 WHERE oauth_client_id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
					)
					.bind(input.oauthClientId, input.userId)
					.run()
	return result.meta?.changes ?? 0
}

/** Every grant of the user was revoked (password change / reset). */
export async function deleteMcpEventSubscriptionsForUser(input: {
	db: D1Database
	userId: OwnerId
}): Promise<number> {
	const result = await input.db
		.prepare(
			`DELETE FROM mcp_event_subscriptions WHERE user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.userId)
		.run()
	return result.meta?.changes ?? 0
}
