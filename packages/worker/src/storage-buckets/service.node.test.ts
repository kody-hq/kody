import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { replaceRepoSessionDueOwner } from '#worker/repo/repo-session-due-owners.ts'
import { type RepoSessionRow } from '#worker/repo/types.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryRepoSessionIndexEnv } from '#worker/test-support/repo-session-index.ts'
import { readRepoSessionStorageBucketCursor } from './repo-session-storage-bucket-cursor.ts'
import {
	clearStorageBucketRegistrationDedupeForTests,
	flushStorageBucketRegistrationsForTests,
	formatStorageBucketKindSummary,
	listPlatformStorageBuckets,
	listUserStorageBucketEstimates,
	listUserStorageBucketIds,
	registerMissingRepoSessionStorageBuckets,
	registerStorageBucket,
	repoSessionStorageBucketId,
	storageBucketKindFromStorageId,
	summarizeStorageBucketEstimatesByKind,
} from './service.ts'

function createCountingDb(input?: { failRun?: boolean }) {
	let insertCount = 0
	const rows = new Map<string, { userId: string; storageId: string }>()

	function listRows<T>(userFilter: string | null) {
		const results = [...rows.values()]
			.filter((row) => (userFilter ? row.userId === userFilter : true))
			.sort((left, right) =>
				`${left.userId}\0${left.storageId}`.localeCompare(
					`${right.userId}\0${right.storageId}`,
				),
			)
			.map((row) =>
				userFilter
					? ({ storageId: row.storageId } as T)
					: ({
							userId: row.userId,
							storageId: row.storageId,
						} as T),
			)
		return { results, meta: { changes: 0 } }
	}

	const db = {
		prepare(sql: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async run() {
							if (sql.includes('INSERT INTO user_storage_buckets')) {
								insertCount += 1
								if (input?.failRun) {
									throw new Error('simulated upsert failure')
								}
								const userId = String(params[0])
								const storageId = String(params[1])
								rows.set(`${userId}\u0000${storageId}`, { userId, storageId })
							}
							return { meta: { changes: 1 } }
						},
						async all<T>() {
							if (!sql.includes('FROM user_storage_buckets')) {
								return { results: [] as Array<T>, meta: { changes: 0 } }
							}
							const userFilter =
								sql.includes('WHERE user_id = ?') && params[0] != null
									? String(params[0])
									: null
							return listRows<T>(userFilter)
						},
					}
				},
				async all<T>() {
					if (!sql.includes('FROM user_storage_buckets')) {
						return { results: [] as Array<T>, meta: { changes: 0 } }
					}
					return listRows<T>(null)
				},
			}
		},
	} as unknown as D1Database
	return {
		db,
		env: { APP_DB: db } as Env,
		get insertCount() {
			return insertCount
		},
		rows,
	}
}

test('storage bucket registration soft-fails, dedupes, and lists by user', async () => {
	expect(
		['job:abc', 'exec:abc', 'package:abc', 'adhoc-bucket'].map(
			storageBucketKindFromStorageId,
		),
	).toEqual(['job', 'execute', 'package', 'unknown'])

	consoleWarn.mockImplementation(() => {})
	clearStorageBucketRegistrationDedupeForTests()
	expect(() =>
		registerStorageBucket({
			env: {} as Env,
			userId: ownerIdFromStored('user-a'),
			storageId: 'bucket-a',
		}),
	).not.toThrow()
	const failing = createCountingDb({ failRun: true })
	expect(() =>
		registerStorageBucket({
			env: failing.env,
			userId: ownerIdFromStored('user-a'),
			storageId: 'bucket-a',
			kind: 'execute',
		}),
	).not.toThrow()
	await flushStorageBucketRegistrationsForTests()
	expect(consoleWarn).toHaveBeenCalledWith(
		'storage-bucket-register-failed',
		expect.any(Error),
	)

	clearStorageBucketRegistrationDedupeForTests()
	const counting = createCountingDb()
	const pending: Array<Promise<unknown>> = []
	const waitUntil = (promise: Promise<unknown>) => {
		pending.push(promise)
	}
	for (const [userId, storageId] of [
		...Array.from({ length: 5 }, () => ['user-a', 'exec:same']),
		['user-a', 'bucket-a'],
		['user-b', 'bucket-b'],
	]) {
		registerStorageBucket({ env: counting.env, userId, storageId, waitUntil })
	}
	await Promise.all(pending)

	expect(counting.insertCount).toBe(3)
	await expect(
		listUserStorageBucketIds({
			env: counting.env,
			userId: ownerIdFromStored('user-a'),
		}),
	).resolves.toEqual(['bucket-a', 'exec:same'])
	await expect(
		listUserStorageBucketIds({
			env: counting.env,
			userId: ownerIdFromStored('user-b'),
		}),
	).resolves.toEqual(['bucket-b'])
	await expect(
		listPlatformStorageBuckets({ db: counting.db }),
	).resolves.toEqual([
		{ userId: ownerIdFromStored('user-a'), storageId: 'bucket-a' },
		{ userId: ownerIdFromStored('user-a'), storageId: 'exec:same' },
		{ userId: ownerIdFromStored('user-b'), storageId: 'bucket-b' },
	])
})

