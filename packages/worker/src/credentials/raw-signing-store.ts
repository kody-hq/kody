/**
 * Raw RSA signing storage (ADR 0099): the per-credential switch
 * (`credential_raw_signing_settings`) and the Raw signatures list
 * (`credential_raw_signing_events`). Rows never hold a key, a message, or a
 * signature; an event keeps only the message size.
 */

export const rawSigningEventRetentionDays = 90
export const rawSigningListLimit = 100

export const rawSigningRefusalReasons = [
	'raw_signing_off',
	'no_access',
	'invalid_request',
] as const
export type RawSigningRefusalReason = (typeof rawSigningRefusalReasons)[number]

export type RawSigningSetting = {
	enabled: boolean
	updatedAt: string
	updatedByUserId: string | null
	lastSignedAt: string | null
}

export type RawSigningEvent = {
	id: string
	credentialId: string
	actorUserId: string | null
	actorUsername: string | null
	tokenId: string | null
	via: string | null
	profileId: string | null
	packageId: string | null
	messageBytes: number | null
	outcome: 'signed' | 'refused'
	refusalReason: RawSigningRefusalReason | null
	createdAt: string
}

type SettingRow = {
	enabled: number
	updated_at: string
	updated_by_user_id: string | null
	last_signed_at: string | null
}

export async function readRawSigningSetting(
	db: D1Database,
	credentialId: string,
): Promise<RawSigningSetting | null> {
	const row = await db
		.prepare(
			`SELECT enabled, updated_at, updated_by_user_id, last_signed_at
			 FROM credential_raw_signing_settings WHERE credential_id = ?`,
		)
		.bind(credentialId)
		.first<SettingRow>()
	return row
		? {
				enabled: row.enabled === 1,
				updatedAt: row.updated_at,
				updatedByUserId: row.updated_by_user_id,
				lastSignedAt: row.last_signed_at,
			}
		: null
}

export async function setRawSigningEnabled(input: {
	db: D1Database
	credentialId: string
	orgId: string
	enabled: boolean
	userId: string
	now?: Date
}) {
	const now = (input.now ?? new Date()).toISOString()
	await input.db
		.prepare(
			`INSERT INTO credential_raw_signing_settings (
				credential_id, org_id, enabled, updated_by_user_id, updated_at
			) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (credential_id) DO UPDATE SET
				org_id = excluded.org_id,
				enabled = excluded.enabled,
				updated_by_user_id = excluded.updated_by_user_id,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.credentialId,
			input.orgId,
			input.enabled ? 1 : 0,
			input.userId,
			now,
		)
		.run()
}

export type NewRawSigningEvent = Omit<RawSigningEvent, 'id' | 'createdAt'> & {
	orgId: string
}

/** Records one raw signature (or refusal) and moves the last-signed time. */
export async function recordRawSigningEvent(
	db: D1Database,
	event: NewRawSigningEvent,
	now: Date = new Date(),
) {
	const createdAt = now.toISOString()
	const statements = [
		db
			.prepare(
				`INSERT INTO credential_raw_signing_events (
					id, org_id, credential_id, actor_user_id, actor_username, token_id,
					via, profile_id, package_id, message_bytes, outcome,
					refusal_reason, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				event.orgId,
				event.credentialId,
				event.actorUserId,
				event.actorUsername,
				event.tokenId,
				event.via,
				event.profileId,
				event.packageId,
				event.messageBytes,
				event.outcome,
				event.refusalReason,
				createdAt,
			),
	]
	if (event.outcome === 'signed') {
		statements.push(
			db
				.prepare(
					`UPDATE credential_raw_signing_settings SET last_signed_at = ?
					 WHERE credential_id = ?`,
				)
				.bind(createdAt, event.credentialId),
		)
	}
	await db.batch(statements)
}

type EventRow = {
	id: string
	credential_id: string
	actor_user_id: string | null
	actor_username: string | null
	token_id: string | null
	via: string | null
	profile_id: string | null
	package_id: string | null
	message_bytes: number | null
	outcome: 'signed' | 'refused'
	refusal_reason: RawSigningRefusalReason | null
	created_at: string
}

function retentionCutoff(now: Date) {
	return new Date(
		now.getTime() - rawSigningEventRetentionDays * 24 * 60 * 60 * 1000,
	).toISOString()
}

/** The newest raw signatures of one credential inside the retention window. */
export async function listRawSigningEvents(input: {
	db: D1Database
	credentialId: string
	limit?: number
	now?: Date
}): Promise<Array<RawSigningEvent>> {
	const { results } = await input.db
		.prepare(
			`SELECT id, credential_id, actor_user_id, actor_username, token_id,
				via, profile_id, package_id, message_bytes, outcome,
				refusal_reason, created_at
			 FROM credential_raw_signing_events
			 WHERE credential_id = ? AND created_at >= ?
			 ORDER BY created_at DESC, id DESC
			 LIMIT ?`,
		)
		.bind(
			input.credentialId,
			retentionCutoff(input.now ?? new Date()),
			input.limit ?? rawSigningListLimit,
		)
		.all<EventRow>()
	return (results ?? []).map((row) => ({
		id: row.id,
		credentialId: row.credential_id,
		actorUserId: row.actor_user_id,
		actorUsername: row.actor_username,
		tokenId: row.token_id,
		via: row.via,
		profileId: row.profile_id,
		packageId: row.package_id,
		messageBytes: row.message_bytes,
		outcome: row.outcome,
		refusalReason: row.refusal_reason,
		createdAt: row.created_at,
	}))
}

/** Deletes one batch of raw-signing events older than the retention window. */
export async function pruneRawSigningEvents(input: {
	db: D1Database
	now?: Date
	batchSize: number
}): Promise<number> {
	const result = await input.db
		.prepare(
			`DELETE FROM credential_raw_signing_events WHERE id IN (
				SELECT id FROM credential_raw_signing_events
				WHERE created_at < ?
				ORDER BY created_at
				LIMIT ?
			)`,
		)
		.bind(retentionCutoff(input.now ?? new Date()), input.batchSize)
		.run()
	return result.meta.changes ?? 0
}
