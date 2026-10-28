import { DatabaseSync } from 'node:sqlite'
import { vi } from 'vitest'
import type * as runKodyRegistryModule from '#mcp/run-kody-registry.ts'
import type * as packageInvocationsServiceModule from '#worker/package-invocations/service.ts'
import { terminalWorkflowStatusValues } from '#worker/package-runtime/workflow-statuses.ts'
import { creatingWorkflowProjectionStatus } from '#worker/run-records/workflow-projection.ts'
import type * as runRecordsServiceModule from '#worker/run-records/service.ts'
import {
	type WorkflowProjectionRecord,
	type WorkflowProjectionUpsertInput,
} from '#worker/run-records/service.ts'
import { dynamicCallableWorkflowsBindingName } from '#worker/package-runtime/package-workflows.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
const migrationsDirectory = new URL('../../migrations/', import.meta.url)

export const packageWorkflowsInvocationMocks = (() => ({
	invokePackageExport:
		vi.fn<typeof packageInvocationsServiceModule.invokePackageExport>(),
	runModuleWithRegistry:
		vi.fn<typeof runKodyRegistryModule.runModuleWithRegistry>(),
}))()

export const packageWorkflowsRunRecordMocks = (() => {
	const projectionsByUser = new Map<
		string,
		Map<string, WorkflowProjectionRecord>
	>()
	const activeStatuses = new Set<string>([
		'queued',
		'running',
		'paused',
		'waiting',
		'waitingForPause',
		'unknown',
	])
	const reservationStatuses = new Set<string>([...activeStatuses, 'creating'])

	function userStore(userId: string) {
		let store = projectionsByUser.get(userId)
		if (!store) {
			store = new Map()
			projectionsByUser.set(userId, store)
		}
		return store
	}

	function toRecord(
		input: WorkflowProjectionUpsertInput,
		existing?: WorkflowProjectionRecord | null,
	): WorkflowProjectionRecord {
		const now = new Date().toISOString()
		return {
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
			createdAt: input.createdAt?.trim() || existing?.createdAt || now,
			updatedAt: input.updatedAt?.trim() || now,
			completedAt:
				input.completedAt === undefined
					? (existing?.completedAt ?? null)
					: input.completedAt,
			lastError:
				input.lastError === undefined
					? (existing?.lastError ?? null)
					: input.lastError,
			// Insert-only, like the RunLog DO.
			enqueuedCommit: existing
				? existing.enqueuedCommit
				: (input.enqueuedCommit ?? null),
			sourceRevision: existing
				? existing.sourceRevision
				: (input.sourceRevision ?? null),
		}
	}

	function applyProjectionUpsert(
		userId: string,
		projection: WorkflowProjectionUpsertInput,
	) {
		const store = userStore(userId)
		const existing = store.get(projection.id) ?? null
		const nextUpdatedAt =
			projection.updatedAt?.trim() || new Date().toISOString()
		if (!existing) {
			store.set(projection.id, toRecord(projection, null))
			return
		}
		// Monotonic by updatedAt + terminal stickiness (matches RunLog DO).
		if (nextUpdatedAt < existing.updatedAt) {
			return
		}
		const nextStatus = projection.status ?? null
		if (
			existing.status != null &&
			(terminalWorkflowStatusValues as ReadonlyArray<string>).includes(
				existing.status,
			) &&
			(nextStatus == null ||
				!(terminalWorkflowStatusValues as ReadonlyArray<string>).includes(
					nextStatus,
				))
		) {
			return
		}
		store.set(projection.id, {
			...existing,
			status: nextStatus,
			updatedAt: nextUpdatedAt,
			completedAt: projection.completedAt ?? existing.completedAt ?? null,
			lastError: projection.lastError ?? existing.lastError ?? null,
		})
	}

	const upsertWorkflowProjection = vi.fn(
		async (input: {
			env: Env
			userId: string
			projection: WorkflowProjectionUpsertInput
		}) => {
			applyProjectionUpsert(input.userId, input.projection)
			return { ok: true as const }
		},
	)

	return {
		projectionsByUser,
		resetProjections() {
			projectionsByUser.clear()
		},
		listForUser(userId: string) {
			return [...(projectionsByUser.get(userId)?.values() ?? [])]
		},
		beginRunRecord: vi.fn<typeof runRecordsServiceModule.beginRunRecord>(
			() => ({
				id: 'run-1',
				userId: ownerIdFromStored('user-1'),
				startedAt: '2026-05-03T12:34:56.000Z',
				persistence: 'eager' as const,
				context: { surface: 'workflow' as const },
			}),
		),
		finishRunRecord: vi.fn(
			async (
				_input: Parameters<typeof runRecordsServiceModule.finishRunRecord>[0],
			) => {},
		),
		upsertWorkflowProjection,
		releaseWorkflowProjectionIdempotencyKey: vi.fn(
			async (input: { env: Env; userId: string; id: string }) => {
				const store = userStore(input.userId)
				const existing = store.get(input.id)
				if (!existing) {
					return { released: false, previousKey: null }
				}
				if (existing.idempotencyKey.startsWith('released:')) {
					return { released: false, previousKey: existing.idempotencyKey }
				}
				const previousKey = existing.idempotencyKey
				store.set(input.id, {
					...existing,
					idempotencyKey: `released:${input.id}`,
					updatedAt: new Date().toISOString(),
				})
				return { released: true, previousKey }
			},
		),
		getWorkflowProjection: vi.fn(
			async (input: { env: Env; userId: string; id: string }) =>
				userStore(input.userId).get(input.id) ?? null,
		),
		findWorkflowProjectionByIdempotencyKey: vi.fn(
			async (input: {
				env: Env
				userId: string
				idempotencyKey: string
				bindingName?: string | null
			}) => {
				const matches = [...userStore(input.userId).values()]
					.filter(
						(row) =>
							row.idempotencyKey === input.idempotencyKey &&
							row.status !== 'creating' &&
							(input.bindingName
								? row.bindingName === input.bindingName
								: true),
					)
					.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
				return matches[0] ?? null
			},
		),
		listWorkflowProjections: vi.fn(
			async (input: {
				env: Env
				userId: string
				limit?: number | null
				cursor?: string | null
				status?: string | null
				statuses?: ReadonlyArray<string> | null
				bindingName?: string | null
				id?: string | null
				packageId?: string | null
				since?: string | null
			}) => {
				const limit = Math.min(Math.max(input.limit ?? 25, 1), 100)
				const statusSet =
					!input.status && input.statuses && input.statuses.length > 0
						? new Set(input.statuses)
						: null
				const rows = [...userStore(input.userId).values()]
					.filter(
						(row) =>
							(input.id ? row.id === input.id : true) &&
							(input.status
								? row.status === input.status
								: statusSet
									? row.status != null && statusSet.has(row.status)
									: true) &&
							(input.bindingName
								? row.bindingName === input.bindingName
								: true) &&
							(input.packageId ? row.packageId === input.packageId : true) &&
							(input.since ? row.createdAt >= input.since : true),
					)
					.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
				return {
					projections: rows.slice(0, limit),
					nextCursor: null as string | null,
				}
			},
		),
		countActiveWorkflowProjections: vi.fn(
			async (input: { env: Env; userId: string }) =>
				[...userStore(input.userId).values()].filter(
					(row) => row.status != null && activeStatuses.has(row.status),
				).length,
		),
		reserveWorkflowProjectionSlot: vi.fn(
			async (input: {
				env: Env
				userId: string
				projection: WorkflowProjectionUpsertInput
			}) => {
				const store = userStore(input.userId)
				const existing = store.get(input.projection.id) ?? null
				const countBeforeReservation = [...store.values()].filter(
					(row) =>
						row.id !== input.projection.id &&
						row.status != null &&
						reservationStatuses.has(row.status),
				).length
				// Insert-only / creating-refresh: never clobber queued/running/terminal.
				if (
					existing?.status != null &&
					existing.status !== creatingWorkflowProjectionStatus
				) {
					return {
						countBeforeReservation,
						reserved: false,
						inserted: false,
						projection: existing,
					}
				}
				const now = new Date().toISOString()
				const inserted = existing == null
				// Keep count+insert synchronous (no await) so concurrent create
				// tests observe DO-like serialization under Promise.all.
				store.set(
					input.projection.id,
					toRecord(
						{
							...input.projection,
							status: 'creating',
							createdAt:
								input.projection.createdAt ?? existing?.createdAt ?? now,
							updatedAt: input.projection.updatedAt ?? now,
							completedAt: null,
							lastError: null,
						},
						existing,
					),
				)
				const projection = store.get(input.projection.id)
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
		),
		deleteWorkflowProjectionIfCreating: vi.fn(
			async (input: { env: Env; userId: string; id: string }) => {
				const store = userStore(input.userId)
				const existing = store.get(input.id)
				if (existing?.status === 'creating') {
					store.delete(input.id)
					return { deleted: true }
				}
				return { deleted: false }
			},
		),
	}
})()

export async function seedActiveWorkflowProjections(input: {
	userId: string
	count: number
}) {
	for (let index = 0; index < input.count; index += 1) {
		await packageWorkflowsRunRecordMocks.upsertWorkflowProjection({
			env: {} as Env,
			userId: input.userId,
			projection: {
				id: `active-seed-${input.userId}-${index}`,
				bindingName: dynamicCallableWorkflowsBindingName,
				sourceType: 'inline',
				workflowName: `seed-${index}`,
				idempotencyKey: `seed-key-${input.userId}-${index}`,
				runAt: '2026-05-03T12:34:56.000Z',
				status: 'queued',
			},
		})
	}
}

export function createWorkflowBinding(options?: {
	existing?: { id: string; status?: string } | null
	getThrows?: Error
	createThrows?: Error
	statusThrows?: Error
}) {
	const create = vi.fn(async (input: WorkflowInstanceCreateOptions) => {
		if (options?.createThrows) throw options.createThrows
		return {
			id: input.id,
			status: async () => {
				if (options?.statusThrows) throw options.statusThrows
				return { status: 'queued' }
			},
		}
	})
	const get = vi.fn(async (id: string) => {
		if (options?.getThrows) throw options.getThrows
		if (!options || options.existing === null) {
			throw new Error('workflow instance does not exist')
		}
		const existing = options.existing ?? { id, status: 'waiting' }
		return {
			id: existing.id,
			status: async () => {
				if (options.statusThrows) throw options.statusThrows
				return { status: existing.status ?? 'waiting' }
			},
		}
	})
	return {
		workflow: { get, create } as unknown as Workflow,
		get,
		create,
	}
}

export function createStatefulWorkflowBinding() {
	const instances = new Map<string | undefined, WorkflowInstanceCreateOptions>()
	const create = vi.fn(async (input: WorkflowInstanceCreateOptions) => {
		if (instances.has(input.id)) {
			throw new Error('Workflow instance already exists')
		}
		instances.set(input.id, input)
		return {
			id: input.id,
			status: async () => ({ status: 'queued' }),
			terminate: vi.fn(async () => {}),
		}
	})
	const get = vi.fn(async (id: string) => {
		if (!instances.has(id)) {
			throw new Error('workflow instance does not exist')
		}
		return {
			id,
			status: async () => ({ status: 'waiting' }),
			terminate: vi.fn(async () => {}),
		}
	})
	return {
		workflow: { get, create } as unknown as Workflow,
		get,
		create,
		instances,
	}
}

/**
 * Migrated APP_DB for workflow tests that only need plan lookup and/or a
 * saved-package ownership row. Prefer this over SQL-substring D1 stubs so
 * package-ref / entitlement query reshapes do not break unrelated suites.
 */
export function createWorkflowRunsDatabase(options?: {
	savedPackage?: Record<string, unknown> | null
	/** Seeds the package's entity source with this published commit. */
	publishedCommit?: string
	users?: Array<{
		email: string
		plan: string | null
		stable_user_id?: string
	}>
}) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const now = '2026-05-03T00:00:00.000Z'
	const usernames = new Set<string>()
	for (const [index, user] of (options?.users ?? []).entries()) {
		const stableUserId = user.stable_user_id ?? `user-${index + 1}`
		const baseUsername =
			user.email.split('@')[0]?.replace(/[^a-z0-9_-]/gi, '') ||
			`user${index + 1}`
		let username = baseUsername
		let suffix = 2
		while (usernames.has(username)) {
			username = `${baseUsername}-${suffix++}`
		}
		usernames.add(username)
		sqlite
			.prepare(
				`INSERT INTO users (
					username, email, password_hash, email_verified_at, stable_user_id
				) VALUES (?, ?, 'x', ?, ?)`,
			)
			.run(username, user.email, now, stableUserId)
		sqlite
			.prepare(
				`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(stableUserId, username, user.plan ?? 'free', now, now)
	}
	const defaultSavedPackage: Record<string, unknown> = {
		id: 'pkg-1',
		user_id: 'user-1',
		name: 'Shade automation',
		kody_id: 'shade-automation',
		description: 'Shade automation package',
		tags_json: '[]',
		search_text: null,
		source_id: 'source-1',
		has_app: 0,
		created_at: now,
		updated_at: now,
	}
	const savedPackage: Record<string, unknown> | null =
		options?.savedPackage === null
			? null
			: {
					...defaultSavedPackage,
					...options?.savedPackage,
				}
	if (savedPackage) {
		sqlite
			.prepare(
				`INSERT INTO saved_packages (
					id, user_id, name, kody_id, description, tags_json, search_text,
					source_id, has_app, hidden, is_private, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				String(savedPackage['id']),
				String(savedPackage['user_id']),
				String(savedPackage['name']),
				String(savedPackage['kody_id']),
				String(savedPackage['description'] ?? ''),
				String(savedPackage['tags_json'] ?? '[]'),
				savedPackage['search_text'] == null
					? null
					: String(savedPackage['search_text']),
				String(savedPackage['source_id']),
				Number(savedPackage['has_app'] ?? 0),
				Number(savedPackage['hidden'] ?? 0),
				Number(savedPackage['is_private'] ?? 1),
				String(savedPackage['created_at'] ?? now),
				String(savedPackage['updated_at'] ?? now),
			)
	}
	if (savedPackage && options?.publishedCommit) {
		sqlite
			.prepare(
				`INSERT INTO entity_sources (
					id, user_id, entity_kind, entity_id, repo_id, published_commit,
					indexed_commit, manifest_path, source_root, created_at, updated_at
				) VALUES (?, ?, 'package', ?, ?, ?, NULL, 'package.json', '/', ?, ?)`,
			)
			.run(
				String(savedPackage['source_id']),
				String(savedPackage['user_id']),
				String(savedPackage['id']),
				`repo-${String(savedPackage['id'])}`,
				options.publishedCommit,
				now,
				now,
			)
	}
	return createD1FromSqlite(sqlite)
}
