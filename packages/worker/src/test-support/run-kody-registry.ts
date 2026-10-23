import { createInMemoryRepoSessionIndexEnv } from '#worker/test-support/repo-session-index.ts'
import {
	createInMemoryUserMeterEnv,
	createPermissiveAccountWriteLeaseDbHooks,
} from '#worker/test-support/user-meter.ts'
import { activeWorkflowStatusValues } from '#worker/package-runtime/workflow-statuses.ts'
import {
	type WorkflowProjectionRecord,
	type WorkflowProjectionUpsertInput,
} from '#worker/run-records/service.ts'
import {
	type JobRecord,
	type PersistedJobCallerContext,
} from '#worker/jobs/types.ts'
import { type RepoSessionRow } from '#worker/repo/types.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
function normalizeMockQuery(query: string): string {
	return query
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\s+and deleted_at is null/gi, '')
}

/**
 * User-scoped RunLog namespace stub (idFromName(userId) → per-user RPC), enough
 * for workflow projection create/idempotency/active-count paths. Mirrors the
 * package-invocations fake-RunLog pattern used elsewhere in node tests.
 */
export function createFakeRunLogNamespace() {
	const activeStatuses = new Set<string>(activeWorkflowStatusValues)
	const reservationStatuses = new Set<string>([...activeStatuses, 'creating'])
	const stubs = new Map<
		string,
		{
			projections: Map<string, WorkflowProjectionRecord>
			rpc: {
				upsertWorkflowProjection: (
					input: WorkflowProjectionUpsertInput,
				) => Promise<{ ok: true }>
				getWorkflowProjection: (input: {
					id: string
				}) => Promise<WorkflowProjectionRecord | null>
				findWorkflowProjectionByIdempotencyKey: (input: {
					idempotencyKey: string
					bindingName?: string | null
				}) => Promise<WorkflowProjectionRecord | null>
				listWorkflowProjections: (input: {
					limit?: number | null
					cursor?: string | null
					status?: string | null
					bindingName?: string | null
				}) => Promise<{
					projections: Array<WorkflowProjectionRecord>
					nextCursor: string | null
				}>
				countActiveWorkflowProjections: () => Promise<{ count: number }>
				reserveWorkflowProjectionSlot: (
					input: WorkflowProjectionUpsertInput,
				) => Promise<{
					countBeforeReservation: number
					reserved: boolean
					inserted: boolean
					projection: WorkflowProjectionRecord
				}>
				deleteWorkflowProjectionIfCreating: (input: {
					id: string
				}) => Promise<{ deleted: boolean }>
			}
		}
	>()

	function stubFor(name: string) {
		const existing = stubs.get(name)
		if (existing) return existing
		const projections = new Map<string, WorkflowProjectionRecord>()
		const rpc = {
			async upsertWorkflowProjection(input: WorkflowProjectionUpsertInput) {
				const now = new Date().toISOString()
				const nextUpdatedAt = input.updatedAt?.trim() || now
				const prior = projections.get(input.id) ?? null
				if (!prior) {
					projections.set(input.id, {
						id: input.id,
						bindingName: input.bindingName,
						sourceType: input.sourceType,
						packageId: input.packageId ?? null,
						kodyId: input.kodyId ?? null,
						sourceId: input.sourceId ?? null,
						workflowName: input.workflowName,
						exportName: input.exportName ?? null,
						idempotencyKey: input.idempotencyKey,
						runAt: input.runAt,
						planDate: input.planDate ?? null,
						status: input.status ?? null,
						createdAt: input.createdAt?.trim() || now,
						updatedAt: nextUpdatedAt,
						completedAt: input.completedAt ?? null,
						lastError: input.lastError ?? null,
					})
					return { ok: true as const }
				}
				// Monotonic by updatedAt (matches RunLog DO).
				if (nextUpdatedAt < prior.updatedAt) {
					return { ok: true as const }
				}
				projections.set(input.id, {
					...prior,
					status: input.status ?? null,
					updatedAt: nextUpdatedAt,
					completedAt: input.completedAt ?? prior.completedAt,
					lastError: input.lastError ?? prior.lastError,
				})
				return { ok: true as const }
			},
			async getWorkflowProjection(input: { id: string }) {
				return projections.get(input.id) ?? null
			},
			async findWorkflowProjectionByIdempotencyKey(input: {
				idempotencyKey: string
				bindingName?: string | null
			}) {
				const key = input.idempotencyKey.trim()
				if (!key) return null
				const matches = [...projections.values()]
					.filter(
						(row) =>
							row.idempotencyKey === key &&
							row.status !== 'creating' &&
							(input.bindingName
								? row.bindingName === input.bindingName
								: true),
					)
					.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
				return matches[0] ?? null
			},
			async listWorkflowProjections(input: {
				limit?: number | null
				cursor?: string | null
				status?: string | null
				bindingName?: string | null
			}) {
				const limit = Math.min(Math.max(input.limit ?? 25, 1), 100)
				const rows = [...projections.values()]
					.filter(
						(row) =>
							(input.status ? row.status === input.status : true) &&
							(input.bindingName
								? row.bindingName === input.bindingName
								: true),
					)
					.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
				return {
					projections: rows.slice(0, limit),
					nextCursor: null as string | null,
				}
			},
			async countActiveWorkflowProjections() {
				const count = [...projections.values()].filter(
					(row) => row.status != null && activeStatuses.has(row.status),
				).length
				return { count }
			},
			async reserveWorkflowProjectionSlot(
				input: WorkflowProjectionUpsertInput,
			) {
				const existing = projections.get(input.id) ?? null
				const countBeforeReservation = [...projections.values()].filter(
					(row) =>
						row.id !== input.id &&
						row.status != null &&
						reservationStatuses.has(row.status),
				).length
				// Insert-only / creating-refresh: never clobber queued/running/terminal.
				if (existing?.status != null && existing.status !== 'creating') {
					return {
						countBeforeReservation,
						reserved: false,
						inserted: false,
						projection: existing,
					}
				}
				const now = new Date().toISOString()
				const inserted = existing == null
				const createdAt = input.createdAt ?? existing?.createdAt ?? now
				const updatedAt = input.updatedAt ?? now
				projections.set(input.id, {
					id: input.id,
					bindingName: input.bindingName,
					sourceType: input.sourceType,
					packageId: input.packageId ?? null,
					kodyId: input.kodyId ?? null,
					sourceId: input.sourceId ?? null,
					workflowName: input.workflowName,
					exportName: input.exportName ?? null,
					idempotencyKey: input.idempotencyKey,
					runAt: input.runAt,
					planDate: input.planDate ?? null,
					status: 'creating',
					createdAt,
					updatedAt,
					completedAt: null,
					lastError: null,
				})
				const projection = projections.get(input.id)
				if (!projection) {
					throw new Error('Expected reserved projection.')
				}
				return {
					countBeforeReservation,
					reserved: true,
					inserted,
					projection,
				}
			},
			async deleteWorkflowProjectionIfCreating(input: { id: string }) {
				const existing = projections.get(input.id)
				if (existing?.status === 'creating') {
					projections.delete(input.id)
					return { deleted: true }
				}
				return { deleted: false }
			},
		}
		const stub = { projections, rpc }
		stubs.set(name, stub)
		return stub
	}

	return {
		stubs,
		namespace: {
			idFromName: (name: string) =>
				({ toString: () => name }) as unknown as DurableObjectId,
			get: (id: DurableObjectId) => stubFor(String(id)).rpc,
		} as unknown as DurableObjectNamespace,
	}
}