function catalogSessionRow(
	overrides: Partial<RepoSessionRow> & Pick<RepoSessionRow, 'id' | 'user_id'>,
): RepoSessionRow {
	return {
		source_id: 'source-1',
		source_repo_id: 'repo-1',
		session_branch: `sessions/${overrides.id}`,
		source_branch: 'main',
		base_commit: 'commit',
		source_root: '/',
		conversation_id: null,
		status: 'active',
		expires_at: null,
		last_checkpoint_at: null,
		last_checkpoint_commit: null,
		last_check_run_id: null,
		last_check_tree_hash: null,
		created_at: '2026-06-24T19:00:00.000Z',
		updated_at: '2026-06-24T19:00:00.000Z',
		...overrides,
	}
}

function repoSessionIndexStub(
	env: ReturnType<typeof createInMemoryRepoSessionIndexEnv>,
	userId: string,
) {
	return env.REPO_SESSION_INDEX.get(env.REPO_SESSION_INDEX.idFromName(userId))
}

test('index-backed storage-bucket reconcile pages owners with a persisted cursor', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const indexEnv = createInMemoryRepoSessionIndexEnv(db)
	const now = new Date('2026-06-24T20:00:00.000Z')
	const users = ['user-a', 'user-b', 'user-c'] as const
	for (const userId of users) {
		await replaceRepoSessionDueOwner({
			db,
			userId,
			dueAt: '2099-01-01T00:00:00.000Z',
			now,
		})
		await repoSessionIndexStub(indexEnv, userId).insertSession({
			ownerId: ownerIdFromStored(userId),
			row: catalogSessionRow({
				id: `${userId}-active`,
				user_id: ownerIdFromStored(userId),
			}),
		})
	}
	await repoSessionIndexStub(indexEnv, 'user-a').insertSession({
		ownerId: ownerIdFromStored('user-a'),
		row: catalogSessionRow({
			id: 'user-a-discarded',
			user_id: ownerIdFromStored('user-a'),
			status: 'discarded',
		}),
	})

	const reconcile = async () => ({
		inserted: await registerMissingRepoSessionStorageBuckets({
			db,
			env: indexEnv,
			limit: 2,
			now,
		}),
		cursor: await readRepoSessionStorageBucketCursor(db),
	})
	const registered = async () =>
		Promise.all(
			users.map(async (userId) =>
				(
					await listUserStorageBucketEstimates({
						env: { APP_DB: db } as Env,
						userId: ownerIdFromStored(userId),
					})
				).map((row) => ({ userId, ...row })),
			),
		).then((rows) => rows.flat())
	const activeRow = (userId: string) => ({
		userId,
		storageId: repoSessionStorageBucketId(`${userId}-active`),
		kind: 'repo_session',
		estimatedBytes: null,
	})

	// Insert limit filled on user-b, so the cursor stays on the last fully
	// processed owner and the next tick retries user-b instead of skipping
	// any remaining sessions. Discarded sessions are never registered.
	expect(await reconcile()).toEqual({ inserted: 2, cursor: 'user-a' })
	expect(await registered()).toEqual([activeRow('user-a'), activeRow('user-b')])
	expect(await reconcile()).toEqual({ inserted: 1, cursor: 'user-c' })
	expect(await registered()).toEqual(users.map(activeRow))
	expect(await reconcile()).toEqual({ inserted: 0, cursor: '' })
	expect(await reconcile()).toEqual({ inserted: 0, cursor: 'user-b' })
})

test('summarizeStorageBucketEstimatesByKind groups without exposing storage ids', () => {
	const summary = summarizeStorageBucketEstimatesByKind([
		{ kind: 'repo_session', estimatedBytes: 1_048_576 },
		{ kind: 'package', estimatedBytes: 2_097_152 },
		{ kind: 'repo_session', estimatedBytes: null },
		{ kind: 'package', estimatedBytes: 512 },
	])
	expect(summary).toEqual([
		{ kind: 'package', label: 'package storage', bytes: 2_097_664, count: 2 },
		{
			kind: 'repo_session',
			label: 'repo session scratch',
			bytes: 1_048_576,
			count: 2,
		},
	])
	expect(
		formatStorageBucketKindSummary([
			{ kind: 'repo_session', estimatedBytes: 1_048_576 },
			{ kind: 'package', estimatedBytes: 2_097_152 },
		]),
	).toBe(
		'Inventoried buckets: 1 package storage (2.0 MiB); 1 repo session scratch (1.0 MiB).',
	)
})
