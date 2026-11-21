import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { Clock, Effect, Schema } from 'effect'
import { D1, sql } from '#worker/effect/d1.ts'

export const repoSessionDueOwnerBatchSize = 25
export const repoSessionDueOwnerFailureDelayMs = 5 * 60 * 1000

export type RepoSessionDueOwner = {
	userId: OwnerId
	dueAt: string
}

/** Workers-unit D1 does not apply SQL migrations; production deploy does. */
async function ensureRepoSessionDueOwnersSchema(db: D1Database): Promise<void> {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS repo_session_due_owners (
				user_id TEXT PRIMARY KEY NOT NULL,
				due_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE INDEX IF NOT EXISTS idx_repo_session_due_owners_due_at
			ON repo_session_due_owners(due_at, user_id)`,
		)
		.run()
}

export async function replaceRepoSessionDueOwner(input: {
	db: D1Database
	userId: string
	dueAt: string | null
	now?: Date
}): Promise<void> {
	await ensureRepoSessionDueOwnersSchema(input.db)
	if (input.dueAt == null) {
		await input.db
			.prepare(`DELETE FROM repo_session_due_owners WHERE user_id = ?`)
			.bind(input.userId)
			.run()
		return
	}
	const now = input.now ?? new Date()
	await input.db
		.prepare(
			`INSERT INTO repo_session_due_owners (user_id, due_at, updated_at)
			VALUES (?, ?, ?)
			ON CONFLICT(user_id) DO UPDATE SET
				due_at = excluded.due_at,
				updated_at = excluded.updated_at`,
		)
		.bind(input.userId, input.dueAt, now.toISOString())
		.run()
}

export async function listDueRepoSessionOwners(input: {
	db: D1Database
	now?: Date
	limit?: number
}): Promise<Array<RepoSessionDueOwner>> {
	await ensureRepoSessionDueOwnersSchema(input.db)
	const rows = await input.db
		.prepare(
			`SELECT user_id, due_at
			FROM repo_session_due_owners
			WHERE due_at <= ?
			ORDER BY due_at ASC, user_id ASC
			LIMIT ?`,
		)
		.bind(
			(input.now ?? new Date()).toISOString(),
			input.limit ?? repoSessionDueOwnerBatchSize,
		)
		.all<{ user_id: OwnerId; due_at: string }>()
	return (rows.results ?? []).map((row) => ({
		userId: row.user_id,
		dueAt: row.due_at,
	}))
}

export async function listRepoSessionDueOwnersPage(input: {
	db: D1Database
	afterUserId?: string
	limit?: number
}): Promise<Array<RepoSessionDueOwner>> {
	await ensureRepoSessionDueOwnersSchema(input.db)
	const rows = await input.db
		.prepare(
			`SELECT user_id, due_at
			FROM repo_session_due_owners
			WHERE user_id > ?
			ORDER BY user_id ASC
			LIMIT ?`,
		)
		.bind(input.afterUserId ?? '', input.limit ?? repoSessionDueOwnerBatchSize)
		.all<{ user_id: OwnerId; due_at: string }>()
	return (rows.results ?? []).map((row) => ({
		userId: row.user_id,
		dueAt: row.due_at,
	}))
}

export async function deferRepoSessionDueOwner(input: {
	db: D1Database
	userId: string
	error: unknown
	now?: Date
}): Promise<void> {
	const now = input.now ?? new Date()
	await ensureRepoSessionDueOwnersSchema(input.db)
	await input.db
		.prepare(
			`UPDATE repo_session_due_owners
			SET due_at = ?, updated_at = ?
			WHERE user_id = ?`,
		)
		.bind(
			new Date(now.getTime() + repoSessionDueOwnerFailureDelayMs).toISOString(),
			now.toISOString(),
			input.userId,
		)
		.run()
	console.warn(
		JSON.stringify({
			message: 'repo session due-owner deferred',
			userId: input.userId,
			error: getErrorMessage(input.error),
		}),
	)
}

const ensureRepoSessionDueOwnersSchemaEffect = Effect.fn(
	'RepoSessionDueOwners.ensureSchema',
)(function* () {
	const d1 = yield* D1
	yield* d1.batch('repo_session_due_owners.ensure_schema', [
		sql(
			`CREATE TABLE IF NOT EXISTS repo_session_due_owners (
				user_id TEXT PRIMARY KEY NOT NULL,
				due_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		),
		sql(
			`CREATE INDEX IF NOT EXISTS idx_repo_session_due_owners_due_at
			ON repo_session_due_owners(due_at, user_id)`,
		),
	])
})

const DueOwnerRow = Schema.Struct({
	user_id: Schema.String,
	due_at: Schema.String,
})

const nowOrClock = (now: Date | undefined) =>
	now
		? Effect.succeed(now)
		: Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis))

export const listDueRepoSessionOwnersEffect = Effect.fn(
	'RepoSessionDueOwners.listDue',
)(function* (input: { now?: Date; limit?: number }) {
	const d1 = yield* D1
	const now = yield* nowOrClock(input.now)
	yield* ensureRepoSessionDueOwnersSchemaEffect()
	const rows = yield* d1.all(
		'repo_session_due_owners.list_due',
		DueOwnerRow,
		sql(
			`SELECT user_id, due_at
			FROM repo_session_due_owners
			WHERE due_at <= ?
			ORDER BY due_at ASC, user_id ASC
			LIMIT ?`,
			now.toISOString(),
			input.limit ?? repoSessionDueOwnerBatchSize,
		),
	)
	return rows.map((row): RepoSessionDueOwner => ({
		userId: ownerIdFromStored(row.user_id),
		dueAt: row.due_at,
	}))
})

export const deferRepoSessionDueOwnerEffect = Effect.fn(
	'RepoSessionDueOwners.defer',
)(function* (input: { userId: string; error: unknown; now?: Date }) {
	const d1 = yield* D1
	const now = yield* nowOrClock(input.now)
	yield* ensureRepoSessionDueOwnersSchemaEffect()
	yield* d1.run(
		'repo_session_due_owners.defer',
		sql(
			`UPDATE repo_session_due_owners
			SET due_at = ?, updated_at = ?
			WHERE user_id = ?`,
			new Date(now.getTime() + repoSessionDueOwnerFailureDelayMs).toISOString(),
			now.toISOString(),
			input.userId,
		),
	)
	console.warn(
		JSON.stringify({
			message: 'repo session due-owner deferred',
			userId: input.userId,
			error: getErrorMessage(input.error),
		}),
	)
})