export function createJobMutationDatabase(input: {
	jobs: Array<Record<string, unknown>>
	entitySources: Array<Record<string, unknown>>
	publishedBundleArtifacts?: Array<Record<string, unknown>>
}) {
	const tables = new Map<string, Array<Record<string, unknown>>>([
		['jobs', structuredClone(input.jobs)],
		['entity_sources', structuredClone(input.entitySources)],
		['user_storage_buckets', []],
		[
			'published_bundle_artifacts',
			structuredClone(input.publishedBundleArtifacts ?? []),
		],
		['entity_source_artifacts_push_subscriptions', []],
	])

	const clone = <T>(value: T): T => structuredClone(value)
	const table = (name: string) => {
		const rows = tables.get(name)
		if (!rows) throw new Error(`Unknown test table: ${name}`)
		return rows
	}
	const selectOne = (
		name: string,
		predicate: (row: Record<string, unknown>) => boolean,
	) => clone(table(name).find(predicate) ?? null)
	const selectAll = (
		name: string,
		predicate: (row: Record<string, unknown>) => boolean,
	) => clone(table(name).filter(predicate))
	const deleteWhere = (
		name: string,
		predicate: (row: Record<string, unknown>) => boolean,
	) => {
		const rows = table(name)
		const remaining = rows.filter((row) => !predicate(row))
		tables.set(name, remaining)
		return rows.length - remaining.length
	}
	const writeLeaseDb = createPermissiveAccountWriteLeaseDbHooks()

	return {
		async batch(statements: Array<{ run: () => Promise<unknown> }>) {
			const results = []
			for (const statement of statements) {
				results.push(await statement.run())
			}
			return results
		},
		prepare(query: string) {
			const normalized = normalizeMockQuery(query)
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T = Record<string, unknown>>() {
							if (writeLeaseDb.supportsDeletingAtQuery(query)) {
								return writeLeaseDb.deletingAtFirstResult() as T
							}
							if (
								normalized === 'SELECT * FROM jobs WHERE id = ? AND user_id = ?'
							) {
								return selectOne(
									'jobs',
									(row) =>
										row['id'] === params[0] && row['user_id'] === params[1],
								) as T | null
							}
							if (
								normalized ===
								'SELECT * FROM entity_sources WHERE id = ? AND user_id = ?'
							) {
								return selectOne(
									'entity_sources',
									(row) =>
										row['id'] === params[0] && row['user_id'] === params[1],
								) as T | null
							}
							if (
								normalized ===
								'SELECT * FROM entity_source_artifacts_push_subscriptions WHERE source_id = ? LIMIT 1'
							) {
								return selectOne(
									'entity_source_artifacts_push_subscriptions',
									(row) => row['source_id'] === params[0],
								) as T | null
							}
							throw new Error(`Unsupported first query: ${query}`)
						},
						async all<T = Record<string, unknown>>() {
							if (
								normalized ===
								'SELECT * FROM published_bundle_artifacts WHERE user_id = ? AND source_id = ? ORDER BY updated_at DESC, created_at DESC'
							) {
								return {
									results: selectAll(
										'published_bundle_artifacts',
										(row) =>
											row['user_id'] === params[0] &&
											row['source_id'] === params[1],
									) as T[],
								}
							}
							throw new Error(`Unsupported all query: ${query}`)
						},
						async run() {
							if (normalized.startsWith('UPDATE users')) {
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (normalized.startsWith('UPDATE jobs SET')) {
								const id = params[17]
								const userId = params[18]
								const existing = selectOne(
									'jobs',
									(row) => row['id'] === id && row['user_id'] === userId,
								)
								if (!existing) return { meta: { changes: 0, last_row_id: 0 } }
								const updated = {
									...existing,
									name: params[0],
									source_id: params[1],
									published_commit: params[2],
									repo_check_policy_json: params[3],
									storage_id: params[4],
									params_json: params[5],
									schedule_json: params[6],
									timezone: params[7],
									enabled: params[8],
									kill_switch_enabled: params[9],
									expires_at: params[10],
									caller_context_json: params[11],
									updated_at: params[12],
									last_run_at: params[13],
									last_run_status: params[14],
									next_run_at: params[15],
									disabled_reason: params[16],
								}
								const rows = table('jobs')
								const index = rows.findIndex(
									(row) => row['id'] === id && row['user_id'] === userId,
								)
								rows[index] = updated
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (
								normalized === 'DELETE FROM jobs WHERE id = ? AND user_id = ?'
							) {
								return {
									meta: {
										changes: deleteWhere(
											'jobs',
											(row) =>
												row['id'] === params[0] && row['user_id'] === params[1],
										),
										last_row_id: 0,
									},
								}
							}
							if (
								normalized ===
								'DELETE FROM user_storage_buckets WHERE user_id = ? AND storage_id = ?'
							) {
								return { meta: { changes: 0, last_row_id: 0 } }
							}
							if (
								normalized.startsWith(
									'DELETE FROM user_storage_buckets WHERE user_id = ? AND kind =',
								)
							) {
								const storageIds = new Set(params.slice(1))
								return {
									meta: {
										changes: deleteWhere(
											'user_storage_buckets',
											(row) =>
												row['user_id'] === params[0] &&
												row['kind'] === 'repo_session' &&
												storageIds.has(row['storage_id']),
										),
										last_row_id: 0,
									},
								}
							}
							if (
								normalized ===
								'DELETE FROM published_bundle_artifacts WHERE user_id = ? AND source_id = ?'
							) {
								return {
									meta: {
										changes: deleteWhere(
											'published_bundle_artifacts',
											(row) =>
												row['user_id'] === params[0] &&
												row['source_id'] === params[1],
										),
										last_row_id: 0,
									},
								}
							}
							if (
								normalized ===
								'DELETE FROM entity_sources WHERE id = ? AND user_id = ?'
							) {
								return {
									meta: {
										changes: deleteWhere(
											'entity_sources',
											(row) =>
												row['id'] === params[0] && row['user_id'] === params[1],
										),
										last_row_id: 0,
									},
								}
							}
							if (
								normalized ===
								'DELETE FROM entity_source_artifacts_push_subscriptions WHERE source_id = ? AND user_id = ?'
							) {
								return {
									meta: {
										changes: deleteWhere(
											'entity_source_artifacts_push_subscriptions',
											(row) =>
												row['source_id'] === params[0] &&
												row['user_id'] === params[1],
										),
										last_row_id: 0,
									},
								}
							}
							throw new Error(`Unsupported run query: ${query}`)
						},
					}
				},
			}
		},
	} as D1Database
}

