import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	AccountDeletionCleanupError,
	AccountDeletionInventoryError,
	deleteUserAccount,
} from './account-deletion.ts'
import {
	AccountDeletionInProgressError,
	AccountDeletionWritersActiveError,
	assertAccountWritable,
} from '#worker/account/deletion-state.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import {
	createTestDb,
	createSuccessfulDeletionEnv,
	type RowMap,
} from '#worker/test-support/account-deletion.ts'

type DeletionEnv = Parameters<typeof deleteUserAccount>[0]['env']

const userA = { id: 1, email: 'a@example.com', stable_user_id: 'user-aaa' }

function deleteUserA(env: DeletionEnv) {
	return deleteUserAccount({
		env,
		dbUserId: 1,
		mcpUserId: ownerIdFromStored('user-aaa'),
	})
}

function oauthProvider(overrides: Record<string, unknown> = {}) {
	return {
		async listUserGrants() {
			return { items: [], cursor: undefined }
		},
		revokeGrant: vi.fn(async () => undefined),
		...overrides,
	}
}

const fencedUser = expect.objectContaining({
	id: 1,
	email: 'a@example.com',
	deleting_at: expect.any(String),
})
const unfencedUser = expect.objectContaining({
	id: 1,
	email: 'a@example.com',
	deleting_at: null,
})

test('deleteUserAccount deletes owned OAuth clients and fails closed on critical cleanup errors', async () => {
	const ownedClient = { id: 'row-1', user_id: 1, client_id: 'owned-client' }
	const deleteClient = vi.fn(async () => undefined)
	const { db: ownedClientDb } = createTestDb({
		users: [userA],
		user_mcp_oauth_clients: [
			{ ...ownedClient, revoked_at: null },
			{
				id: 'row-2',
				user_id: 1,
				client_id: 'already-revoked',
				revoked_at: '2026-08-01T00:00:00.000Z',
			},
		],
	})
	await deleteUserA(
		createSuccessfulDeletionEnv(ownedClientDb, {
			OAUTH_PROVIDER: oauthProvider({ deleteClient }),
		}),
	)
	expect(deleteClient).toHaveBeenCalledTimes(2)
	expect(deleteClient).toHaveBeenCalledWith('owned-client')
	expect(deleteClient).toHaveBeenCalledWith('already-revoked')

	const job = {
		id: 'job-1',
		user_id: ownerIdFromStored('user-aaa'),
		storage_id: null,
	}
	const { db: missingDeleteDb, rows: missingDeleteRows } = createTestDb({
		users: [userA],
		jobs: [job],
		user_mcp_oauth_clients: [{ ...ownedClient, revoked_at: null }],
	})
	await expect(
		deleteUserA(
			createSuccessfulDeletionEnv(missingDeleteDb, {
				OAUTH_PROVIDER: oauthProvider(),
			}),
		),
	).rejects.toMatchObject({
		name: 'AccountDeletionCleanupError',
		cleanupErrors: [
			'OAuth provider does not support client deletion; MCP OAuth clients were not removed.',
		],
	})
	expect(missingDeleteRows.users).toEqual([expect.objectContaining({ id: 1 })])

	const { db: oauthFailureDb, rows: oauthFailureRows } = createTestDb({
		users: [userA],
		jobs: [job],
	})
	await expect(
		deleteUserA(
			createSuccessfulDeletionEnv(oauthFailureDb, {
				OAUTH_PROVIDER: oauthProvider({
					async listUserGrants() {
						throw new Error('OAuth provider is temporarily unavailable')
					},
				}),
			}),
		),
	).rejects.toBeInstanceOf(AccountDeletionCleanupError)
	expect(oauthFailureRows.jobs).toEqual([job])
	expect(oauthFailureRows.users).toEqual([fencedUser])

	const { db: kvFailureDb, rows: kvFailureRows } = createTestDb({
		users: [userA],
		published_bundle_artifacts: [
			{
				id: 'pba-1',
				user_id: ownerIdFromStored('user-aaa'),
				kv_key: 'bundle-artifact:v1:src-1',
			},
		],
	})
	await expect(
		deleteUserA(
			createSuccessfulDeletionEnv(kvFailureDb, {
				BUNDLE_ARTIFACTS_KV: {
					delete: vi.fn(async () => undefined),
					list: vi.fn(async () => ({
						keys: [],
						list_complete: true,
						cursor: undefined,
					})),
				},
				EMAIL_BLOBS: {
					list: vi.fn(async () => ({
						objects: [{ key: 'email-raw:v1:user-aaa/em-1' }],
						delimitedPrefixes: [],
						truncated: false,
					})),
					delete: vi.fn(async () => {
						throw new Error('simulated R2 outage')
					}),
				},
			}),
		),
	).rejects.toMatchObject({
		cleanupErrors: expect.arrayContaining([
			expect.stringContaining('Email raw MIME prefix delete failed'),
		]),
	})
	expect(kvFailureRows.published_bundle_artifacts).toHaveLength(1)
	expect(kvFailureRows.users).toEqual([fencedUser])
})

