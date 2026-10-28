import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { WebhookEndpointIdRaceError } from './errors.ts'
import {
	type WebhookEndpointRecord,
	webhookUrlRotationGraceExpiresAt,
} from './types.ts'

import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export function webhookEndpointNotOffSql(alias: string) {
	return `(EXISTS (
		SELECT 1 FROM enablements
		WHERE org_id = ${alias}.user_id
			AND trigger_kind = 'webhook'
			AND instance_id = ${alias}.id
			AND state <> 'off'
	) OR NOT EXISTS (
		SELECT 1 FROM enablements
		WHERE org_id = ${alias}.user_id
			AND trigger_kind = 'webhook'
			AND instance_id = ${alias}.id
	))`
}

type WebhookEndpointRow = {
	id: string
	user_id: OwnerId
	package_id: string
	webhook_name: string
	url_secret_hash: string
	url_secret_encrypted?: string | null
	hmac_secret_encrypted?: string | null
	hmac_secret_name?: string | null
	hmac_verification_secret_encrypted?: string | null
	previous_url_secret_hash?: string | null
	previous_url_secret_expires_at?: string | null
	previous_hmac_secret_name?: string | null
	previous_hmac_secret_encrypted?: string | null
	previous_hmac_secret_expires_at?: string | null
	created_at: string
	rotated_at: string
	instance_label?: string | null
}

function mapEndpointRow(row: WebhookEndpointRow): WebhookEndpointRecord {
	return {
		id: row.id,
		userId: row.user_id,
		packageId: row.package_id,
		webhookName: row.webhook_name,
		urlSecretHash: row.url_secret_hash,
		urlSecretEncrypted: row.url_secret_encrypted ?? null,
		hmacSecretEncrypted: row.hmac_secret_encrypted ?? null,
		hmacSecretName: row.hmac_secret_name ?? null,
		hmacVerificationSecretEncrypted:
			row.hmac_verification_secret_encrypted ?? null,
		previousUrlSecretHash: row.previous_url_secret_hash ?? null,
		previousUrlSecretExpiresAt: row.previous_url_secret_expires_at ?? null,
		previousHmacSecretName: row.previous_hmac_secret_name ?? null,
		previousHmacSecretEncrypted: row.previous_hmac_secret_encrypted ?? null,
		previousHmacSecretExpiresAt: row.previous_hmac_secret_expires_at ?? null,
		createdAt: row.created_at,
		rotatedAt: row.rotated_at,
		instanceLabel: row.instance_label?.trim()
			? row.instance_label.trim()
			: null,
	}
}

/**
 * Insert or rotate a minted webhook URL secret. Hash and ciphertext are written
 * in the same statement. The caller encrypts with `id` as AAD, so `id` must be
 * the existing endpoint id on update.
 *
 * On update, the outgoing hash becomes the previous secret for the rotate
 * overlap window (`previousExpiresAt`, default 24h from `now`).
 *
 * `hmacSecretEncrypted`: when provided, written on insert and update. When
 * omitted on update, any existing package-owned HMAC is preserved across URL
 * rotate (HMAC is independent of the path secret).
 */
