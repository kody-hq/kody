import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	chunkArray,
	maxD1BoundParameters,
} from '@kody-internal/shared/chunk.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	type McpMemoryConversationSuppressionRow,
	type McpMemoryRow,
} from './types.ts'

function mapMemoryRow(row: Record<string, unknown>): McpMemoryRow {
	return {
		id: String(row['id']),
		user_id: String(row['user_id']) as OwnerId,
		category: row['category'] == null ? null : String(row['category']),
		status: String(row['status']) as McpMemoryRow['status'],
		subject: String(row['subject']),
		summary: String(row['summary']),
		details: String(row['details'] ?? ''),
		tags_json: String(row['tags_json'] ?? '[]'),
		source_uris_json: String(row['source_uris_json'] ?? '[]'),
		dedupe_key: row['dedupe_key'] == null ? null : String(row['dedupe_key']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
		last_accessed_at:
			row['last_accessed_at'] == null ? null : String(row['last_accessed_at']),
		deleted_at: row['deleted_at'] == null ? null : String(row['deleted_at']),
	}
}

function mapSuppressionRow(
	row: Record<string, unknown>,
): McpMemoryConversationSuppressionRow {
	return {
		user_id: String(row['user_id']),
		conversation_id: String(row['conversation_id']),
		memory_id: String(row['memory_id']),
		created_at: String(row['created_at']),
		last_seen_at: String(row['last_seen_at']),
		expires_at: String(row['expires_at']),
	}
}

export async function insertMemory(
	db: D1Database,
	row: Omit<McpMemoryRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	},
): Promise<void> {
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, category, status, subject, summary, details, tags_json,
				source_uris_json, dedupe_key, created_at, updated_at, last_accessed_at, deleted_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.user_id,
			row.category,
			row.status,
			row.subject,
			row.summary,
			row.details,
			row.tags_json,
			row.source_uris_json,
			row.dedupe_key,
			row.created_at ?? now,
			row.updated_at ?? now,
			row.last_accessed_at,
			row.deleted_at,
		)
		.run()
}

export async function getMemoryById(
	db: D1Database,
	userId: string,
	memoryId: string,
	options?: { includeDeleted?: boolean },
): Promise<McpMemoryRow | null> {
	const row = await db
		.prepare(
			`SELECT id, user_id, category, status, subject, summary, details, tags_json,
				source_uris_json, dedupe_key, created_at, updated_at, last_accessed_at, deleted_at
			FROM mcp_memories
			WHERE user_id = ? AND id = ? AND (deleted_at IS NULL OR ? = 1)
			LIMIT 1`,
		)
		.bind(userId, memoryId, options?.includeDeleted === true ? 1 : 0)
		.first<Record<string, unknown>>()
	return row ? mapMemoryRow(row) : null
}