test('deleteUserAccount fails closed when preflight inventory cannot be read', async () => {
	const { db, rows } = createTestDb(
		{
			users: [userA],
			mcp_memories: [
				{ id: 'memory-a', user_id: ownerIdFromStored('user-aaa') },
			],
			jobs: [
				{
					id: 'job-a',
					user_id: ownerIdFromStored('user-aaa'),
					storage_id: 'job:job-a',
				},
			],
		},
		{ failSelectContaining: 'select id from mcp_memories where user_id = ?' },
	)
	const deleteVectors = vi.fn(async () => undefined)
	const clearStorage = vi.fn(async () => undefined)
	const userMeter = createInMemoryUserMeterEnv()
	await expect(
		deleteUserA({
			APP_DB: db,
			USER_METER: userMeter.env.USER_METER,
			CAPABILITY_VECTOR_INDEX: { deleteByIds: deleteVectors },
			STORAGE_RUNNER: {
				idFromName: (name: string) => name as unknown as DurableObjectId,
				get: () => ({ clearStorage }),
			},
		} as unknown as DeletionEnv),
	).rejects.toBeInstanceOf(AccountDeletionInventoryError)
	expect(rows.users).toEqual([unfencedUser])
	expect(
		await userMeterRpc({
			env: userMeter.env,
			userId: ownerIdFromStored('user-aaa'),
		}).readDeletionState(),
	).toEqual({ deletingAt: null })
	expect(rows.mcp_memories).toEqual([
		{ id: 'memory-a', user_id: ownerIdFromStored('user-aaa') },
	])
	expect(rows.jobs).toEqual([
		{
			id: 'job-a',
			user_id: ownerIdFromStored('user-aaa'),
			storage_id: 'job:job-a',
		},
	])
	expect(deleteVectors).not.toHaveBeenCalled()
	expect(clearStorage).not.toHaveBeenCalled()
})

test('atomic D1 deletion rolls back every row when one statement fails', async () => {
	const { db, rows } = createTestDb(
		{
			users: [{ id: 1, email: 'a@example.com' }],
			secret_buckets: [{ id: 'sb-a', user_id: ownerIdFromStored('user-aaa') }],
			mcp_memories: [
				{ id: 'memory-a', user_id: ownerIdFromStored('user-aaa') },
			],
		},
		{ failRunContaining: 'delete from mcp_memories where user_id = ?' },
	)
	await expect(
		deleteUserA(createSuccessfulDeletionEnv(db)),
	).rejects.toMatchObject({
		cleanupErrors: [
			expect.stringContaining('Atomic D1 account deletion failed'),
		],
	})
	expect(rows.users).toEqual([fencedUser])
	expect(rows.secret_buckets).toEqual([
		{ id: 'sb-a', user_id: ownerIdFromStored('user-aaa') },
	])
	expect(rows.mcp_memories).toEqual([
		{ id: 'memory-a', user_id: ownerIdFromStored('user-aaa') },
	])
})

test('account deletion quiesces a concurrent user write before inventory', async () => {
	let env: DeletionEnv
	let raceAttempted = false
	let writeCommitted = false
	let writeError: unknown
	const { db } = createTestDb(
		{ users: [{ ...userA, updated_at: '2026-07-22' }] },
		{
			async onSelect(query) {
				if (
					raceAttempted ||
					!query.includes('select id from mcp_memories where user_id = ?')
				) {
					return
				}
				raceAttempted = true
				try {
					await assertAccountWritable(env, ownerIdFromStored('user-aaa'))
					writeCommitted = true
				} catch (error) {
					writeError = error
				}
			},
		},
	)
	env = createSuccessfulDeletionEnv(db)
	await deleteUserA(env)
	expect(raceAttempted).toBe(true)
	expect(writeCommitted).toBe(false)
	expect(writeError).toBeInstanceOf(AccountDeletionInProgressError)
})

