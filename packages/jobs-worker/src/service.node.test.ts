import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { createD1JobsStore } from '@kody-internal/shared/jobs/store.ts'
import { jobExpiredDisabledReason } from '@kody-internal/shared/jobs/disabled-reason.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { type JobsWorkerEnv } from './env.ts'
import { JobsService } from './service.ts'

function createJobsDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function insertJob(
	sqlite: DatabaseSync,
	input: { id: string; userId: string },
) {
	sqlite
		.prepare(
			`INSERT INTO jobs (
				id, user_id, name, source_id, storage_id, schedule_json, timezone,
				caller_context_json, created_at, updated_at, next_run_at
			) VALUES (?, ?, ?, 'src-1', ?, '{}', 'UTC', '{}', ?, ?, ?)`,
		)
		.run(
			input.id,
			input.userId,
			`name-${input.id}`,
			`job:${input.id}`,
			'2026-09-01T00:00:00.000Z',
			'2026-09-01T00:00:00.000Z',
			'2026-09-02T00:00:00.000Z',
		)
}

function createService(db: D1Database) {
	const env = { JOBS_DB: db } as unknown as JobsWorkerEnv
	return new JobsService({ props: {} } as never, env)
}

test('listJobIdsForUser returns the user’s live job ids from the jobs D1 only', async () => {
	const { sqlite, db } = createJobsDb()
	for (const [id, userId] of [
		['job-1', 'user-aaa'],
		['job-2', 'user-aaa'],
		['job-3', 'user-bbb'],
	] as const) {
		insertJob(sqlite, { id, userId })
	}

	const service = createService(db)
	for (const [userId, jobIds] of [
		['user-aaa', ['job-1', 'job-2']],
		['user-bbb', ['job-3']],
		['user-none', []],
	] as const) {
		await expect(service.listJobIdsForUser({ userId })).resolves.toEqual(jobIds)
	}
})

test('soft-delete records each job enabled flag and restore puts it back', async () => {
	const { sqlite, db } = createJobsDb()
	insertJob(sqlite, { id: 'job-on', userId: ownerIdFromStored('org-jobs') })
	insertJob(sqlite, { id: 'job-off', userId: ownerIdFromStored('org-jobs') })
	sqlite.prepare(`UPDATE jobs SET enabled = 0 WHERE id = 'job-off'`).run()
	const store = createD1JobsStore(db)
	const deletedAt = '2026-10-01T12:00:00.000Z'
	expect(
		await store.softDeleteJobsForUser({
			userId: ownerIdFromStored('org-jobs'),
			deletedAt,
		}),
	).toBe(2)
	const tombstoned = sqlite
		.prepare(
			`SELECT id, enabled, enabled_before_soft_delete AS before
			 FROM jobs WHERE user_id = 'org-jobs' ORDER BY id`,
		)
		.all() as Array<{ id: string; enabled: number; before: number }>
	expect(tombstoned).toEqual([
		{ id: 'job-off', enabled: 0, before: 0 },
		{ id: 'job-on', enabled: 0, before: 1 },
	])
	expect(
		await store.softDeleteJobsForUser({
			userId: ownerIdFromStored('org-jobs'),
			deletedAt: '2026-10-02T00:00:00.000Z',
		}),
	).toBe(0)
	const stillOriginal = sqlite
		.prepare(
			`SELECT deleted_at, enabled_before_soft_delete AS before
			 FROM jobs WHERE id = 'job-on'`,
		)
		.get() as { deleted_at: string; before: number }
	expect(stillOriginal).toEqual({ deleted_at: deletedAt, before: 1 })
	expect(
		await store.restoreJobsForUser({
			userId: ownerIdFromStored('org-jobs'),
			deletedAt,
			restoredAt: '2026-10-03T00:00:00.000Z',
		}),
	).toBe(2)
	const restored = sqlite
		.prepare(
			`SELECT id, enabled, enabled_before_soft_delete AS before, deleted_at
			 FROM jobs WHERE user_id = 'org-jobs' ORDER BY id`,
		)
		.all() as Array<{
		id: string
		enabled: number
		before: number | null
		deleted_at: string | null
	}>
	expect(restored).toEqual([
		{ id: 'job-off', enabled: 0, before: null, deleted_at: null },
		{ id: 'job-on', enabled: 1, before: null, deleted_at: null },
	])
})

test('restore leaves a pre-column tombstone disabled', async () => {
	const { sqlite, db } = createJobsDb()
	insertJob(sqlite, {
		id: 'job-legacy',
		userId: ownerIdFromStored('org-legacy'),
	})
	const deletedAt = '2026-09-01T00:00:00.000Z'
	sqlite
		.prepare(
			`UPDATE jobs
			 SET deleted_at = ?, enabled = 0, enabled_before_soft_delete = NULL
			 WHERE id = 'job-legacy'`,
		)
		.run(deletedAt)
	const store = createD1JobsStore(db)
	expect(
		await store.restoreJobsForUser({
			userId: ownerIdFromStored('org-legacy'),
			deletedAt,
			restoredAt: '2026-09-02T00:00:00.000Z',
		}),
	).toBe(1)
	const row = sqlite
		.prepare(`SELECT enabled, deleted_at FROM jobs WHERE id = 'job-legacy'`)
		.get() as { enabled: number; deleted_at: string | null }
	expect(row).toEqual({ enabled: 0, deleted_at: null })
})