export function createJobMutationKv() {
	const deletedKeys: Array<string> = []
	return {
		deletedKeys,
		async get() {
			return null
		},
		async put() {},
		async delete(key: string) {
			deletedKeys.push(key)
		},
	} as unknown as KVNamespace & { deletedKeys: Array<string> }
}

export function createRunKodyRegistryTestEnv(
	bindings: Record<string, unknown>,
	meter?: ReturnType<typeof createInMemoryUserMeterEnv>,
) {
	const userMeter = meter ?? createInMemoryUserMeterEnv()
	const appDb = bindings.APP_DB as D1Database | undefined
	const repoSessionIndex = createInMemoryRepoSessionIndexEnv(appDb)
	return {
		...bindings,
		USER_METER: userMeter.env.USER_METER,
		REPO_SESSION_INDEX: repoSessionIndex.REPO_SESSION_INDEX,
	} as Env
}

export function createJobRow(
	job: JobRecord,
	callerContext: PersistedJobCallerContext,
) {
	return {
		id: job.id,
		user_id: job.userId,
		name: job.name,
		source_id: job.sourceId,
		published_commit: job.publishedCommit,
		repo_check_policy_json: job.repoCheckPolicy
			? JSON.stringify(job.repoCheckPolicy)
			: null,
		storage_id: job.storageId,
		params_json: job.params ? JSON.stringify(job.params) : null,
		schedule_json: JSON.stringify(job.schedule),
		timezone: job.timezone,
		enabled: job.enabled ? 1 : 0,
		kill_switch_enabled: job.killSwitchEnabled ? 1 : 0,
		expires_at: job.expiresAt ?? null,
		caller_context_json: JSON.stringify(callerContext),
		created_at: job.createdAt,
		updated_at: job.updatedAt,
		last_run_at: job.lastRunAt ?? null,
		last_run_status: job.lastRunStatus ?? null,
		next_run_at: job.nextRunAt,
	}
}

export function createRepoSessionRow(input: {
	id: string
	userId: string
	sourceId: string
	sourceRepoId: string
}): RepoSessionRow {
	return {
		id: input.id,
		user_id: ownerIdFromStored(input.userId),
		source_id: input.sourceId,
		source_repo_id: input.sourceRepoId,
		session_branch: `sessions/${input.id}`,
		source_branch: 'main',
		base_commit: 'published-commit-1',
		source_root: '/',
		conversation_id: null,
		status: 'active',
		expires_at: null,
		last_checkpoint_at: null,
		last_checkpoint_commit: null,
		last_check_run_id: null,
		last_check_tree_hash: null,
		created_at: '2026-04-16T00:00:00.000Z',
		updated_at: '2026-04-16T00:00:00.000Z',
	}
}
