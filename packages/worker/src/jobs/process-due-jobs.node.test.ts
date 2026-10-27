import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { processDueJobs } from './process-due-jobs.ts'
import { type JobRecord } from './types.ts'

test('processDueJobs advances next_run_at from the claimed occurrence, not wall clock', async () => {
	const scheduledFor = '2026-04-12T07:00:00.000Z'
	const lateNow = new Date('2026-04-12T12:30:00.000Z')
	const hourly = createCronJob({
		id: 'hourly-job',
		schedule: { type: 'cron', expression: '0 * * * *' },
		nextRunAt: scheduledFor,
	})
	const result = await processDueJobs({
		jobs: [hourly],
		now: lateNow,
		scheduledFor,
		async executeJob() {
			return {
				execution: { ok: true, logs: [], result: { ok: true } },
				startedAt: lateNow.toISOString(),
				finishedAt: lateNow.toISOString(),
				durationMs: 0,
			}
		},
	})
	// Next after the 07:00 occurrence is 08:00, not 13:00 from wall clock.
	expect(result.saveJobs[0]?.nextRunAt).toBe('2026-04-12T08:00:00.000Z')
	expect(result.jobOutcomes[0]?.nextRunAt).toBe('2026-04-12T08:00:00.000Z')
})

function createCronJob(overrides: Partial<JobRecord> = {}): JobRecord {
	return {
		version: 1,
		id: 'job-1',
		userId: ownerIdFromStored('user-1'),
		name: 'Morning job',
		sourceId: 'source-1',
		publishedCommit: null,
		storageId: 'job:job-1',
		schedule: {
			type: 'cron',
			expression: '0 7 * * *',
		},
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		expiresAt: null,
		createdAt: '2026-04-12T00:00:00.000Z',
		updatedAt: '2026-04-12T00:00:00.000Z',
		nextRunAt: '2026-04-12T07:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		...overrides,
	}
}

test('processDueJobs handles cron batching and reschedule outcomes', async () => {
	const now = new Date('2026-04-12T07:00:00.000Z')
	const first = createCronJob({ id: 'job-1' })
	const second = createCronJob({ id: 'job-2', name: 'Second job' })

	const batchResult = await processDueJobs({
		jobs: [first, second],
		now,
		async executeJob(job) {
			if (job.id === 'job-1') {
				throw new Error('boom')
			}
			return {
				execution: {
					ok: true,
					logs: ['ok'],
					result: { ok: true },
				},
				startedAt: now.toISOString(),
				finishedAt: now.toISOString(),
				durationMs: 0,
			}
		},
	})

	expect(batchResult.saveJobs).toHaveLength(2)
	expect(batchResult.successCount).toBe(1)
	expect(batchResult.errorCount).toBe(1)
	expect(batchResult.jobOutcomes).toEqual([
		{
			jobId: 'job-1',
			scheduleType: 'cron',
			outcome: 'failure',
			nextRunAt: expect.any(String),
			deleted: false,
			error: 'boom',
		},
		{
			jobId: 'job-2',
			scheduleType: 'cron',
			outcome: 'success',
			nextRunAt: expect.any(String),
			deleted: false,
		},
	])
	expect(batchResult.saveJobs).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: 'job-1',
				lastRunStatus: 'error',
				lastRunAt: now.toISOString(),
				// RunLog owns counters/error/duration; D1 copies stay put.
				runCount: 0,
				successCount: 0,
				errorCount: 0,
			}),
			expect.objectContaining({
				id: 'job-2',
				lastRunStatus: 'success',
				lastRunAt: now.toISOString(),
				runCount: 0,
				successCount: 0,
				errorCount: 0,
			}),
		]),
	)
	expect(
		batchResult.saveJobs.find((job) => job.id === 'job-1')?.lastRunError,
	).toBeUndefined()
	expect(batchResult.saveJobs[0]).not.toHaveProperty('runHistory')
	expect(batchResult.saveJobs[1]).not.toHaveProperty('runHistory')

	const cronJob = createCronJob({
		id: 'job-reschedule-failure',
		schedule: {
			type: 'cron',
			expression: '* *',
		},
		nextRunAt: '2026-04-12T07:00:00.000Z',
	})
	const rescheduleFailureResult = await processDueJobs({
		jobs: [cronJob],
		now,
		async executeJob() {
			return {
				execution: {
					ok: true,
					logs: ['ok'],
					result: { ok: true },
				},
				startedAt: '2026-04-12T07:00:00.000Z',
				finishedAt: '2026-04-12T07:00:00.000Z',
				durationMs: 0,
			}
		},
	})
	expect(rescheduleFailureResult.saveJobs).toHaveLength(1)
	expect(rescheduleFailureResult.successCount).toBe(0)
	expect(rescheduleFailureResult.errorCount).toBe(1)
	expect(rescheduleFailureResult.jobOutcomes).toEqual([
		{
			jobId: 'job-reschedule-failure',
			scheduleType: 'cron',
			outcome: 'failure',
			nextRunAt: '2026-04-12T07:00:00.000Z',
			deleted: false,
			error:
				'Cron expressions must use standard 5-field syntax: minute hour day-of-month month day-of-week.',
			rescheduleError:
				'Cron expressions must use standard 5-field syntax: minute hour day-of-month month day-of-week.',
		},
	])
	expect(rescheduleFailureResult.saveJobs[0]).toEqual(
		expect.objectContaining({
			id: 'job-reschedule-failure',
			enabled: false,
			disabledReason:
				"Kody could not compute the next run from the job's schedule (Cron expressions must use standard 5-field syntax: minute hour day-of-month month day-of-week.).",
			lastRunStatus: 'error',
			runCount: 0,
			successCount: 0,
			errorCount: 0,
		}),
	)
})
