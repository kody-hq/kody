import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	chunkArray,
	maxD1BoundParameters,
} from '@kody-internal/shared/chunk.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import {
	repoSessionIndexNamespace,
	type RepoSessionIndexEnv,
} from './repo-session-index-client.ts'
import { deleteRepoSessionsBySourceForUser } from './repo-sessions.ts'
import {
	type EntityKind,
	type EntitySourceRow,
	entitySourceRowSchema,
} from './types.ts'

import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
function mapEntitySourceRow(row: Record<string, unknown>): EntitySourceRow {
	const userId = String(row['user_id']) as OwnerId
	const parsed = entitySourceRowSchema.parse({
		id: String(row['id']),
		user_id: userId,
		entity_kind: String(row['entity_kind']),
		entity_id: String(row['entity_id']),
		repo_id: String(row['repo_id']),
		published_commit:
			row['published_commit'] == null ? null : String(row['published_commit']),
		indexed_commit:
			row['indexed_commit'] == null ? null : String(row['indexed_commit']),
		manifest_path: String(row['manifest_path']),
		source_root: String(row['source_root']),
		last_external_check_at:
			row['last_external_check_at'] == null
				? null
				: String(row['last_external_check_at']),
		external_check_until:
			row['external_check_until'] == null
				? null
				: String(row['external_check_until']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
	})
	return { ...parsed, user_id: userId }
}

export async function insertEntitySource(
	db: D1Database,
	row: EntitySourceRow,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, published_commit, indexed_commit,
				manifest_path, source_root, last_external_check_at, external_check_until,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.user_id,
			row.entity_kind,
			row.entity_id,
			row.repo_id,
			row.published_commit,
			row.indexed_commit,
			row.manifest_path,
			row.source_root,
			row.last_external_check_at,
			row.external_check_until,
			row.created_at,
			row.updated_at,
		)
		.run()
}

export async function getEntitySourceById(
	db: D1Database,
	id: string,
): Promise<EntitySourceRow | null> {
	const result = await db
		.prepare(
			`SELECT * FROM entity_sources WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(id)
		.first<Record<string, unknown>>()
	return result ? mapEntitySourceRow(result) : null
}

export async function listEntitySourcesByIds(
	db: D1Database,
	ids: ReadonlyArray<string>,
): Promise<Array<EntitySourceRow>> {
	if (ids.length === 0) return []
	const uniqueIds = [...new Set(ids)]
	const sources: Array<EntitySourceRow> = []
	for (const idChunk of chunkArray(uniqueIds, maxD1BoundParameters)) {
		const placeholders = idChunk.map(() => '?').join(', ')
		const { results } = await db
			.prepare(
				`SELECT * FROM entity_sources WHERE id IN (${placeholders})${andLiveDeletedAtSql()}`,
			)
			.bind(...idChunk)
			.all<Record<string, unknown>>()
		for (const row of results ?? []) {
			sources.push(mapEntitySourceRow(row))
		}
	}
	return sources
}

export async function getEntitySourceByIdForUser(
	db: D1Database,
	input: {
		id: string
		userId: OwnerId
	},
): Promise<EntitySourceRow | null> {
	const result = await db
		.prepare(
			`SELECT * FROM entity_sources WHERE id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.id, input.userId)
		.first<Record<string, unknown>>()
	return result ? mapEntitySourceRow(result) : null
}

/**
 * Batch form of {@link getEntitySourceByIdForUser}: same user_id and
 * deleted_at filters, chunked IN lists for D1 bound-parameter limits.
 */
export async function listEntitySourcesByIdsForUser(
	db: D1Database,
	input: {
		userId: OwnerId
		ids: ReadonlyArray<string>
	},
): Promise<Array<EntitySourceRow>> {
	if (input.ids.length === 0) return []
	const uniqueIds = [...new Set(input.ids)]
	const sources: Array<EntitySourceRow> = []
	for (const idChunk of chunkArray(uniqueIds, maxD1BoundParameters - 1)) {
		const placeholders = idChunk.map(() => '?').join(', ')
		const { results } = await db
			.prepare(
				`SELECT * FROM entity_sources WHERE user_id = ? AND id IN (${placeholders})${andLiveDeletedAtSql()}`,
			)
			.bind(input.userId, ...idChunk)
			.all<Record<string, unknown>>()
		for (const row of results ?? []) {
			sources.push(mapEntitySourceRow(row))
		}
	}
	return sources
}

