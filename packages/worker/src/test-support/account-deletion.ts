import type { deleteUserAccount } from '#worker/app/account-deletion.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { createInMemoryRepoSessionIndexEnv } from '#worker/test-support/repo-session-index.ts'

export type RowMap = Record<string, Array<Record<string, unknown>>>

/** Production queries append live-delete filters; mocks match the legacy shape. */
function stripLiveDeletedFilter(sql: string): string {
	return sql.replace(/\s+and deleted_at is null/g, '')
}

export function createTestDb(
	initial: RowMap,
	options?: {
		failSelectContaining?: string
		failRunContaining?: string
		onSelect?: (query: string) => Promise<void>
	},
): {
	db: D1Database
	rows: RowMap
} {
	const rows: RowMap = {}
	for (const [key, value] of Object.entries(initial)) {
		rows[key] = value.map((row) => {
			const copy = { ...row }
			if (
				key === 'users' &&
				(copy['stable_user_id'] == null || copy['stable_user_id'] === '')
			) {
				const id = Number(copy['id'])
				if (id === 1) copy['stable_user_id'] = 'user-aaa'
				else if (id === 2) copy['stable_user_id'] = 'user-bbb'
			}
			return copy
		})
	}

	function deleteByPredicate(
		table: string,
		predicate: (row: Record<string, unknown>) => boolean,
	) {
		const remaining: Array<Record<string, unknown>> = []
		let removed = 0
		for (const row of rows[table] ?? []) {
			if (predicate(row)) {
				removed += 1
				continue
			}
			remaining.push(row)
		}
		rows[table] = remaining
		return removed
	}

	function selectIds(
		table: string,
		where: (row: Record<string, unknown>) => boolean,
	) {
		return (rows[table] ?? []).filter(where).map((row) => row['id'])
	}

	const db = {
		prepare(query: string) {
			const trimmed = query.replace(/\s+/g, ' ').trim()
			const lower = stripLiveDeletedFilter(trimmed.toLowerCase())
			return {
				bind(...params: Array<unknown>) {
					return {
						async all<T>() {
							await options?.onSelect?.(lower)
							if (
								options?.failSelectContaining &&
								lower.includes(options.failSelectContaining)
							) {
								throw new Error('simulated inventory read failure')
							}
							let results: Array<unknown> = []
							const userId = params[0] as string
							if (
								lower ===
								'select client_id from user_mcp_oauth_clients where user_id = ?'
							) {
								const numericId = Number(params[0])
								results = (rows.user_mcp_oauth_clients ?? [])
									.filter((row) => Number(row['user_id']) === numericId)
									.map((row) => ({ client_id: row['client_id'] }))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								lower ===
								'select deleting_at from users where stable_user_id = ?'
							) {
								results = (rows.users ?? [])
									.filter((row) => row['stable_user_id'] === userId)
									.map((row) => ({
										deleting_at: row['deleting_at'] ?? null,
									}))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (lower === 'select stable_user_id from users where id = ?') {
								const numericId = Number(params[0])
								results = (rows.users ?? [])
									.filter((row) => Number(row['id']) === numericId)
									.map((row) => ({
										stable_user_id: row['stable_user_id'],
									}))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								lower ===
								'select stable_user_id, deleting_at from users where id = ?'
							) {
								const numericId = Number(params[0])
								results = (rows.users ?? [])
									.filter((row) => Number(row['id']) === numericId)
									.map((row) => ({
										stable_user_id: row['stable_user_id'],
										deleting_at: row['deleting_at'] ?? null,
									}))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								lower ===
								'select id from saved_packages where user_id = ? and has_app = 1'
							) {
								results = (rows.saved_packages ?? [])
									.filter(
										(row) =>
											row['user_id'] === userId &&
											(row['has_app'] === 1 ||
												row['has_app'] === '1' ||
												row['has_app'] === true),
									)
									.map((row) => ({ id: row['id'] }))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								lower ===
								'select id, published_commit, repo_id from entity_sources where user_id = ?'
							) {
								results = (rows.entity_sources ?? [])
									.filter((row) => row['user_id'] === userId)
									.map((row) => ({
										id: row['id'],
										published_commit: row['published_commit'] ?? null,
										repo_id: row['repo_id'] ?? row['id'],
									}))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								lower ===
								'select id, kody_id, source_id, has_app from saved_packages where user_id = ?'
							) {
								results = (rows.saved_packages ?? [])
									.filter((row) => row['user_id'] === userId)
									.map((row) => ({
										id: row['id'],
										kody_id: row['kody_id'],
										source_id: row['source_id'],
										has_app: row['has_app'],
									}))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								lower ===
								'select do_id from mcp_agent_sessions where user_id = ? order by do_id'
							) {
								results = (rows.mcp_agent_sessions ?? [])
									.filter((row) => row['user_id'] === userId)
									.map((row) => ({ do_id: row['do_id'] }))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								lower.includes(
									'select storage_id as storageid from user_storage_buckets',
								)
							) {
								results = (rows.user_storage_buckets ?? [])
									.filter(
										(row) =>
											row['user_id'] === userId &&
											(!lower.includes("kind <> 'repo_session'") ||
												row['kind'] !== 'repo_session'),
									)
									.map((row) => ({ storageId: row['storage_id'] }))
									.sort((left, right) =>
										String(left.storageId).localeCompare(
											String(right.storageId),
										),
									)
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								lower.includes('from community_listings') &&
								lower.includes('entity_sources.published_commit')
							) {
								results = (rows.community_listings ?? [])
									.filter((row) => row['owner_user_id'] === userId)
									.map((row, index) => {
										const source = (rows.entity_sources ?? []).find(
											(sourceRow) =>
												sourceRow['id'] === row['source_id'] &&
												sourceRow['user_id'] === row['owner_user_id'],
										)
										return {
											account_r2_rowid: index + 1,
											id: row['id'],
											pinned_commit: row['pinned_commit'],
											source_published_commit:
												source?.['published_commit'] ?? null,
										}
									})
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								lower.includes('from entity_sources') &&
								lower.includes('entity_sources.indexed_commit')
							) {
								results = (rows.entity_sources ?? [])
									.filter((row) => row['user_id'] === userId)
									.map((row, index) => ({
										account_r2_rowid: index + 1,
										repo_id: row['repo_id'] ?? row['id'],
										entity_kind: row['entity_kind'] ?? 'package',
										published_commit: row['published_commit'] ?? null,
										indexed_commit: row['indexed_commit'] ?? null,
									}))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							const m = lower.match(/^select id from (\w+) where user_id = \?/)
							if (m) {
								const table = m[1] as string
								results = (rows[table] ?? [])
									.filter((row) => row['user_id'] === userId)
									.map((row) => ({ id: row['id'] }))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							const storageMatch = lower.match(
								/^select storage_id from (\w+) where user_id = \? and storage_id is not null/,
							)
							if (storageMatch) {
								const table = storageMatch[1] as string
								results = (rows[table] ?? [])
									.filter(
										(row) =>
											row['user_id'] === userId && row['storage_id'] != null,
									)
									.map((row) => ({ storage_id: row['storage_id'] }))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							const kvMatch = lower.match(
								/^select kv_key from (\w+) where user_id = \?/,
							)
							if (kvMatch) {
								const table = kvMatch[1] as string
								results = (rows[table] ?? [])
									.filter((row) => row['user_id'] === userId)
									.map((row) => ({ kv_key: row['kv_key'] }))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (lower === 'select avatar_key from users where id = ?') {
								const numericId = Number(params[0])
								results = (rows.users ?? [])
									.filter((row) => Number(row['id']) === numericId)
									.map((row) => ({
										avatar_key: row['avatar_key'] ?? null,
									}))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								lower.includes('stripe_customer_id') &&
								lower.includes('from users') &&
								lower.includes('join orgs')
							) {
								const numericId = Number(params[0])
								results = (rows.users ?? [])
									.filter((row) => Number(row['id']) === numericId)
									.map((row) => ({
										stripe_customer_id: row['stripe_customer_id'] ?? null,
										email: row['email'] ?? null,
									}))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							return { results: [] as Array<T>, meta: { changes: 0 } }
						},
						async first<T>() {
							const result = await this.all<T>()
							return (result.results[0] ?? null) as T | null
						},
						async run() {
							if (
								options?.failRunContaining &&
								lower.includes(options.failRunContaining)
							) {
								throw new Error('simulated atomic D1 failure')
							}
							const userId = params[0] as string | number
							if (
								lower ===
								'update users set deleting_at = ?, updated_at = ? where id = ? and deleting_at is null'
							) {
								let changed = 0
								for (const row of rows.users ?? []) {
									if (row['id'] !== params[2]) continue
									if (row['deleting_at'] != null) continue
									row['deleting_at'] = params[0]
									row['updated_at'] = params[1]
									changed += 1
								}
								return { meta: { changes: changed } }
							}
							if (
								lower ===
								'update users set deleting_at = null, updated_at = ? where id = ? and deleting_at = ?'
							) {
								let changed = 0
								for (const row of rows.users ?? []) {
									if (row['id'] !== params[1]) continue
									if (row['deleting_at'] !== params[2]) continue
									row['deleting_at'] = null
									row['updated_at'] = params[0]
									changed += 1
								}
								return { meta: { changes: changed } }
							}
							if (
								lower ===
								'update users set deleting_at = null, updated_at = ? where id = ?'
							) {
								let changed = 0
								for (const row of rows.users ?? []) {
									if (row['id'] !== params[1]) continue
									row['deleting_at'] = null
									row['updated_at'] = params[0]
									changed += 1
								}
								return { meta: { changes: changed } }
							}
							const nullColumnMatch = lower.match(
								/^update (\w+) set ((?:\w+ = null)(?:, \w+ = null)*) where (\w+) = \?$/,
							)
							if (nullColumnMatch) {
								const table = nullColumnMatch[1] as string
								const assignments = nullColumnMatch[2]!
									.split(', ')
									.map((part) => part.replace(' = null', ''))
								const matchColumn = nullColumnMatch[3] as string
								let changed = 0
								for (const row of rows[table] ?? []) {
									if (row[matchColumn] !== userId) continue
									for (const column of assignments) {
										row[column] = null
									}
									changed += 1
								}
								return { meta: { changes: changed } }
							}
							const replaceJsonMatch = lower.match(
								/^update (\w+) set (\w+) = replace\(\2, \?, \?\) where instr\(\2, \?\) > 0$/,
							)
							if (replaceJsonMatch) {
								const table = replaceJsonMatch[1] as string
								const column = replaceJsonMatch[2] as string
								const search = String(params[0])
								const replacement = String(params[1])
								const needle = String(params[2])
								let changed = 0
								for (const row of rows[table] ?? []) {
									const current = row[column]
									if (typeof current !== 'string') continue
									if (!current.includes(needle)) continue
									row[column] = current.split(search).join(replacement)
									changed += 1
								}
								return { meta: { changes: changed } }
							}
							const replaceColumnMatch = lower.match(
								/^update (\w+) set (\w+) = \? where (\w+) = \?$/,
							)
							if (replaceColumnMatch) {
								const table = replaceColumnMatch[1] as string
								const setColumn = replaceColumnMatch[2] as string
								const matchColumn = replaceColumnMatch[3] as string
								let changed = 0
								for (const row of rows[table] ?? []) {
									if (row[matchColumn] !== params[1]) continue
									row[setColumn] = params[0]
									changed += 1
								}
								return { meta: { changes: changed } }
							}
							const userColumnsMatch = lower.match(
								/^delete from (\w+) where ((?:\w+ = \?)(?: or \w+ = \?)*)$/,
							)
							if (userColumnsMatch) {
								const table = userColumnsMatch[1] as string
								const columns = userColumnsMatch[2]!
									.split(' or ')
									.map((part) => part.replace(' = ?', ''))
								const removed = deleteByPredicate(table, (row) =>
									columns.some(
										(column, index) => row[column] === params[index],
									),
								)
								return { meta: { changes: removed } }
							}
							const userIdMatch = lower.match(
								/^delete from (\w+) where user_id = \?/,
							)
							if (userIdMatch) {
								const table = userIdMatch[1] as string
								const removed = deleteByPredicate(
									table,
									(row) => row['user_id'] === userId,
								)
								return { meta: { changes: removed } }
							}
							const bucketParentMatch = lower.match(
								/^delete from (\w+) where bucket_id in \( select id from (\w+) where user_id = \? \)/,
							)
							if (bucketParentMatch) {
								const childTable = bucketParentMatch[1] as string
								const parentTable = bucketParentMatch[2] as string
								const parentIds = new Set(
									selectIds(parentTable, (row) => row['user_id'] === userId),
								)
								const removed = deleteByPredicate(childTable, (row) =>
									parentIds.has(row['bucket_id']),
								)
								return { meta: { changes: removed } }
							}
							const communityListingChildMatch = lower.match(
								/^delete from (\w+) where (\w+) in \( select id from community_listings where owner_user_id = \? \)/,
							)
							if (communityListingChildMatch) {
								const table = communityListingChildMatch[1] as string
								const listingColumn = communityListingChildMatch[2] as string
								const listingIds = new Set(
									selectIds(
										'community_listings',
										(row) => row['owner_user_id'] === userId,
									),
								)
								const removed = deleteByPredicate(table, (row) =>
									listingIds.has(row[listingColumn]),
								)
								return { meta: { changes: removed } }
							}
							const usersMatch = lower.match(/^delete from users where id = \?/)
							if (usersMatch) {
								const removed = deleteByPredicate(
									'users',
									(row) => row['id'] === userId,
								)
								return { meta: { changes: removed } }
							}
							return { meta: { changes: 0 } }
						},
					}
				},
			}
		},
		async batch(
			statements: Array<{ run: () => Promise<{ meta: { changes: number } }> }>,
		) {
			const snapshot = structuredClone(rows)
			try {
				const results = []
				for (const statement of statements) {
					results.push(await statement.run())
				}
				return results
			} catch (error) {
				for (const key of Object.keys(rows)) delete rows[key]
				Object.assign(rows, snapshot)
				throw error
			}
		},
	} as unknown as D1Database

	return { db, rows }
}

// Mimics the jobs worker's JobsService against the test db: job-id and
// storage-id listing and purgeUser all operate on the fixture's jobs tables
// (which stand in for the jobs worker's own D1; production APP_DB has none).
export function createJobsBindingStub(
	db: D1Database,
	overrides: Record<string, unknown> = {},
) {
	async function listStorageIds(table: string, userId: string) {
		const { results } = await db
			.prepare(
				`SELECT storage_id FROM ${table} WHERE user_id = ? AND storage_id IS NOT NULL`,
			)
			.bind(userId)
			.all<{ storage_id: string }>()
		return (results ?? []).map((row) => row.storage_id)
	}
	return {
		listJobIdsForUser: async (input: { userId: string }) => {
			const { results } = await db
				.prepare(`SELECT id FROM jobs WHERE user_id = ?`)
				.bind(input.userId)
				.all<{ id: string }>()
			return (results ?? []).map((row) => row.id)
		},
		listJobStorageIdsForUser: async (input: { userId: string }) =>
			listStorageIds('jobs', input.userId),
		purgeUser: async (input: { userId: string }) => {
			await db
				.prepare(`DELETE FROM jobs WHERE user_id = ?`)
				.bind(input.userId)
				.run()
			return { ok: true as const, userId: input.userId, purged: true }
		},
		...overrides,
	}
}

export function createSuccessfulDeletionEnv(
	db: D1Database,
	overrides: { [Key in keyof Env]?: unknown } & {
		OAUTH_PROVIDER?: {
			listUserGrants: (
				userId: string,
				options: { cursor: string | undefined },
			) => Promise<{
				items: Array<{ id: string; clientId: string }>
				cursor: string | undefined
			}>
			revokeGrant: (grantId: string, userId: string) => Promise<unknown>
		}
	} = {},
) {
	const durableObjectId = (name: string) => name as unknown as DurableObjectId
	const fetchOk = async () => Response.json({ ok: true })
	const userMeter = createInMemoryUserMeterEnv()
	const repoSessionIndex = createInMemoryRepoSessionIndexEnv(db)
	return {
		APP_DB: db,
		CAPABILITY_VECTOR_INDEX: {
			deleteByIds: async () => undefined,
		},
		STORAGE_RUNNER: {
			idFromName: durableObjectId,
			get: () => ({ clearStorage: async () => ({ ok: true as const }) }),
		},
		RUN_LOG: {
			idFromName: durableObjectId,
			get: () => ({
				clearAll: async () => ({ ok: true as const }),
				listStorageIds: async () => [] as Array<string>,
				listWorkflowProjections: async () => ({
					projections: [],
					nextCursor: null,
				}),
			}),
		},
		USER_METER: userMeter.env.USER_METER,
		STRIPE_PLAN_REFRESH: {
			idFromName: durableObjectId,
			get: () => ({ purgeUser: async () => ({ ok: true as const }) }),
		},
		MAILBOX: {
			idFromName: durableObjectId,
			get: () => ({
				listBlobReferences: async () => ({
					references: [],
					nextStartAfter: null,
					truncated: false as const,
				}),
				purge: async () => ({ ok: true as const }),
			}),
		},
		JOBS: createJobsBindingStub(db),
		REPO_SESSION: {
			idFromName: durableObjectId,
			get: () => ({ purgeSession: async () => ({ ok: true as const }) }),
		},
		REPO_SESSION_INDEX: repoSessionIndex.REPO_SESSION_INDEX,
		MCP_CLIENT_HUB: {
			idFromName: durableObjectId,
			get: () => ({ purgeForAccountDeletion: async () => undefined }),
		},
		PACKAGE_REALTIME_SESSION: {
			idFromName: durableObjectId,
			get: () => ({ fetch: fetchOk }),
		},
		COMMUNITY_ASSETS: {
			async list() {
				return {
					objects: [],
					delimitedPrefixes: [],
					truncated: false as const,
				}
			},
			delete: async () => undefined,
		},
		EMAIL_BLOBS: {
			async list() {
				return {
					objects: [],
					delimitedPrefixes: [],
					truncated: false as const,
				}
			},
			delete: async () => undefined,
		},
		OAUTH_PROVIDER: {
			async listUserGrants() {
				return { items: [], cursor: undefined }
			},
			async revokeGrant() {
				return undefined
			},
		},
		...overrides,
	} as unknown as Parameters<typeof deleteUserAccount>[0]['env']
}
