import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { isValidKodyInstanceName } from '@kody-internal/shared/stable-name.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export type UserRepoRow = {
	id: string
	user_id: OwnerId
	name: string
	description: string | null
	is_private: 0 | 1
	created_at: string
	updated_at: string
}

export type UserRepoRecord = {
	id: string
	userId: OwnerId
	name: string
	description: string | null
	isPrivate: boolean
	createdAt: string
	updatedAt: string
}

export const plainRepoPromotionNotice =
	'This repo exists but is not a package — promote it with repoPromoteToPackage.'

export const plainRepoPackageShapedNotice =
	'Root package.json detected at HEAD. Promote with repoPromoteToPackage to activate package runtime surfaces.'

const userRepoSelectColumns = `user_repos.id, user_repos.user_id, user_repos.name,
	user_repos.description, user_repos.is_private, user_repos.created_at,
	user_repos.updated_at`

function mapUserRepoRow(row: Record<string, unknown>): UserRepoRecord {
	return {
		id: String(row['id']),
		userId: String(row['user_id']) as OwnerId,
		name: String(row['name']),
		description: row['description'] == null ? null : String(row['description']),
		isPrivate:
			row['is_private'] === 1 ||
			row['is_private'] === '1' ||
			row['is_private'] === true ||
			row['is_private'] == null,
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

export function normalizeUserRepoName(name: string) {
	return name.trim().toLowerCase()
}

export function assertValidUserRepoName(name: string) {
	const normalized = normalizeUserRepoName(name)
	if (!normalized) {
		throw new Error('Repo name is required.')
	}
	if (!isValidKodyInstanceName(normalized)) {
		throw new Error(
			'Repo name must use lowercase letters, numbers, and dashes; start and end with a letter or number; and be at most 64 characters.',
		)
	}
	return normalized
}

export async function insertUserRepo(
	db: D1Database,
	row: Omit<UserRepoRow, 'created_at' | 'updated_at' | 'is_private'> & {
		created_at?: string
		updated_at?: string
		is_private?: 0 | 1
	},
) {
	const now = new Date().toISOString()
	// Writer contract: names are stored normalized so getUserRepoByName's
	// normalized lookups always match, regardless of caller.
	const name = assertValidUserRepoName(row.name)
	await db
		.prepare(
			`INSERT INTO user_repos (
				id, user_id, name, description, is_private, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.user_id,
			name,
			row.description,
			row.is_private ?? 1,
			row.created_at ?? now,
			row.updated_at ?? now,
		)
		.run()
}

export async function getUserRepoById(
	db: D1Database,
	input: { userId: string; repoId: string },
): Promise<UserRepoRecord | null> {
	const row = await db
		.prepare(
			`SELECT ${userRepoSelectColumns}
			FROM user_repos
			WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.userId, input.repoId)
		.first<Record<string, unknown>>()
	return row ? mapUserRepoRow(row) : null
}

/**
 * A live repo by id in whichever org owns it. Only for facts that belong
 * to the repo itself (its name and visibility), never as an access decision.
 */
export async function getUserRepoByIdInAnyOrg(
	db: D1Database,
	repoId: string,
): Promise<UserRepoRecord | null> {
	const row = await db
		.prepare(
			`SELECT ${userRepoSelectColumns}
			FROM user_repos
			WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(repoId)
		.first<Record<string, unknown>>()
	return row ? mapUserRepoRow(row) : null
}

export async function getUserRepoByName(
	db: D1Database,
	input: { userId: string; name: string },
): Promise<UserRepoRecord | null> {
	const normalized = normalizeUserRepoName(input.name)
	const row = await db
		.prepare(
			`SELECT ${userRepoSelectColumns}
			FROM user_repos
			WHERE user_id = ? AND name = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.userId, normalized)
		.first<Record<string, unknown>>()
	return row ? mapUserRepoRow(row) : null
}

export type UserRepoListRecord = UserRepoRecord & {
	iconCommit: string | null
}

export async function listUserRepos(
	db: D1Database,
	userId: string,
): Promise<Array<UserRepoListRecord>> {
	const result = await db
		.prepare(
			`SELECT ${userRepoSelectColumns},
				entity_sources.indexed_commit AS indexed_commit,
				entity_sources.published_commit AS published_commit
			FROM user_repos
			LEFT JOIN entity_sources
				ON entity_sources.user_id = user_repos.user_id
				AND entity_sources.entity_kind = 'repo'
				AND entity_sources.entity_id = user_repos.id${andLiveDeletedAtSql('entity_sources')}
			WHERE user_repos.user_id = ?${andLiveDeletedAtSql('user_repos')}
			ORDER BY user_repos.name ASC`,
		)
		.bind(userId)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map((row) => ({
		...mapUserRepoRow(row),
		iconCommit:
			row['indexed_commit'] == null
				? row['published_commit'] == null
					? null
					: String(row['published_commit'])
				: String(row['indexed_commit']),
	}))
}

export async function updateUserRepo(
	db: D1Database,
	input: {
		userId: string
		repoId: string
		isPrivate?: boolean
		description?: string | null
	},
): Promise<boolean> {
	const assignments: Array<string> = ['updated_at = ?']
	const values: Array<string | number | null> = [new Date().toISOString()]
	if (input.isPrivate !== undefined) {
		assignments.push('is_private = ?')
		values.push(input.isPrivate ? 1 : 0)
	}
	if (input.description !== undefined) {
		assignments.push('description = ?')
		values.push(input.description)
	}
	if (assignments.length === 1) return false
	values.push(input.userId, input.repoId)
	const result = await db
		.prepare(
			`UPDATE user_repos
			SET ${assignments.join(', ')}
			WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(...values)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function deleteUserRepo(
	db: D1Database,
	input: { userId: string; repoId: string },
): Promise<boolean> {
	const result = await db
		.prepare(
			`DELETE FROM user_repos WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.userId, input.repoId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function renameUserRepo(
	db: D1Database,
	input: { userId: string; repoId: string; name: string },
): Promise<boolean> {
	const name = assertValidUserRepoName(input.name)
	const result = await db
		.prepare(
			`UPDATE user_repos
			SET name = ?, updated_at = ?
			WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(name, new Date().toISOString(), input.userId, input.repoId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/**
 * Cheap miss-path helper: when a saved-package lookup fails, check whether a
 * plain repo with the same bare name exists for promotion guidance.
 */
export async function findPlainRepoPromotionHint(
	db: D1Database,
	input: { userId: string; packageIdOrKodyId: string },
): Promise<UserRepoRecord | null> {
	const trimmed = input.packageIdOrKodyId.trim()
	if (!trimmed) return null
	const scopedSuffix = trimmed.includes('/')
		? trimmed.split('/').pop()?.trim()
		: trimmed
	if (!scopedSuffix) return null
	const byName = await getUserRepoByName(db, {
		userId: input.userId,
		name: scopedSuffix,
	})
	if (byName) return byName
	return await getUserRepoById(db, {
		userId: input.userId,
		repoId: trimmed,
	})
}

export function buildPlainRepoPromotionErrorMessage(packageIdOrKodyId: string) {
	return `${plainRepoPromotionNotice} (lookup: ${JSON.stringify(packageIdOrKodyId)}).`
}
