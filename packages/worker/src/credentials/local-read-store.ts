/**
 * Local reads storage (ADR 0096): the per-credential switch
 * (`credential_local_read_settings`) and the Local reads list
 * (`credential_local_read_events`). Rows never hold a secret value.
 */
import * as Sentry from '@sentry/cloudflare'

export const localReadEventRetentionDays = 90
export const localReadListLimit = 100

export const localReadCommands = ['run', 'get'] as const
export type LocalReadCommand = (typeof localReadCommands)[number]

export const localReadRefusalReasons = [
	'not_found',
	'no_access',
	'local_reads_off',
	'token_scope',
	'profile_grant',
	'unsupported_secret',
	'rate_limited',
	'provider_failed',
	'other_secret_refused',
] as const
export type LocalReadRefusalReason = (typeof localReadRefusalReasons)[number]

export type LocalReadSetting = {
	enabled: boolean
	updatedAt: string
	updatedByUserId: string | null
	lastReadAt: string | null
}

export type LocalReadEvent = {
	id: string
	credentialId: string
	actorUserId: string | null
	actorUsername: string | null
	tokenId: string | null
	tokenName: string | null
	profileId: string | null
	profileName: string | null
	command: LocalReadCommand
	ip: string | null
	outcome: 'allowed' | 'refused'
	refusalReason: LocalReadRefusalReason | null
	createdAt: string
}

type SettingRow = {
	credential_id: string
	enabled: number
	updated_at: string
	updated_by_user_id: string | null
	last_read_at: string | null
}

function toSetting(row: SettingRow): LocalReadSetting {
	return {
		enabled: row.enabled === 1,
		updatedAt: row.updated_at,
		updatedByUserId: row.updated_by_user_id,
		lastReadAt: row.last_read_at,
	}
}

export async function readLocalReadSetting(
	db: D1Database,
	credentialId: string,
): Promise<LocalReadSetting | null> {
	const row = await db
		.prepare(
			`SELECT credential_id, enabled, updated_at, updated_by_user_id, last_read_at
			 FROM credential_local_read_settings WHERE credential_id = ?`,
		)
		.bind(credentialId)
		.first<SettingRow>()
	return row ? toSetting(row) : null
}

/** Settings for many credentials; a credential with no row is absent. */
export async function listLocalReadSettings(
	db: D1Database,
	credentialIds: ReadonlyArray<string>,
): Promise<Map<string, LocalReadSetting>> {
	const settings = new Map<string, LocalReadSetting>()
	const unique = [...new Set(credentialIds)]
	for (let start = 0; start < unique.length; start += 90) {
		const chunk = unique.slice(start, start + 90)
		try {
			const { results } = await db
				.prepare(
					`SELECT credential_id, enabled, updated_at, updated_by_user_id, last_read_at
				 FROM credential_local_read_settings
				 WHERE credential_id IN (${chunk.map(() => '?').join(', ')})`,
				)
				.bind(...chunk)
				.all<SettingRow>()
			for (const row of results ?? [])
				settings.set(row.credential_id, toSetting(row))
		} catch (error) {
			// Keep earlier chunks so list badges do not vanish when a later
			// IN (...) batch fails.
			Sentry.captureException(error, {
				tags: { scope: 'credentials.local_reads.settings' },
				extra: { chunkStart: start, chunkSize: chunk.length },
			})
		}
	}
	return settings
}

export async function setLocalReadEnabled(input: {
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
			`INSERT INTO credential_local_read_settings (
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

export type NewLocalReadEvent = Omit<LocalReadEvent, 'id' | 'createdAt'> & {
	orgId: string
}

/** Records reads and moves each allowed credential's last local read time. */
export async function recordLocalReadEvents(
	db: D1Database,
	events: ReadonlyArray<NewLocalReadEvent>,
	now: Date = new Date(),
) {
	if (events.length === 0) return
	const createdAt = now.toISOString()
	const statements = events.map((event) =>
		db
			.prepare(
				`INSERT INTO credential_local_read_events (
					id, org_id, credential_id, actor_user_id, actor_username, token_id,
					token_name, profile_id, profile_name, command, ip, outcome, refusal_reason,
					created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				event.orgId,
				event.credentialId,
				event.actorUserId,
				event.actorUsername,
				event.tokenId,
				event.tokenName,
				event.profileId,
				event.profileName,
				event.command,
				event.ip,
				event.outcome,
				event.refusalReason,
				createdAt,
			),
	)
	const allowed = [
		...new Set(
			events
				.filter((event) => event.outcome === 'allowed')
				.map((event) => event.credentialId),
		),
	]
	for (const credentialId of allowed) {
		statements.push(
			db
				.prepare(
					`UPDATE credential_local_read_settings SET last_read_at = ?
					 WHERE credential_id = ?`,
				)
				.bind(createdAt, credentialId),
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
	token_name: string | null
	profile_id: string | null
	profile_name: string | null
	command: LocalReadCommand
	ip: string | null
	outcome: 'allowed' | 'refused'
	refusal_reason: LocalReadRefusalReason | null
	created_at: string
}

function retentionCutoff(now: Date) {
	return new Date(
		now.getTime() - localReadEventRetentionDays * 24 * 60 * 60 * 1000,
	).toISOString()
}

/** The newest reads of one credential inside the retention window. */
export async function listLocalReadEvents(input: {
	db: D1Database
	credentialId: string
	limit?: number
	now?: Date
}): Promise<Array<LocalReadEvent>> {
	const { results } = await input.db
		.prepare(
			`SELECT id, credential_id, actor_user_id, actor_username, token_id,
				token_name,
				profile_id, profile_name, command, ip, outcome, refusal_reason,
				created_at
			 FROM credential_local_read_events
			 WHERE credential_id = ? AND created_at >= ?
			 ORDER BY created_at DESC, id DESC
			 LIMIT ?`,
		)
		.bind(
			input.credentialId,
			retentionCutoff(input.now ?? new Date()),
			input.limit ?? localReadListLimit,
		)
		.all<EventRow>()
	return (results ?? []).map((row) => ({
		id: row.id,
		credentialId: row.credential_id,
		actorUserId: row.actor_user_id,
		actorUsername: row.actor_username,
		tokenId: row.token_id,
		tokenName: row.token_name,
		profileId: row.profile_id,
		profileName: row.profile_name,
		command: row.command,
		ip: row.ip,
		outcome: row.outcome,
		refusalReason: row.refusal_reason,
		createdAt: row.created_at,
	}))
}

/** Deletes one batch of reads older than the retention window. */
export async function pruneLocalReadEvents(input: {
	db: D1Database
	now?: Date
	batchSize: number
}): Promise<number> {
	const result = await input.db
		.prepare(
			`DELETE FROM credential_local_read_events WHERE id IN (
				SELECT id FROM credential_local_read_events
				WHERE created_at < ?
				ORDER BY created_at
				LIMIT ?
			)`,
		)
		.bind(retentionCutoff(input.now ?? new Date()), input.batchSize)
		.run()
	return result.meta.changes ?? 0
}