test('account deletion waits for active writers, releases only the fence it created, and resumes on retry', async () => {
	function seed(users: RowMap['users']) {
		const { db, rows } = createTestDb({ users })
		const env = createSuccessfulDeletionEnv(db)
		return {
			env,
			rows,
			meter: userMeterRpc({ env, userId: ownerIdFromStored('user-aaa') }),
		}
	}
	// A crashed writer still holds a lease: the fence this attempt created is
	// released in both D1 and the UserMeter.
	const crashed = seed([{ ...userA, updated_at: '2026-07-22' }])
	await crashed.meter.acquireWriteLease({
		token: 'crashed-token-aaa',
		holder: 'test:crashed-writer',
		acquiredAt: '2000-01-01 00:00:00',
	})
	await expect(deleteUserA(crashed.env)).rejects.toBeInstanceOf(
		AccountDeletionWritersActiveError,
	)
	expect(crashed.rows.users).toEqual([unfencedUser])
	expect(await crashed.meter.readDeletionState()).toEqual({ deletingAt: null })

	// Once the lease is repaired the retry completes, and the UserMeter
	// tombstone `purge()` preserved is dropped after the user row is gone.
	await crashed.meter.releaseWriteLease({ token: 'crashed-token-aaa' })
	await expect(deleteUserA(crashed.env)).resolves.toEqual(
		expect.objectContaining({ warnings: [] }),
	)
	expect(crashed.rows.users).toEqual([])
	expect(await crashed.meter.readDeletionState()).toEqual({ deletingAt: null })

	// A fence from an earlier attempt stays in place while writers are active.
	const earlierFence = '2026-08-31 15:22:12'
	const retry = seed([{ ...userA, deleting_at: earlierFence }])
	await retry.meter.acquireWriteLease({
		token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		holder: 'test:cleanup-retry',
		acquiredAt: '2026-08-31 15:23:00',
	})
	await retry.meter.markDeleting({ deletingAt: earlierFence })
	await expect(deleteUserA(retry.env)).rejects.toBeInstanceOf(
		AccountDeletionWritersActiveError,
	)
	expect(retry.rows.users).toEqual([
		expect.objectContaining({ id: 1, deleting_at: earlierFence }),
	])
	expect(await retry.meter.readDeletionState()).toEqual({
		deletingAt: earlierFence,
	})
})

test('account deletion empties the user RunLog DO and leaves other users untouched', async () => {
	const runLogByUser = new Map([
		[
			'user-aaa',
			{
				runs: [{ id: 'run-a', storageId: 'run-only-bucket' }],
				logs: [{ runId: 'run-a', message: 'aaa console output' }],
			},
		],
		[
			'user-bbb',
			{
				runs: [{ id: 'run-b', storageId: 'bbb-bucket' }],
				logs: [{ runId: 'run-b', message: 'bbb console output' }],
			},
		],
	])
	const clearedStorageIds: Array<string> = []
	const { db } = createTestDb({
		users: [
			userA,
			{ id: 2, email: 'b@example.com', stable_user_id: 'user-bbb' },
		],
	})
	const result = await deleteUserA(
		createSuccessfulDeletionEnv(db, {
			STORAGE_RUNNER: {
				idFromName: (name: string) => name as unknown as DurableObjectId,
				get: (id: DurableObjectId) => ({
					clearStorage: async () => {
						clearedStorageIds.push(String(id))
						return { ok: true as const }
					},
				}),
			},
			RUN_LOG: {
				idFromName: (name: string) => name as unknown as DurableObjectId,
				get: (id: DurableObjectId) => {
					const state = runLogByUser.get(String(id))
					return {
						listStorageIds: async () =>
							(state?.runs ?? []).map((run) => run.storageId),
						listWorkflowProjections: async () => ({
							projections: [],
							nextCursor: null,
						}),
						clearAll: async () => {
							if (state) {
								state.runs = []
								state.logs = []
							}
							return { ok: true as const }
						},
					}
				},
			},
		}),
	)

	expect(result.clearedDurableObjects.runLogs).toBe(1)
	expect(runLogByUser.get('user-aaa')).toEqual({ runs: [], logs: [] })
	expect(runLogByUser.get('user-bbb')).toEqual({
		runs: [{ id: 'run-b', storageId: 'bbb-bucket' }],
		logs: [{ runId: 'run-b', message: 'bbb console output' }],
	})
	expect(clearedStorageIds.some((id) => id.includes('run-only-bucket'))).toBe(
		true,
	)
	expect(clearedStorageIds.some((id) => id.includes('bbb-bucket'))).toBe(false)
})