export async function getEntitySourceByEntity(
	db: D1Database,
	input: {
		userId: OwnerId
		entityKind: EntityKind
		entityId: string
	},
): Promise<EntitySourceRow | null> {
	const result = await db
		.prepare(
			`SELECT * FROM entity_sources
			WHERE user_id = ? AND entity_kind = ? AND entity_id = ?
			${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(input.userId, input.entityKind, input.entityId)
		.first<Record<string, unknown>>()
	return result ? mapEntitySourceRow(result) : null
}

export async function getEntitySourceByRepoId(
	db: D1Database,
	repoId: string,
): Promise<EntitySourceRow | null> {
	const result = await db
		.prepare(
			`SELECT * FROM entity_sources WHERE repo_id = ? ${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(repoId)
		.first<Record<string, unknown>>()
	return result ? mapEntitySourceRow(result) : null
}

export async function listEntitySourcesByUser(
	db: D1Database,
	userId: OwnerId,
): Promise<Array<EntitySourceRow>> {
	const { results } = await db
		.prepare(
			`SELECT * FROM entity_sources
			WHERE user_id = ?${andLiveDeletedAtSql()}
			ORDER BY updated_at DESC, created_at DESC`,
		)
		.bind(userId)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapEntitySourceRow)
}

export async function updateEntitySource(
	db: D1Database,
	input: {
		id: string
		userId: OwnerId
		repoId?: string
		publishedCommit?: string | null
		indexedCommit?: string | null
		manifestPath?: string
		sourceRoot?: string
		lastExternalCheckAt?: string | null
		externalCheckUntil?: string | null
		entityKind?: EntityKind
		entityId?: string
	},
): Promise<boolean> {
	const assignments: Array<string> = []
	const values: Array<unknown> = []
	const add = (column: string, value: unknown) => {
		assignments.push(`${column} = ?`)
		values.push(value)
	}
	if (input.repoId !== undefined) add('repo_id', input.repoId)
	if (input.entityKind !== undefined) add('entity_kind', input.entityKind)
	if (input.entityId !== undefined) add('entity_id', input.entityId)
	if (input.publishedCommit !== undefined) {
		add('published_commit', input.publishedCommit)
	}
	if (input.indexedCommit !== undefined)
		add('indexed_commit', input.indexedCommit)
	if (input.manifestPath !== undefined) add('manifest_path', input.manifestPath)
	if (input.sourceRoot !== undefined) add('source_root', input.sourceRoot)
	if (input.lastExternalCheckAt !== undefined) {
		add('last_external_check_at', input.lastExternalCheckAt)
	}
	if (input.externalCheckUntil !== undefined) {
		add('external_check_until', input.externalCheckUntil)
	}
	add('updated_at', new Date().toISOString())
	const result = await runD1WithRetry(() =>
		db
			.prepare(
				`UPDATE entity_sources
			SET ${assignments.join(', ')}
			WHERE id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
			)
			.bind(...values, input.id, input.userId)
			.run(),
	)
	return (result.meta.changes ?? 0) > 0
}

export async function upsertEntitySource(
	db: D1Database,
	row: EntitySourceRow,
): Promise<void> {
	const existing = await getEntitySourceByEntity(db, {
		userId: row.user_id,
		entityKind: row.entity_kind,
		entityId: row.entity_id,
	})
	if (existing) {
		await updateEntitySource(db, {
			id: existing.id,
			userId: row.user_id,
			repoId: row.repo_id,
			publishedCommit: row.published_commit,
			indexedCommit: row.indexed_commit,
			manifestPath: row.manifest_path,
			sourceRoot: row.source_root,
		})
		return
	}
	await insertEntitySource(db, row)
}

export const externalReconcileGraceMs = 60 * 60 * 1000

export async function markEntitySourcePendingExternalReconcile(
	db: D1Database,
	input: {
		id: string
		userId: OwnerId
		tokenExpiresAt: string
	},
): Promise<boolean> {
	const checkUntil = new Date(
		new Date(input.tokenExpiresAt).getTime() + externalReconcileGraceMs,
	).toISOString()
	const updatedAt = new Date().toISOString()
	const result = await runD1WithRetry(() =>
		db
			.prepare(
				`UPDATE entity_sources
				SET external_check_until = CASE
						WHEN external_check_until IS NULL OR external_check_until < ?
							THEN ?
						ELSE external_check_until
					END,
					updated_at = ?
				WHERE id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
			)
			.bind(checkUntil, checkUntil, updatedAt, input.id, input.userId)
			.run(),
	)
	return (result.meta.changes ?? 0) > 0
}

/**
 * Keyset cursor over the reconcile ordering used by
 * {@link listEntitySourcesForExternalReconcile}: the coalesced
 * `last_external_check_at`/`created_at` value of the last row in the previous
 * batch, with the row id as a tie-breaker.
 */
export type ExternalReconcileCursor = {
	staleOrderedAt: string
	id: string
}

export async function listEntitySourcesForExternalReconcile(
	db: D1Database,
	input: {
		before: string
		limit: number
		after?: ExternalReconcileCursor
		includeAll?: boolean
	},
): Promise<Array<EntitySourceRow>> {
	// The `after` keyset lets callers page strictly forward within one pass
	// even when a row's `last_external_check_at` write fails and the row would
	// otherwise stay at the head of the stale ordering.
	const afterClause = input.after
		? `AND (
				COALESCE(last_external_check_at, created_at) > ?
				OR (COALESCE(last_external_check_at, created_at) = ? AND id > ?)
			)`
		: ''
	const pendingClause = input.includeAll
		? ''
		: `AND external_check_until IS NOT NULL
				AND (last_external_check_at IS NULL OR last_external_check_at < ?)`
	const bindings: Array<string | number> = input.includeAll
		? []
		: [input.before]
	if (input.after) {
		bindings.push(
			input.after.staleOrderedAt,
			input.after.staleOrderedAt,
			input.after.id,
		)
	}
	bindings.push(input.limit)
	const { results } = await db
		.prepare(
			`SELECT * FROM entity_sources
			WHERE entity_kind = 'package'
				${pendingClause}
				${afterClause}${andLiveDeletedAtSql()}
			ORDER BY COALESCE(last_external_check_at, created_at) ASC, id ASC
			LIMIT ?`,
		)
		.bind(...bindings)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapEntitySourceRow)
}

export async function deleteEntitySource(
	env: { APP_DB: D1Database } & Partial<RepoSessionIndexEnv>,
	input: {
		id: string
		userId: OwnerId
	},
): Promise<boolean> {
	if (repoSessionIndexNamespace(env as RepoSessionIndexEnv)) {
		await deleteRepoSessionsBySourceForUser(env as RepoSessionIndexEnv, {
			userId: input.userId,
			sourceId: input.id,
		})
	}
	const result = await env.APP_DB.prepare(
		`DELETE FROM entity_sources WHERE id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(input.id, input.userId)
		.run()
	return (result.meta.changes ?? 0) > 0
}