export async function upsertWebhookEndpointSecret(input: {
	db: D1Database
	id: string
	userId: string
	packageId: string
	webhookName: string
	urlSecretHash: string
	urlSecretEncrypted: string
	hmacSecretEncrypted?: string | null
	now?: string
	previousExpiresAt?: string
	/**
	 * When true, always insert a new endpoint under this name (multi-instance).
	 * Ignores any existing row for the same declared name.
	 */
	createInstance?: boolean
	instanceLabel?: string | null
}): Promise<WebhookEndpointRecord> {
	const now = input.now ?? new Date().toISOString()
	const instanceLabel = input.instanceLabel?.trim() || null
	const existingById = await getWebhookEndpointByIdForUser({
		db: input.db,
		userId: input.userId,
		endpointId: input.id,
	})
	const existing =
		existingById ??
		(input.createInstance
			? null
			: await getWebhookEndpointByKey({
					db: input.db,
					userId: input.userId,
					packageId: input.packageId,
					webhookName: input.webhookName,
				}))
	if (existing) {
		if (existing.id !== input.id) {
			throw new WebhookEndpointIdRaceError(existing.id)
		}
		const previousExpiresAt =
			input.previousExpiresAt ?? webhookUrlRotationGraceExpiresAt(now)
		const writeHmac = input.hmacSecretEncrypted !== undefined
		const hmacValue = input.hmacSecretEncrypted ?? null
		const result = writeHmac
			? await input.db
					.prepare(
						`UPDATE webhook_endpoints
						SET previous_url_secret_hash = url_secret_hash,
							previous_url_secret_expires_at = ?,
							url_secret_hash = ?,
							url_secret_encrypted = ?,
							hmac_secret_encrypted = ?,
							rotated_at = ?
						WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
					)
					.bind(
						previousExpiresAt,
						input.urlSecretHash,
						input.urlSecretEncrypted,
						hmacValue,
						now,
						input.userId,
						existing.id,
					)
					.run()
			: await input.db
					.prepare(
						`UPDATE webhook_endpoints
						SET previous_url_secret_hash = url_secret_hash,
							previous_url_secret_expires_at = ?,
							url_secret_hash = ?,
							url_secret_encrypted = ?,
							rotated_at = ?
						WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
					)
					.bind(
						previousExpiresAt,
						input.urlSecretHash,
						input.urlSecretEncrypted,
						now,
						input.userId,
						existing.id,
					)
					.run()
		if ((result.meta.changes ?? 0) === 0) {
			throw new Error('Unable to upsert webhook endpoint.')
		}
	} else {
		await input.db
			.prepare(
				`INSERT INTO webhook_endpoints (
					id, user_id, package_id, webhook_name, url_secret_hash,
					url_secret_encrypted, hmac_secret_encrypted, created_at, rotated_at,
					instance_label
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				input.id,
				input.userId,
				input.packageId,
				input.webhookName,
				input.urlSecretHash,
				input.urlSecretEncrypted,
				input.hmacSecretEncrypted ?? null,
				now,
				now,
				instanceLabel,
			)
			.run()
	}
	const record = await getWebhookEndpointByIdForUser({
		db: input.db,
		userId: input.userId,
		endpointId: input.id,
	})
	if (!record) {
		throw new Error('Unable to upsert webhook endpoint.')
	}
	return record
}

/** Sets package-owned HMAC ciphertext, as a statement to batch with related writes. */
export function buildSetWebhookEndpointHmacSecretStatement(input: {
	db: D1Database
	userId: string
	endpointId: string
	hmacSecretEncrypted: string
}): D1PreparedStatement {
	return input.db
		.prepare(
			`UPDATE webhook_endpoints
			SET hmac_secret_encrypted = ?
			WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.hmacSecretEncrypted, input.userId, input.endpointId)
}

/** Persist package-owned HMAC without rotating the URL secret. */
export async function setWebhookEndpointHmacSecret(input: {
	db: D1Database
	userId: string
	endpointId: string
	hmacSecretEncrypted: string
	/** When replacing, keep the outgoing ciphertext live for the grace window. */
	previousHmacSecretEncrypted?: string | null
	previousHmacSecretExpiresAt?: string | null
}): Promise<WebhookEndpointRecord | null> {
	const writePrevious = input.previousHmacSecretEncrypted !== undefined
	const result = writePrevious
		? await input.db
				.prepare(
					`UPDATE webhook_endpoints
					SET hmac_secret_encrypted = ?,
						previous_hmac_secret_name = NULL,
						previous_hmac_secret_encrypted = ?,
						previous_hmac_secret_expires_at = ?
					WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
				)
				.bind(
					input.hmacSecretEncrypted,
					input.previousHmacSecretEncrypted ?? null,
					input.previousHmacSecretExpiresAt ?? null,
					input.userId,
					input.endpointId,
				)
				.run()
		: await buildSetWebhookEndpointHmacSecretStatement(input).run()
	if ((result.meta.changes ?? 0) === 0) return null
	return getWebhookEndpointByIdForUser({
		db: input.db,
		userId: input.userId,
		endpointId: input.endpointId,
	})
}

/**
 * Persist last-seen declared signing identity / snapshot and optional
 * previous_* grace columns. Does not touch apply's hmac_secret_encrypted.
 */
export async function setWebhookEndpointHmacVerificationState(input: {
	db: D1Database
	userId: string
	endpointId: string
	hmacSecretName: string | null
	hmacVerificationSecretEncrypted: string | null
	previousHmacSecretName?: string | null
	previousHmacSecretEncrypted?: string | null
	previousHmacSecretExpiresAt?: string | null
}): Promise<WebhookEndpointRecord | null> {
	const writePrevious = input.previousHmacSecretEncrypted !== undefined
	const result = writePrevious
		? await input.db
				.prepare(
					`UPDATE webhook_endpoints
					SET hmac_secret_name = ?,
						hmac_verification_secret_encrypted = ?,
						previous_hmac_secret_name = ?,
						previous_hmac_secret_encrypted = ?,
						previous_hmac_secret_expires_at = ?
					WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
				)
				.bind(
					input.hmacSecretName,
					input.hmacVerificationSecretEncrypted,
					input.previousHmacSecretName ?? null,
					input.previousHmacSecretEncrypted ?? null,
					input.previousHmacSecretExpiresAt ?? null,
					input.userId,
					input.endpointId,
				)
				.run()
		: await input.db
				.prepare(
					`UPDATE webhook_endpoints
					SET hmac_secret_name = ?,
						hmac_verification_secret_encrypted = ?
					WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
				)
				.bind(
					input.hmacSecretName,
					input.hmacVerificationSecretEncrypted,
					input.userId,
					input.endpointId,
				)
				.run()
	if ((result.meta.changes ?? 0) === 0) return null
	return getWebhookEndpointByIdForUser({
		db: input.db,
		userId: input.userId,
		endpointId: input.endpointId,
	})
}

/**
 * Drop an expired (or retired) previous signing secret. When
 * `previousHmacSecretEncrypted` is provided, only clear if that exact
 * ciphertext is still the live previous (compare-and-swap against a newer
 * concurrent rotation).
 */
export async function clearWebhookEndpointPreviousHmacSecret(input: {
	db: D1Database
	userId: string
	endpointId: string
	previousHmacSecretEncrypted?: string | null
}) {
	const observed = input.previousHmacSecretEncrypted
	if (observed) {
		await input.db
			.prepare(
				`UPDATE webhook_endpoints
				SET previous_hmac_secret_name = NULL,
					previous_hmac_secret_encrypted = NULL,
					previous_hmac_secret_expires_at = NULL
				WHERE user_id = ? AND id = ? AND previous_hmac_secret_encrypted = ?
				${andLiveDeletedAtSql()}`,
			)
			.bind(input.userId, input.endpointId, observed)
			.run()
		return
	}
	await input.db
		.prepare(
			`UPDATE webhook_endpoints
			SET previous_hmac_secret_name = NULL,
				previous_hmac_secret_encrypted = NULL,
				previous_hmac_secret_expires_at = NULL
			WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.userId, input.endpointId)
		.run()
}

/** Endpoints whose last-seen verification.secretName matches. */
export async function listWebhookEndpointsByHmacSecretName(input: {
	db: D1Database
	userId: string
	hmacSecretName: string
	/** When set, only endpoints for this package (package-scoped secrets). */
	packageId?: string
}): Promise<Array<WebhookEndpointRecord>> {
	const packageFilter = input.packageId ? ' AND package_id = ?' : ''
	const bindings = input.packageId
		? [input.userId, input.hmacSecretName, input.packageId]
		: [input.userId, input.hmacSecretName]
	const result = await input.db
		.prepare(
			`SELECT *
			FROM webhook_endpoints
			WHERE user_id = ? AND hmac_secret_name = ?${packageFilter}${andLiveDeletedAtSql()}`,
		)
		.bind(...bindings)
		.all<WebhookEndpointRow>()
	return (result.results ?? []).map(mapEndpointRow)
}

export async function listWebhookEndpointsForUser(input: {
	db: D1Database
	userId: string
}): Promise<Array<WebhookEndpointRecord>> {
	const result = await input.db
		.prepare(
			`SELECT *
			FROM webhook_endpoints
			WHERE user_id = ?${andLiveDeletedAtSql()}
			ORDER BY created_at DESC, id DESC`,
		)
		.bind(input.userId)
		.all<WebhookEndpointRow>()
	return (result.results ?? []).map(mapEndpointRow)
}

/**
 * Oldest live endpoint for a declared webhook name (stable “primary” mint).
 * Prefer {@link listWebhookEndpointsByName} when every URL under the name matters.
 */
export async function getWebhookEndpointByKey(input: {
	db: D1Database
	userId: string
	packageId: string
	webhookName: string
}): Promise<WebhookEndpointRecord | null> {
	const row = await input.db
		.prepare(
			`SELECT *
			FROM webhook_endpoints
			WHERE user_id = ? AND package_id = ? AND webhook_name = ?
			${andLiveDeletedAtSql()}
			ORDER BY created_at ASC, id ASC
			LIMIT 1`,
		)
		.bind(input.userId, input.packageId, input.webhookName)
		.first<WebhookEndpointRow>()
	return row ? mapEndpointRow(row) : null
}

/** Every live minted URL under one declared webhook name, oldest first. */
export async function listWebhookEndpointsByName(input: {
	db: D1Database
	userId: string
	packageId: string
	webhookName: string
}): Promise<Array<WebhookEndpointRecord>> {
	const result = await input.db
		.prepare(
			`SELECT *
			FROM webhook_endpoints
			WHERE user_id = ? AND package_id = ? AND webhook_name = ?
			${andLiveDeletedAtSql()}
			ORDER BY created_at ASC, id ASC`,
		)
		.bind(input.userId, input.packageId, input.webhookName)
		.all<WebhookEndpointRow>()
	return (result.results ?? []).map(mapEndpointRow)
}

export async function getWebhookEndpointByIdForUser(input: {
	db: D1Database
	userId: string
	endpointId: string
}): Promise<WebhookEndpointRecord | null> {
	const row = await input.db
		.prepare(
			`SELECT *
			FROM webhook_endpoints
			WHERE id = ? AND user_id = ?
			${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(input.endpointId, input.userId)
		.first<WebhookEndpointRow>()
	return row ? mapEndpointRow(row) : null
}

/** Drop the rotate-overlap previous secret (confirmed on the new URL, or expired). */
export async function clearWebhookEndpointPreviousUrlSecret(input: {
	db: D1Database
	userId: string
	endpointId: string
	urlSecretHash: string
}) {
	await input.db
		.prepare(
			`UPDATE webhook_endpoints
			SET previous_url_secret_hash = NULL,
				previous_url_secret_expires_at = NULL
			WHERE user_id = ? AND id = ? AND url_secret_hash = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.userId, input.endpointId, input.urlSecretHash)
		.run()
}