test('account deletion purges a StorageRunner known only via user_storage_buckets', async () => {
	const userId = ownerIdFromStored('user-bucket-only')
	const clearStorage = vi.fn(async () => ({ ok: true as const }))
	const idFromName = vi.fn((name: string) => name as unknown as DurableObjectId)
	const { db } = createTestDb({
		users: [{ id: 1, email: 'bucket@example.com', stable_user_id: userId }],
		user_storage_buckets: [
			{ user_id: userId, storage_id: 'exec:adhoc-only', kind: 'execute' },
		],
	})

	const result = await deleteUserAccount({
		env: createSuccessfulDeletionEnv(db, {
			STORAGE_RUNNER: { idFromName, get: () => ({ clearStorage }) },
		}),
		dbUserId: 1,
		mcpUserId: userId,
	})

	expect(result.clearedDurableObjects.storageRunners).toBe(1)
	expect(clearStorage).toHaveBeenCalledTimes(1)
	expect(idFromName).toHaveBeenCalledWith(
		JSON.stringify([userId, 'exec:adhoc-only']),
	)
})

function createRunningWorkflowDeletionEnv(input: {
	events: Array<string>
	terminate: (id: string) => Promise<void>
}) {
	const projections = new Map<string, Record<string, unknown>>([
		[
			'wf-running',
			{
				id: 'wf-running',
				bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
				sourceType: 'inline',
				workflowName: 'inline-code',
				idempotencyKey: 'wf-running-key',
				runAt: '2026-05-03T12:34:56.000Z',
				status: 'running',
				createdAt: '2026-05-03T12:34:56.000Z',
				updatedAt: '2026-05-03T12:34:56.000Z',
				completedAt: null,
			},
		],
	])
	const { db, rows } = createTestDb({ users: [userA] })
	const env = createSuccessfulDeletionEnv(db, {
		STORAGE_RUNNER: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({
				clearStorage: async () => {
					input.events.push('clearStorage')
					return { ok: true as const }
				},
			}),
		},
		DYNAMIC_CALLABLE_WORKFLOWS: {
			get: async (id: string) => ({
				id,
				status: async () => {
					throw new Error('workflow status unavailable')
				},
				terminate: () => input.terminate(id),
			}),
		} as unknown as Workflow,
		RUN_LOG: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({
				listStorageIds: async () => ['storage-1'],
				listWorkflowProjections: async (query: { status: string | null }) => ({
					projections: [...projections.values()].filter(
						(row) => row['status'] === query.status,
					),
					nextCursor: null,
				}),
				getWorkflowProjection: async (query: { id: string }) =>
					projections.get(query.id) ?? null,
				upsertWorkflowProjection: async (
					projection: Record<string, unknown> & { id: string },
				) => {
					projections.set(projection.id, {
						...projections.get(projection.id),
						...projection,
					})
					return { ok: true as const }
				},
				clearAll: async () => {
					input.events.push('clearAll')
					projections.clear()
					return { ok: true as const }
				},
			}),
		},
	})
	return { env, rows }
}

test('account deletion terminates running package workflows before purging the run log', async () => {
	const events: Array<string> = []
	const { env } = createRunningWorkflowDeletionEnv({
		events,
		terminate: async (id) => {
			events.push(`terminate:${id}`)
		},
	})
	await deleteUserA(env)

	expect(events).toEqual(['terminate:wf-running', 'clearStorage', 'clearAll'])
})

test('account deletion stops before purging anything when workflow termination fails', async () => {
	const events: Array<string> = []
	const { env, rows } = createRunningWorkflowDeletionEnv({
		events,
		terminate: async () => {
			throw new Error('terminate unavailable')
		},
	})
	await expect(deleteUserA(env)).rejects.toMatchObject({
		name: 'AccountDeletionCleanupError',
		cleanupErrors: [
			expect.stringContaining('Workflow run cancellation failed'),
		],
	})
	expect(events).toEqual([])
	expect(rows.users).toEqual([fencedUser])
})