test('transferJobsOwner re-points live jobs and rewrites caller context', async () => {
	const { sqlite, db } = createJobsDb()
	insertJob(sqlite, { id: 'job-a', userId: 'org-from' })
	insertJob(sqlite, { id: 'job-b', userId: 'org-from' })
	insertJob(sqlite, { id: 'job-c', userId: 'org-from' })
	const service = createService(db)
	await expect(
		service.transferJobsOwner({
			fromUserId: 'org-from',
			toUserId: 'org-to',
			jobs: [
				{ jobId: 'job-a', callerContextJson: '{"to":"a"}' },
				{ jobId: 'job-b', callerContextJson: '{"to":"b"}' },
			],
			updatedAt: '2026-10-05T00:00:00.000Z',
		}),
	).resolves.toEqual({ transferred: 2 })
	expect(
		sqlite
			.prepare(
				'SELECT id, user_id, caller_context_json AS ctx FROM jobs ORDER BY id',
			)
			.all(),
	).toEqual([
		{ id: 'job-a', user_id: 'org-to', ctx: '{"to":"a"}' },
		{ id: 'job-b', user_id: 'org-to', ctx: '{"to":"b"}' },
		{ id: 'job-c', user_id: 'org-from', ctx: '{}' },
	])
})

test('transferJobsOwner refuses running or foreign jobs and moves nothing', async () => {
	const { sqlite, db } = createJobsDb()
	insertJob(sqlite, { id: 'job-a', userId: 'org-from' })
	insertJob(sqlite, { id: 'job-running', userId: 'org-from' })
	insertJob(sqlite, { id: 'job-foreign', userId: 'org-other' })
	sqlite
		.prepare(`UPDATE jobs SET claim_token = 'claim' WHERE id = 'job-running'`)
		.run()
	const service = createService(db)
	for (const jobId of ['job-running', 'job-foreign']) {
		await expect(
			service.transferJobsOwner({
				fromUserId: 'org-from',
				toUserId: 'org-to',
				jobs: [
					{ jobId: 'job-a', callerContextJson: '{}' },
					{ jobId, callerContextJson: '{}' },
				],
				updatedAt: '2026-10-05T00:00:00.000Z',
			}),
		).rejects.toThrow()
	}
	expect(
		sqlite.prepare(`SELECT user_id FROM jobs WHERE id = 'job-a'`).get(),
	).toEqual({ user_id: 'org-from' })
})

test('the jobs store saves a disabled reason only while the job is off', async () => {
	const { sqlite, db } = createJobsDb()
	const userId = ownerIdFromStored('org-reasons')
	insertJob(sqlite, { id: 'job-reason', userId })
	const store = createD1JobsStore(db)
	const row = await store.getJobById({ userId, jobId: 'job-reason' })
	if (!row) throw new Error('expected the seeded job')
	expect(row.record.disabledReason).toBeNull()

	await store.updateJob({
		userId,
		job: {
			...row.record,
			enabled: false,
			disabledReason: 'Paused for the migration.',
		},
		callerContextJson: row.callerContextJson,
	})
	expect(
		sqlite
			.prepare(`SELECT disabled_reason FROM jobs WHERE id = 'job-reason'`)
			.get(),
	).toEqual({ disabled_reason: 'Paused for the migration.' })
	const off = await store.getJobById({ userId, jobId: 'job-reason' })
	expect(off?.record.disabledReason).toBe('Paused for the migration.')

	// A job that is on never carries a stale reason.
	await store.updateJob({
		userId,
		job: { ...off!.record, enabled: true },
		callerContextJson: row.callerContextJson,
	})
	expect(
		sqlite
			.prepare(`SELECT disabled_reason FROM jobs WHERE id = 'job-reason'`)
			.get(),
	).toEqual({ disabled_reason: null })
})

test('an expired job turns off with the expiry saved as its disabled reason', async () => {
	const { sqlite, db } = createJobsDb()
	const userId = ownerIdFromStored('org-expiry')
	insertJob(sqlite, { id: 'job-expired', userId })
	sqlite
		.prepare(
			`UPDATE jobs SET enabled = 1, expires_at = '2026-09-03T00:00:00.000Z' WHERE id = 'job-expired'`,
		)
		.run()
	const store = createD1JobsStore(db)
	expect(
		await store.disableExpiredJobsForUser({
			userId,
			nowIso: '2026-09-04T00:00:00.000Z',
		}),
	).toBe(1)
	const row = await store.getJobById({ userId, jobId: 'job-expired' })
	expect(row?.record.enabled).toBe(false)
	expect(row?.record.disabledReason).toBe(jobExpiredDisabledReason)
})
