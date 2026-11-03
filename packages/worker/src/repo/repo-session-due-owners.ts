import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'

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
