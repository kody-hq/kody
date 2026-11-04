import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	cleanupOrphanedPackageStorageBuckets,
	listOrphanedPackageStorageBuckets,
} from './orphan-package-storage.ts'

const mocks = vi.hoisted(() => ({
	clearStorage: vi.fn(async () => {}),
	storageRunnerRpc: vi.fn(),
}))

vi.mock('#worker/storage-runner.ts', () => ({
	storageRunnerRpc: mocks.storageRunnerRpc,
}))

const at = '2026-10-11T12:00:00.000Z'
const orphanId = 'aaaaaaaa-1111-4111-8111-111111111111'
const liveId = '22222222-2222-4222-8222-222222222222'
const softDeletedId = '33333333-3333-4333-8333-333333333333'
const forkReservedId = '44444444-4444-4444-8444-444444444444'
const deletedBucketId = '55555555-5555-4555-8555-555555555555'

function seed() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	sqlite.exec('PRAGMA foreign_keys = OFF')
	const insertPackage = sqlite.prepare(
		`INSERT INTO saved_packages (id, user_id, name, kody_id, description, tags_json, source_id, has_app, has_skills, hidden, is_private, created_at, updated_at, deleted_at)
		VALUES (?, 'user-1', ?, ?, '', '[]', ?, 0, 0, 0, 1, ?, ?, ?)`,
	)
	insertPackage.run(liveId, '@user/live', 'live', 'source-live', at, at, null)
	insertPackage.run(
		softDeletedId,
		'@user/gone-soon',
		'gone-soon',
		'source-soft',
		at,
		at,
		at,
	)
	sqlite
		.prepare(
			`INSERT INTO community_forks (id, listing_id, forker_user_id, origin_commit, forked_package_id, forked_source_id, target_kody_id)
			VALUES ('fork-1', 'listing-1', 'user-1', 'commit', ?, 'source-fork', 'fork')`,
		)
		.run(forkReservedId)
	const insertBucket = sqlite.prepare(
		`INSERT INTO user_storage_buckets (user_id, storage_id, kind, created_at, last_seen_at, estimated_bytes, deleted_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
	const bucket = (
		storageId: string,
		options: { userId?: string; kind?: string; deletedAt?: string } = {},
	) =>
		insertBucket.run(
			options.userId ?? 'user-1',
			storageId,
			options.kind ?? 'package',
			at,
			at,
			1024,
			options.deletedAt ?? null,
		)
	bucket(`package:${orphanId}`, { userId: 'user-2' })
	bucket(`package:${liveId}`)
	bucket(`package:${softDeletedId}`)
	bucket(`package:${forkReservedId}`)
	bucket(`package:${deletedBucketId}`, { deletedAt: at })
	bucket(`package:${orphanId.toUpperCase()}`)
	bucket(`package:not-a-uuid-but-exactly-36-characters-xx`)
	bucket(`package:aaaaaaaa-1111-4111-8111-11111111-111`)
	bucket(`job:package-job:${orphanId}:nightly`, { kind: 'job' })
	return sqlite
}

function bucketIds(sqlite: DatabaseSync) {
	return sqlite
		.prepare(
			'SELECT user_id, storage_id FROM user_storage_buckets ORDER BY storage_id',
		)
		.all()
		.map((row) => `${String(row.user_id)} ${String(row.storage_id)}`)
}

test('lists only live canonical package buckets with no package row or fork', async () => {
	const sqlite = seed()
	expect(
		await listOrphanedPackageStorageBuckets(createD1FromSqlite(sqlite)),
	).toEqual([
		{
			userId: 'user-2',
			storageId: `package:${orphanId}`,
			packageId: orphanId,
			estimatedBytes: 1024,
		},
	])
})

test('preview clears nothing; apply clears only the orphan bucket', async () => {
	const sqlite = seed()
	mocks.storageRunnerRpc.mockReturnValue({ clearStorage: mocks.clearStorage })
	const env = { APP_DB: createD1FromSqlite(sqlite) } as unknown as Env
	const before = bucketIds(sqlite)

	const preview = await cleanupOrphanedPackageStorageBuckets({
		env,
		apply: false,
	})
	expect(preview).toMatchObject({ applied: false, clearedCount: 0 })
	expect(preview.orphans).toHaveLength(1)
	expect(mocks.storageRunnerRpc).not.toHaveBeenCalled()
	expect(bucketIds(sqlite)).toEqual(before)

	const applied = await cleanupOrphanedPackageStorageBuckets({
		env,
		apply: true,
	})
	expect(applied).toMatchObject({
		applied: true,
		clearedCount: 1,
		failedCount: 0,
	})
	expect(mocks.storageRunnerRpc).toHaveBeenCalledTimes(1)
	expect(mocks.storageRunnerRpc).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-2',
			storageId: `package:${orphanId}`,
		}),
	)
	expect(mocks.clearStorage).toHaveBeenCalledTimes(1)
	expect(bucketIds(sqlite)).toEqual(
		before.filter((id) => id !== `user-2 package:${orphanId}`),
	)
})

test('a small limit still finds the canonical orphan past noncanonical rows', async () => {
	const sqlite = seed()
	expect(
		await listOrphanedPackageStorageBuckets(createD1FromSqlite(sqlite), {
			limit: 1,
		}),
	).toEqual([expect.objectContaining({ storageId: `package:${orphanId}` })])
})

test('apply keeps the row of a bucket whose clear keeps failing and continues', async () => {
	const sqlite = seed()
	const secondOrphanId = '66666666-6666-4666-8666-666666666666'
	sqlite
		.prepare(
			`INSERT INTO user_storage_buckets (user_id, storage_id, kind, created_at, last_seen_at, estimated_bytes, deleted_at)
			VALUES ('user-3', ?, 'package', ?, ?, 1024, NULL)`,
		)
		.run(`package:${secondOrphanId}`, at, at)
	const failingClear = vi.fn(async () => {
		throw new Error('clear failed')
	})
	mocks.storageRunnerRpc.mockImplementation(
		({ storageId }: { storageId: string }) => ({
			clearStorage:
				storageId === `package:${orphanId}` ? failingClear : mocks.clearStorage,
		}),
	)
	vi.spyOn(console, 'warn').mockImplementation(() => {})
	const env = { APP_DB: createD1FromSqlite(sqlite) } as unknown as Env
	const before = bucketIds(sqlite)

	const applied = await cleanupOrphanedPackageStorageBuckets({
		env,
		apply: true,
	})
	expect(applied).toMatchObject({ clearedCount: 1, failedCount: 1 })
	expect(failingClear).toHaveBeenCalledTimes(3)
	expect(bucketIds(sqlite)).toEqual(
		before.filter((id) => id !== `user-3 package:${secondOrphanId}`),
	)
})

test('apply skips an id that a package claimed after the listing', async () => {
	const sqlite = seed()
	mocks.storageRunnerRpc.mockReturnValue({ clearStorage: mocks.clearStorage })
	mocks.clearStorage.mockClear()
	const db = createD1FromSqlite(sqlite)
	const claimingDb = {
		prepare(sql: string) {
			const statement = db.prepare(sql)
			if (!sql.includes('LIMIT ?')) return statement
			return {
				bind: (...values: Array<unknown>) => {
					const bound = statement.bind(...values)
					return {
						all: async () => {
							const listed = await bound.all()
							sqlite
								.prepare(
									`INSERT INTO saved_packages (id, user_id, name, kody_id, description, tags_json, source_id, has_app, has_skills, hidden, is_private, created_at, updated_at, deleted_at)
									VALUES (?, 'user-2', '@user/back', 'back', '', '[]', 'source-back', 0, 0, 0, 1, ?, ?, NULL)`,
								)
								.run(orphanId, at, at)
							return listed
						},
					}
				},
			}
		},
	} as unknown as D1Database
	const env = { APP_DB: claimingDb } as unknown as Env
	const before = bucketIds(sqlite)

	const applied = await cleanupOrphanedPackageStorageBuckets({
		env,
		apply: true,
	})
	expect(applied).toMatchObject({
		clearedCount: 0,
		failedCount: 0,
		skippedCount: 1,
	})
	expect(applied.orphans).toHaveLength(1)
	expect(mocks.clearStorage).not.toHaveBeenCalled()
	expect(bucketIds(sqlite)).toEqual(before)
})
