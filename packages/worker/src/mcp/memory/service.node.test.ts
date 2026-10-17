import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	CAPABILITY_EMBEDDING_DIMENSIONS,
	deterministicEmbedding,
} from '#worker/vectorize/embedding.ts'
import {
	createInMemoryUserMeterEnv,
	createPermissiveAccountWriteLeaseDbHooks,
} from '#worker/test-support/user-meter.ts'

vi.mock('#worker/orgs/is-personal-org.ts', () => ({
	// This suite uses an in-memory fake DB without a users table; freeze
	// behavior is covered in memory-owner.node.test.ts.
	isPersonalOrg: async () => true,
}))

import { rankMemoryVectorIdsWithin } from './memory-search.ts'
import {
	acknowledgeSurfacedMemories,
	deleteMemory,
	getMemory,
	searchMemoryRecords,
	surfaceRelevantMemories,
	upsertMemory,
	verifyMemoryCandidate,
} from './service.ts'
import {
	type McpMemoryConversationSuppressionRow,
	type McpMemoryRow,
} from './types.ts'

function createMemoryTestDb() {
	const memories = new Map<string, McpMemoryRow>()
	const suppressions = new Map<string, McpMemoryConversationSuppressionRow>()
	const batches: Array<Array<unknown>> = []
	const writeLeaseDb = createPermissiveAccountWriteLeaseDbHooks()

	function suppressionKey(
		userId: string,
		conversationId: string,
		memoryId: string,
	) {
		return `${userId}:${conversationId}:${memoryId}`
	}

	const db = {
		async batch(statements: Array<{ run: () => Promise<unknown> }>) {
			batches.push(statements)
			const results = []
			for (const statement of statements) {
				results.push(await statement.run())
			}
			return results
		},
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T>() {
							if (writeLeaseDb.supportsDeletingAtQuery(query)) {
								return writeLeaseDb.deletingAtFirstResult() as T
							}
							if (
								normalizedQuery.includes('from mcp_memories') &&
								normalizedQuery.includes('where user_id = ? and id = ?')
							) {
								const [userId, memoryId, includeDeleted] = params as [
									string,
									string,
									number,
								]
								const row = memories.get(memoryId)
								if (
									!row ||
									row.user_id !== userId ||
									(row.deleted_at !== null && includeDeleted !== 1)
								)
									return null
								return { ...row } as T
							}
							return null
						},
						async all<T>() {
							if (
								normalizedQuery.includes('from mcp_memories') &&
								normalizedQuery.includes('and id in (')
							) {
								const [userId, ...rest] = params as Array<string>
								const statusValues = new Set(['active', 'archived', 'deleted'])
								const ids = rest.filter((value) => !statusValues.has(value))
								const statuses = rest.filter((value) => statusValues.has(value))
								const rows = [...memories.values()]
									.filter((row) => row.user_id === userId)
									.filter((row) => ids.includes(row.id))
									.filter((row) =>
										statuses.length === 0
											? true
											: statuses.includes(row.status),
									)
									.map((row) => ({ ...row }))
								return { results: rows as Array<T>, meta: { changes: 0 } }
							}
							if (
								normalizedQuery.includes('from mcp_memories') &&
								normalizedQuery.includes('order by updated_at desc')
							) {
								const [userId, ...rest] = params as Array<string | number>
								const limit = Number(rest.at(-1) ?? 100)
								const statusParams = rest.slice(0, -1).filter((value) => {
									return typeof value === 'string'
								}) as Array<string>
								const rows = [...memories.values()]
									.filter((row) => row.user_id === userId)
									.filter((row) =>
										statusParams.length === 0
											? true
											: statusParams.includes(row.status),
									)
									.sort((left, right) =>
										right.updated_at.localeCompare(left.updated_at),
									)
									.slice(0, limit)
									.map((row) => ({ ...row }))
								return { results: rows as Array<T>, meta: { changes: 0 } }
							}
							if (
								normalizedQuery.includes(
									'from mcp_memory_conversation_suppressions',
								)
							) {
								const [userId, conversationId, now] = params as [
									string,
									string,
									string,
								]
								const rows = [...suppressions.values()]
									.filter((row) => row.user_id === userId)
									.filter((row) => row.conversation_id === conversationId)
									.filter((row) => row.expires_at > now)
									.map((row) => ({ ...row }))
								return { results: rows as Array<T>, meta: { changes: 0 } }
							}
							return { results: [] as Array<T>, meta: { changes: 0 } }
						},
						async run() {
							if (normalizedQuery.startsWith('insert into mcp_memories')) {
								const [
									id,
									userId,
									category,
									status,
									subject,
									summary,
									details,
									tagsJson,
									sourceUrisJson,
									dedupeKey,
									createdAt,
									updatedAt,
									lastAccessedAt,
									deletedAt,
								] = params as Array<string | null>
								memories.set(String(id), {
									id: String(id),
									user_id: ownerIdFromStored(String(userId)),
									category: category == null ? null : String(category),
									status: String(status) as McpMemoryRow['status'],
									subject: String(subject),
									summary: String(summary),
									details: String(details ?? ''),
									tags_json: String(tagsJson ?? '[]'),
									source_uris_json: String(sourceUrisJson ?? '[]'),
									dedupe_key: dedupeKey == null ? null : String(dedupeKey),
									created_at: String(createdAt),
									updated_at: String(updatedAt),
									last_accessed_at:
										lastAccessedAt == null ? null : String(lastAccessedAt),
									deleted_at: deletedAt == null ? null : String(deletedAt),
								})
								return { meta: { changes: 1 } }
							}
							if (normalizedQuery.startsWith('update mcp_memories set')) {
								if (normalizedQuery.includes('where user_id = ? and id = ?')) {
									const [
										category,
										status,
										subject,
										summary,
										details,
										tagsJson,
										sourceUrisJson,
										dedupeKey,
										lastAccessedAt,
										deletedAt,
										updatedAt,
										userId,
										memoryId,
									] = params as Array<string | null>
									const existing = memories.get(String(memoryId))
									if (!existing || existing.user_id !== userId) {
										return { meta: { changes: 0 } }
									}
									memories.set(String(memoryId), {
										...existing,
										category: category == null ? null : String(category),
										status: String(status) as McpMemoryRow['status'],
										subject: String(subject),
										summary: String(summary),
										details: String(details ?? ''),
										tags_json: String(tagsJson ?? '[]'),
										source_uris_json: String(sourceUrisJson ?? '[]'),
										dedupe_key: dedupeKey == null ? null : String(dedupeKey),
										last_accessed_at:
											lastAccessedAt == null ? null : String(lastAccessedAt),
										deleted_at: deletedAt == null ? null : String(deletedAt),
										updated_at: String(updatedAt),
									})
									return { meta: { changes: 1 } }
								}
								if (
									normalizedQuery.includes(
										'set last_accessed_at = ?, updated_at = updated_at',
									)
								) {
									const [lastAccessedAt, userId, ...memoryIds] = params as [
										string,
										string,
										...Array<string>,
									]
									let changes = 0
									for (const memoryId of memoryIds) {
										const existing = memories.get(memoryId)
										if (!existing || existing.user_id !== userId) continue
										memories.set(memoryId, {
											...existing,
											last_accessed_at: lastAccessedAt,
										})
										changes += 1
									}
									return { meta: { changes } }
								}
							}
							if (normalizedQuery.startsWith('delete from mcp_memories')) {
								const [userId, memoryId, force] = params as [
									string,
									string,
									number,
								]
								const existing = memories.get(memoryId)
								if (
									!existing ||
									existing.user_id !== userId ||
									(existing.deleted_at !== null && force !== 1)
								) {
									return { meta: { changes: 0 } }
								}
								memories.delete(memoryId)
								return { meta: { changes: 1 } }
							}
							if (
								normalizedQuery.startsWith(
									'insert into mcp_memory_conversation_suppressions',
								)
							) {
								const [
									userId,
									conversationId,
									memoryId,
									createdAt,
									lastSeenAt,
									expiresAt,
								] = params as [string, string, string, string, string, string]
								suppressions.set(
									suppressionKey(userId, conversationId, memoryId),
									{
										user_id: userId,
										conversation_id: conversationId,
										memory_id: memoryId,
										created_at: createdAt,
										last_seen_at: lastSeenAt,
										expires_at: expiresAt,
									},
								)
								return { meta: { changes: 1 } }
							}
							if (
								normalizedQuery.startsWith(
									'delete from mcp_memory_conversation_suppressions',
								)
							) {
								if (normalizedQuery.includes('where expires_at <= ?')) {
									const [cutoff] = params as [string]
									let changes = 0
									for (const [key, row] of suppressions.entries()) {
										if (row.expires_at <= cutoff) {
											suppressions.delete(key)
											changes += 1
										}
									}
									return { meta: { changes } }
								}
							}
							return { meta: { changes: 0 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	return { db, memories, suppressions, batches }
}

const env = (
	db: D1Database,
	bindings: Partial<
		Pick<Env, 'AI' | 'CAPABILITY_VECTOR_INDEX' | 'SENTRY_ENVIRONMENT'>
	> = {},
	meter = createInMemoryUserMeterEnv(),
) =>
	({
		APP_DB: db,
		USER_METER: meter.env.USER_METER,
		...bindings,
	}) satisfies Pick<Env, 'APP_DB' | 'USER_METER'> as Pick<
		Env,
		| 'APP_DB'
		| 'USER_METER'
		| 'AI'
		| 'CAPABILITY_VECTOR_INDEX'
		| 'SENTRY_ENVIRONMENT'
	>

function createDeterministicAiBinding(): Ai {
	return {
		async run(...args: Array<unknown>) {
			const input = args[1] as { text?: unknown }
			const texts = Array.isArray(input.text)
				? input.text.map(String)
				: [String(input.text ?? '')]
			return {
				data: texts.map((text) => deterministicEmbedding(text)),
				shape: [texts.length, CAPABILITY_EMBEDDING_DIMENSIONS],
			}
		},
	} as unknown as Ai
}

const editorThemeUri = 'https://docs.example.com/preferences/editor-theme'
const memoryDocsUri =
	'https://github.com/kody-hq/kody/blob/main/docs/use/memory.md'

test('memory service upserts, verifies, soft deletes, and validates source uris', async () => {
	const testDb = createMemoryTestDb()
	const runtimeEnv = env(testDb.db)
	const base = { env: runtimeEnv, userId: ownerIdFromStored('user-123') }

	const created = await upsertMemory({
		...base,
		subject: 'Preferred editor theme',
		summary: 'User prefers a dark theme in editors.',
		details: 'Applies to code editors and dashboards.',
		category: 'preference',
		tags: ['theme', 'dark-mode'],
		sourceUris: [editorThemeUri],
		verificationReference: 'verify-1',
	})
	expect(created.mode).toBe('created')
	expect(created.memory.subject).toBe('Preferred editor theme')
	expect(created.memory.sourceUris).toEqual([editorThemeUri])

	const verify = await verifyMemoryCandidate({
		...base,
		scope: { kind: 'all' },
		candidate: {
			subject: 'Editor theme preference',
			summary: 'User likes dark mode in editing interfaces.',
			category: 'preference',
			tags: ['theme'],
			sourceUris: [editorThemeUri],
		},
	})
	expect(verify.relatedMemories).toHaveLength(1)
	expect(verify.relatedMemories[0]?.memory.id).toBe(created.memory.id)
	expect(verify.candidate.source_uris).toEqual([editorThemeUri])
	expect(verify.relatedMemories[0]?.memory.sourceUris).toEqual([editorThemeUri])

	const updated = await upsertMemory({
		...base,
		memoryId: created.memory.id,
		subject: 'Preferred editor theme',
		summary: 'User prefers dark mode everywhere.',
		category: 'preference',
		tags: ['theme', 'dark-mode'],
		sourceUris: [editorThemeUri, memoryDocsUri],
		verificationReference: 'verify-2',
	})
	expect(updated.mode).toBe('updated')
	expect(updated.memory.summary).toBe('User prefers dark mode everywhere.')
	expect(updated.memory.sourceUris).toEqual([editorThemeUri, memoryDocsUri])

	const deleted = await deleteMemory({
		...base,
		memoryId: created.memory.id,
		force: false,
	})
	expect(deleted?.status).toBe('deleted')
	expect(await getMemory({ ...base, memoryId: created.memory.id })).toBeNull()
	const loaded = await getMemory({
		...base,
		memoryId: created.memory.id,
		includeDeleted: true,
	})
	expect(loaded?.status).toBe('deleted')
	expect(loaded?.sourceUris).toEqual([editorThemeUri, memoryDocsUri])

	await expect(
		upsertMemory({
			...base,
			subject: 'Invalid source URIs',
			summary: 'This write should fail validation.',
			sourceUris: ['not-a-url'],
			verificationReference: 'verify-4',
		}),
	).rejects.toThrow('Memory source_uris entries must be valid URLs.')

	// Rows stored before source URIs existed load with an empty list.
	testDb.memories.set('legacy-memory', {
		id: 'legacy-memory',
		user_id: ownerIdFromStored('user-123'),
		category: 'profile',
		status: 'active',
		subject: 'Legacy memory',
		summary: 'Stored before source URIs existed.',
		details: '',
		tags_json: '["legacy"]',
		dedupe_key: null,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		last_accessed_at: null,
		deleted_at: null,
	} as unknown as McpMemoryRow)
	expect(
		(await getMemory({ ...base, memoryId: 'legacy-memory' }))?.sourceUris,
	).toEqual([])
})

test('memory search returns mutable user-owned ids and upsert rejects unknown ids', async () => {
	const testDb = createMemoryTestDb()
	const runtimeEnv = env(testDb.db)
	const base = { env: runtimeEnv, userId: ownerIdFromStored('user-123') }

	await upsertMemory({
		...base,
		subject: 'Mutable memory id',
		summary: 'Search results should return ids that mutation calls can reuse.',
		category: 'workflow',
		verificationReference: 'verify-3',
	})
	await upsertMemory({
		env: runtimeEnv,
		userId: ownerIdFromStored('other-user'),
		subject: 'Mutable memory id',
		summary: 'This other-user memory must not leak through search.',
		category: 'workflow',
		verificationReference: 'verify-4',
	})

	const search = await searchMemoryRecords({
		...base,
		scope: { kind: 'all' },
		query: 'mutable memory id mutation calls',
	})
	expect(search.matches).toHaveLength(1)
	const match = search.matches[0]!
	expect(match.subject).toBe('Mutable memory id')

	const updated = await upsertMemory({
		...base,
		memoryId: match.id,
		subject: 'Mutable memory id',
		summary: 'The exact search result id was accepted by upsert.',
		category: 'workflow',
		verificationReference: 'verify-5',
	})
	expect(updated.mode).toBe('updated')
	expect(updated.memory.id).toBe(match.id)

	const deleted = await deleteMemory({ ...base, memoryId: match.id })
	expect(deleted?.id).toBe(match.id)
	expect(deleted?.status).toBe('deleted')

	await expect(
		upsertMemory({
			...base,
			memoryId: 'transcribed-memory-id',
			subject: 'Preferred editor theme',
			summary: 'User prefers a dark theme in editors.',
			category: 'preference',
			verificationReference: 'verify-6',
		}),
	).rejects.toThrow(
		'Memory "transcribed-memory-id" was not found in mutable memory storage for this signed-in user.',
	)
})

test('memory search with a granted scope ranks only granted memories', async () => {
	const testDb = createMemoryTestDb()
	const runtimeEnv = env(testDb.db)
	const base = { env: runtimeEnv, userId: ownerIdFromStored('user-123') }
	const created = []
	for (const label of ['alpha', 'beta', 'gamma']) {
		created.push(
			await upsertMemory({
				...base,
				subject: `Release checklist ${label}`,
				summary: `Release checklist notes for ${label}.`,
				verificationReference: `verify-${label}`,
			}),
		)
	}
	const grantedId = created[1]!.memory.id

	const scoped = await searchMemoryRecords({
		...base,
		scope: { kind: 'granted', ids: new Set([grantedId]) },
		query: 'release checklist',
		limit: 5,
	})
	expect(scoped.matches.map((match) => match.id)).toEqual([grantedId])

	const none = await searchMemoryRecords({
		...base,
		scope: { kind: 'granted', ids: new Set() },
		query: 'release checklist',
	})
	expect(none.matches).toEqual([])
})

test('memory surfacing suppresses repeated memories per conversation', async () => {
	const testDb = createMemoryTestDb()
	const runtimeEnv = env(testDb.db)
	const query = 'deployment preference after 4pm'
	await upsertMemory({
		env: runtimeEnv,
		userId: ownerIdFromStored('user-123'),
		subject: 'Deployment window',
		summary: 'User prefers deployments after 4pm.',
		category: 'workflow',
		verificationReference: 'verify-3',
	})
	const surface = (conversationId: string) =>
		surfaceRelevantMemories({
			env: runtimeEnv,
			scope: { kind: 'all' },
			userId: ownerIdFromStored('user-123'),
			query,
			conversationId,
		})

	const first = await surface('conv-123')
	expect(first.memories).toHaveLength(1)
	expect(first.suppressedCount).toBe(0)

	const second = await surface('conv-123')
	expect(second.memories).toHaveLength(0)
	expect(second.suppressedCount).toBeGreaterThanOrEqual(1)

	const otherConversation = await surface('conv-other-agent')
	expect(otherConversation.memories).toHaveLength(1)
	expect(otherConversation.suppressedCount).toBe(0)

	const search = await searchMemoryRecords({
		env: runtimeEnv,
		scope: { kind: 'all' },
		userId: ownerIdFromStored('user-123'),
		query,
		conversationId: 'conv-123',
	})
	expect(search.matches).toHaveLength(0)
	expect(search.suppressedCount).toBeGreaterThanOrEqual(1)
})

test('acknowledgeSurfacedMemories writes suppressions and last_accessed in one batch', async () => {
	const testDb = createMemoryTestDb()
	const runtimeEnv = env(testDb.db)
	const created = await upsertMemory({
		env: runtimeEnv,
		userId: ownerIdFromStored('user-123'),
		subject: 'Ack batch',
		summary: 'Atomic acknowledgement coverage.',
		category: 'workflow',
		verificationReference: 'verify-ack-batch',
	})
	testDb.batches.length = 0

	await acknowledgeSurfacedMemories({
		env: runtimeEnv,
		userId: ownerIdFromStored('user-123'),
		conversationId: 'conv-ack-batch',
		memoryIds: [created.memory.id],
	})

	// After mirror retirement, DO-authority leases no longer use D1 batch for
	// acquire or release. Only the acknowledgement itself is an atomic batch.
	expect(testDb.batches).toHaveLength(1)
	expect(testDb.batches[0]).toHaveLength(2)
	expect(
		testDb.suppressions.get(`user-123:conv-ack-batch:${created.memory.id}`),
	).toMatchObject({
		memory_id: created.memory.id,
		conversation_id: 'conv-ack-batch',
	})
	expect(testDb.memories.get(created.memory.id)?.last_accessed_at).toEqual(
		expect.any(String),
	)
})

test('memory search online queries Vectorize first and hydrates vector hits by id', async () => {
	const testDb = createMemoryTestDb()
	const baseTime = Date.parse('2026-06-01T00:00:00.000Z')
	const seedMemory = (
		id: string,
		subject: string,
		summary: string,
		ageMinutes: number,
	) => {
		const timestamp = new Date(baseTime - ageMinutes * 60_000).toISOString()
		testDb.memories.set(id, {
			id,
			user_id: ownerIdFromStored('user-123'),
			category: null,
			status: 'active',
			subject,
			summary,
			details: '',
			tags_json: '[]',
			source_uris_json: '[]',
			dedupe_key: null,
			created_at: timestamp,
			updated_at: timestamp,
			last_accessed_at: null,
			deleted_at: null,
		})
	}
	seedMemory(
		'memory-recent',
		'Deployment window',
		'User prefers deployments after 4pm.',
		0,
	)
	// Enough newer filler rows that the old memory falls outside the bounded
	// lexical candidate set (most recent 50 rows).
	for (let index = 0; index < 60; index += 1) {
		seedMemory(
			`filler-${index}`,
			`Filler note ${index}`,
			'Unrelated grocery reminder.',
			index + 1,
		)
	}
	seedMemory(
		'memory-old-vector-hit',
		'Deployment window history',
		'Old deployment window memory only reachable via Vectorize.',
		10_000,
	)

	const vectorQueryCalls: Array<VectorizeQueryOptions | undefined> = []
	const vectorIndex: Pick<VectorizeIndex, 'query'> = {
		async query(_values, options) {
			vectorQueryCalls.push(options)
			return {
				count: 1,
				matches: [{ id: 'memory_memory-old-vector-hit', score: 0.92 }],
			}
		},
	}
	const runtimeEnv = env(testDb.db, {
		SENTRY_ENVIRONMENT: 'production',
		AI: createDeterministicAiBinding(),
		CAPABILITY_VECTOR_INDEX: vectorIndex as VectorizeIndex,
	})

	const result = await searchMemoryRecords({
		env: runtimeEnv,
		scope: { kind: 'all' },
		userId: ownerIdFromStored('user-123'),
		query: 'deployment window',
		limit: 5,
	})

	// Vectorize applies the user namespace before the defense-in-depth metadata
	// filters; exactly one namespaced query runs.
	expect(vectorQueryCalls).toHaveLength(1)
	expect(vectorQueryCalls[0]).toMatchObject({
		namespace: 'user-123',
		filter: {
			kind: { $eq: 'memory' },
			userId: { $eq: 'user-123' },
			status: { $in: ['active', 'archived'] },
		},
	})
	const matchedIds = result.matches.map((match) => match.id)
	expect(matchedIds).toContain('memory-old-vector-hit')
	expect(matchedIds).toContain('memory-recent')
})

test('granted memory search ranks granted vectors by id without a namespace query', async () => {
	const testDb = createMemoryTestDb()
	const userId = ownerIdFromStored('user-123')
	const timestamp = '2026-06-01T00:00:00.000Z'
	for (const [id, subject] of [
		['memory-close', 'Quarterly planning'],
		['memory-far', 'Quarterly planning notes'],
		['memory-hidden', 'Quarterly planning secret'],
	] as const) {
		testDb.memories.set(id, {
			id,
			user_id: userId,
			category: null,
			status: 'active',
			subject,
			summary: 'Quarterly planning.',
			details: '',
			tags_json: '[]',
			source_uris_json: '[]',
			dedupe_key: null,
			created_at: timestamp,
			updated_at: timestamp,
			last_accessed_at: null,
			deleted_at: null,
		})
	}
	const queryVector = [1, 0]
	const requestedIds: Array<Array<string>> = []
	const vectorIndex: Pick<VectorizeIndex, 'query' | 'getByIds'> = {
		async query() {
			throw new Error('granted search must not query the namespace')
		},
		async getByIds(ids) {
			requestedIds.push([...ids])
			return [
				{ id: 'memory_memory-far', values: [0, 1], metadata: { userId } },
				{ id: 'memory_memory-close', values: [1, 0], metadata: { userId } },
			]
		},
	}
	const runtimeEnv = env(testDb.db, {
		SENTRY_ENVIRONMENT: 'production',
		AI: createDeterministicAiBinding(),
		CAPABILITY_VECTOR_INDEX: vectorIndex as VectorizeIndex,
	})

	const result = await searchMemoryRecords({
		env: runtimeEnv,
		scope: { kind: 'granted', ids: new Set(['memory-far', 'memory-close']) },
		userId,
		query: 'quarterly planning',
		limit: 5,
		embedText: async () => queryVector,
	})

	expect(requestedIds).toHaveLength(1)
	expect(requestedIds[0]!.toSorted()).toEqual([
		'memory_memory-close',
		'memory_memory-far',
	])
	expect(result.matches.map((match) => match.id).toSorted()).toEqual([
		'memory-close',
		'memory-far',
	])
})

test('rankMemoryVectorIdsWithin orders by similarity and drops other owners', async () => {
	const userId = ownerIdFromStored('user-123')
	const vectorIndex: Pick<VectorizeIndex, 'getByIds'> = {
		async getByIds() {
			return [
				{ id: 'memory_far', values: [0, 1], metadata: { userId } },
				{ id: 'memory_close', values: [1, 0.1], metadata: { userId } },
				{
					id: 'memory_foreign',
					values: [1, 0],
					metadata: { userId: 'someone-else' },
				},
			]
		},
	}
	const ranked = await rankMemoryVectorIdsWithin({
		env: env(createMemoryTestDb().db, {
			SENTRY_ENVIRONMENT: 'production',
			AI: createDeterministicAiBinding(),
			CAPABILITY_VECTOR_INDEX: vectorIndex as VectorizeIndex,
		}) as unknown as Env,
		query: 'q',
		userId,
		memoryIds: ['far', 'close', 'foreign'],
		embedText: async () => [1, 0],
	})
	expect(ranked).toEqual(['close', 'far'])
})

test('force deletion removes an already soft-deleted memory only for its authorized owner', async () => {
	const testDb = createMemoryTestDb()
	const base = { env: env(testDb.db), userId: ownerIdFromStored('owner') }
	const created = await upsertMemory({
		...base,
		subject: 'Delete fixture',
		summary: 'Delete fixture',
		verificationReference: 'verified',
	})
	const memoryId = created.memory.id
	expect(
		(await deleteMemory({ ...base, memoryId, force: false }))?.status,
	).toBe('deleted')
	expect(await getMemory({ ...base, memoryId })).toBeNull()
	expect(await deleteMemory({ ...base, memoryId, force: false })).toBeNull()
	expect(
		await deleteMemory({
			...base,
			userId: ownerIdFromStored('foreign'),
			memoryId,
			force: true,
		}),
	).toBeNull()
	expect(
		await getMemory({ ...base, memoryId, includeDeleted: true }),
	).not.toBeNull()
	expect((await deleteMemory({ ...base, memoryId, force: true }))?.id).toBe(
		memoryId,
	)
	expect(
		await getMemory({ ...base, memoryId, includeDeleted: true }),
	).toBeNull()
})