export async function updateMemory(
	db: D1Database,
	userId: string,
	memoryId: string,
	fields: {
		category: string | null
		status: McpMemoryRow['status']
		subject: string
		summary: string
		details: string
		tags_json: string
		source_uris_json: string
		dedupe_key: string | null
		last_accessed_at: string | null
		deleted_at: string | null
	},
): Promise<boolean> {
	const out = await db
		.prepare(
			`UPDATE mcp_memories SET
				category = ?,
				status = ?,
				subject = ?,
				summary = ?,
				details = ?,
				tags_json = ?,
				source_uris_json = ?,
				dedupe_key = ?,
				last_accessed_at = ?,
				deleted_at = ?,
				updated_at = ?
			WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(
			fields.category,
			fields.status,
			fields.subject,
			fields.summary,
			fields.details,
			fields.tags_json,
			fields.source_uris_json,
			fields.dedupe_key,
			fields.last_accessed_at,
			fields.deleted_at,
			new Date().toISOString(),
			userId,
			memoryId,
		)
		.run()
	return (out.meta.changes ?? 0) > 0
}

export async function deleteMemory(
	db: D1Database,
	userId: string,
	memoryId: string,
	options?: { force?: boolean },
): Promise<boolean> {
	const out = await db
		.prepare(
			`DELETE FROM mcp_memories WHERE user_id = ? AND id = ? AND (deleted_at IS NULL OR ? = 1)`,
		)
		.bind(userId, memoryId, options?.force === true ? 1 : 0)
		.run()
	return (out.meta.changes ?? 0) > 0
}

export async function listMemoriesByUserId(
	db: D1Database,
	userId: string,
	options?: {
		includeDeleted?: boolean
		statuses?: Array<McpMemoryRow['status']>
		limit?: number
	},
): Promise<Array<McpMemoryRow>> {
	const statuses =
		options?.statuses && options.statuses.length > 0 ? options.statuses : null
	const statusClause = statuses
		? `AND status IN (${statuses.map(() => '?').join(', ')})`
		: ''
	const limit = options?.limit ?? 100
	const { results } = await db
		.prepare(
			`SELECT id, user_id, category, status, subject, summary, details, tags_json,
				source_uris_json, dedupe_key, created_at, updated_at, last_accessed_at, deleted_at
			FROM mcp_memories
			WHERE user_id = ? AND (deleted_at IS NULL OR ? = 1)
				${statusClause}
			ORDER BY updated_at DESC
			LIMIT ?`,
		)
		.bind(
			userId,
			options?.includeDeleted === true ? 1 : 0,
			...(statuses ?? []),
			limit,
		)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapMemoryRow)
}

/**
 * Keyset-paged listing of one user's memories. The account memories export
 * uses this so a single query never loads the whole table.
 */
export async function listMemoriesByUserIdPage(input: {
	db: D1Database
	userId: string
	afterId: string | null
	limit: number
	includeDeleted?: boolean
	statuses?: Array<McpMemoryRow['status']>
}): Promise<Array<McpMemoryRow>> {
	const statuses =
		input.statuses && input.statuses.length > 0 ? input.statuses : null
	const statusClause = statuses
		? `AND status IN (${statuses.map(() => '?').join(', ')})`
		: ''
	const { results } = await input.db
		.prepare(
			`SELECT id, user_id, category, status, subject, summary, details, tags_json,
				source_uris_json, dedupe_key, created_at, updated_at, last_accessed_at, deleted_at
			FROM mcp_memories
			WHERE user_id = ? AND (deleted_at IS NULL OR ? = 1)
				AND id > ?
				${statusClause}
			ORDER BY id
			LIMIT ?`,
		)
		.bind(
			input.userId,
			input.includeDeleted === true ? 1 : 0,
			input.afterId ?? '',
			...(statuses ?? []),
			input.limit,
		)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapMemoryRow)
}

export async function listMemoriesByIds(
	db: D1Database,
	userId: string,
	options: {
		ids: Array<string>
		statuses?: Array<McpMemoryRow['status']>
	},
): Promise<Array<McpMemoryRow>> {
	if (options.ids.length === 0) return []
	const statuses =
		options.statuses && options.statuses.length > 0 ? options.statuses : null
	const statusClause = statuses
		? `AND status IN (${statuses.map(() => '?').join(', ')})`
		: ''
	// The id list can be a full vector top-k page (100 ids); with the userId
	// and status bindings on top that exceeds D1's per-statement parameter
	// cap, so the IN list must be chunked.
	const fixedBindings = 1 + (statuses?.length ?? 0)
	const rows: Array<McpMemoryRow> = []
	for (const chunk of chunkArray(
		options.ids,
		maxD1BoundParameters - fixedBindings,
	)) {
		const idPlaceholders = chunk.map(() => '?').join(', ')
		const { results } = await db
			.prepare(
				`SELECT id, user_id, category, status, subject, summary, details, tags_json,
					source_uris_json, dedupe_key, created_at, updated_at, last_accessed_at, deleted_at
				FROM mcp_memories
				WHERE user_id = ?${andLiveDeletedAtSql()}
					AND id IN (${idPlaceholders})
					${statusClause}`,
			)
			.bind(userId, ...chunk, ...(statuses ?? []))
			.all<Record<string, unknown>>()
		rows.push(...(results ?? []).map(mapMemoryRow))
	}
	return rows
}

// Keyset-paged listing across all users, used by maintenance reindex so a
// single query never loads the whole table. Pass the last row id of the
// previous page (or null for the first page).
export async function listMemoriesPage(input: {
	db: D1Database
	afterId: string | null
	limit: number
}): Promise<Array<McpMemoryRow>> {
	const { results } = await input.db
		.prepare(
			`SELECT id, user_id, category, status, subject, summary, details, tags_json,
				source_uris_json, dedupe_key, created_at, updated_at, last_accessed_at, deleted_at
			FROM mcp_memories
			WHERE id > ?${andLiveDeletedAtSql()}
			ORDER BY id
			LIMIT ?`,
		)
		.bind(input.afterId ?? '', input.limit)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapMemoryRow)
}

function touchMemoryAccessedAtStatement(
	db: D1Database,
	userId: string,
	memoryIds: Array<string>,
	timestamp: string,
) {
	const placeholders = memoryIds.map(() => '?').join(', ')
	return db
		.prepare(
			`UPDATE mcp_memories
			SET last_accessed_at = ?, updated_at = updated_at
			WHERE user_id = ? AND id IN (${placeholders})${andLiveDeletedAtSql()}`,
		)
		.bind(timestamp, userId, ...memoryIds)
}

export async function touchMemoryAccessedAt(
	db: D1Database,
	userId: string,
	memoryIds: Array<string>,
	timestamp?: string,
) {
	if (memoryIds.length === 0) return
	const touchedAt = timestamp ?? new Date().toISOString()
	await touchMemoryAccessedAtStatement(db, userId, memoryIds, touchedAt).run()
}

export async function getConversationSuppressions(input: {
	db: D1Database
	userId: string
	conversationId: string
	now?: string
}): Promise<Array<McpMemoryConversationSuppressionRow>> {
	const now = input.now ?? new Date().toISOString()
	const { results } = await input.db
		.prepare(
			`SELECT user_id, conversation_id, memory_id, created_at, last_seen_at, expires_at
			FROM mcp_memory_conversation_suppressions
			WHERE user_id = ? AND conversation_id = ? AND expires_at > ?`,
		)
		.bind(input.userId, input.conversationId, now)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapSuppressionRow)
}

const conversationSuppressionUpsertSql = `INSERT INTO mcp_memory_conversation_suppressions (
					user_id, conversation_id, memory_id, created_at, last_seen_at, expires_at
				) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(user_id, conversation_id, memory_id)
				DO UPDATE SET
					last_seen_at = excluded.last_seen_at,
					expires_at = excluded.expires_at`

function conversationSuppressionUpsertStatements(input: {
	db: D1Database
	userId: string
	conversationId: string
	memoryIds: Array<string>
	expiresAt: string
	now: string
}) {
	return input.memoryIds.map((memoryId) =>
		input.db
			.prepare(conversationSuppressionUpsertSql)
			.bind(
				input.userId,
				input.conversationId,
				memoryId,
				input.now,
				input.now,
				input.expiresAt,
			),
	)
}

export async function upsertConversationSuppressions(input: {
	db: D1Database
	userId: string
	conversationId: string
	memoryIds: Array<string>
	expiresAt: string
	now?: string
}) {
	if (input.memoryIds.length === 0) return
	const now = input.now ?? new Date().toISOString()
	await input.db.batch(
		conversationSuppressionUpsertStatements({
			db: input.db,
			userId: input.userId,
			conversationId: input.conversationId,
			memoryIds: input.memoryIds,
			expiresAt: input.expiresAt,
			now,
		}),
	)
}

/**
 * Atomically upsert conversation suppressions and touch last_accessed_at in one
 * D1 batch so acknowledgement cannot partially suppress.
 */
export async function acknowledgeSurfacedMemoryWrites(input: {
	db: D1Database
	userId: string
	conversationId: string
	memoryIds: Array<string>
	expiresAt: string
	now?: string
}) {
	if (input.memoryIds.length === 0) return
	const now = input.now ?? new Date().toISOString()
	await input.db.batch([
		...conversationSuppressionUpsertStatements({
			db: input.db,
			userId: input.userId,
			conversationId: input.conversationId,
			memoryIds: input.memoryIds,
			expiresAt: input.expiresAt,
			now,
		}),
		touchMemoryAccessedAtStatement(
			input.db,
			input.userId,
			input.memoryIds,
			now,
		),
	])
}

export async function pruneExpiredConversationSuppressions(
	db: D1Database,
	now?: string,
) {
	const cutoff = now ?? new Date().toISOString()
	await db
		.prepare(
			`DELETE FROM mcp_memory_conversation_suppressions
			WHERE expires_at <= ?`,
		)
		.bind(cutoff)
		.run()
}
