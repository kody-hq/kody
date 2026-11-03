import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	applyJobRunObservabilityToJobView,
	hydrateJobViewFromRunLog,
	hydrateJobViewsFromRunLog,
} from './job-run-observability-hydrate.ts'
import type { JobView } from './types.ts'

const getJobRunObservability = vi.hoisted(() => vi.fn())
const getJobRunObservabilityBatch = vi.hoisted(() => vi.fn())

vi.mock('#worker/run-records/service.ts', () => ({
	getJobRunObservability: (...args: Array<unknown>) =>
		getJobRunObservability(...args),
	getJobRunObservabilityBatch: (...args: Array<unknown>) =>
		getJobRunObservabilityBatch(...args),
}))

function createJobView(overrides: Partial<JobView> = {}): JobView {
	return {
		version: 1,
		id: 'job-1',
		name: 'Daily digest',
		sourceId: 'source-1',
		publishedCommit: null,
		storageId: 'job:job-1',
		schedule: { type: 'interval', every: '1d' },
		scheduleSummary: 'Runs every 1d',
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		expiresAt: null,
		createdAt: '2026-04-20T00:00:00.000Z',
		updatedAt: '2026-04-20T00:00:00.000Z',
		nextRunAt: '2026-04-21T00:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		...overrides,
	}
}

test('job view hydrate overlays RunLog outcomes for point and batch reads', async () => {
	const job = createJobView({
		lastRunAt: '2026-04-20T09:00:00.000Z',
		lastRunStatus: 'success',
	})
	expect(
		applyJobRunObservabilityToJobView(job, {
			jobId: 'job-1',
			lastRunAt: '2026-04-20T10:00:00.000Z',
			lastRunStatus: 'error',
			lastRunError: 'boom',
			lastDurationMs: 42,
			runCount: 4,
			successCount: 3,
			errorCount: 1,
			updatedAt: '2026-04-20T10:00:00.000Z',
		}),
	).toMatchObject({
		lastRunAt: '2026-04-20T10:00:00.000Z',
		lastRunStatus: 'error',
		lastRunError: 'boom',
		lastDurationMs: 42,
		runCount: 4,
		successCount: 3,
		errorCount: 1,
	})
	expect(
		applyJobRunObservabilityToJobView(
			createJobView({
				lastRunAt: '2026-04-20T09:00:00.000Z',
				lastRunStatus: 'success',
				lastRunError: 'stale D1 error',
				lastDurationMs: 999,
				runCount: 9,
				successCount: 8,
				errorCount: 1,
			}),
			null,
		),
	).toEqual(
		expect.objectContaining({
			lastRunAt: '2026-04-20T09:00:00.000Z',
			lastRunStatus: 'success',
			lastRunError: undefined,
			lastDurationMs: undefined,
			runCount: 0,
			successCount: 0,
			errorCount: 0,
		}),
	)

	const env = {} as Env
	getJobRunObservability.mockResolvedValue({
		jobId: 'job-1',
		lastRunAt: '2026-04-20T10:00:00.000Z',
		lastRunStatus: 'success',
		lastRunError: null,
		lastDurationMs: 12,
		runCount: 1,
		successCount: 1,
		errorCount: 0,
		updatedAt: '2026-04-20T10:00:00.000Z',
	})
	getJobRunObservabilityBatch.mockResolvedValue([
		{
			jobId: 'job-a',
			lastRunAt: '2026-04-20T11:00:00.000Z',
			lastRunStatus: 'error',
			lastRunError: 'nope',
			lastDurationMs: 9,
			runCount: 2,
			successCount: 1,
			errorCount: 1,
			updatedAt: '2026-04-20T11:00:00.000Z',
		},
	])

	const point = await hydrateJobViewFromRunLog({
		env,
		userId: ownerIdFromStored('user-1'),
		job: createJobView({ id: 'job-1' }),
	})
	expect(getJobRunObservability).toHaveBeenCalledWith({
		env,
		userId: ownerIdFromStored('user-1'),
		jobId: 'job-1',
	})
	expect(point).toMatchObject({
		runCount: 1,
		successCount: 1,
		lastDurationMs: 12,
	})

	const batch = await hydrateJobViewsFromRunLog({
		env,
		userId: ownerIdFromStored('user-1'),
		jobs: [
			createJobView({ id: 'job-a' }),
			createJobView({
				id: 'job-b',
				lastRunError: 'stale D1 error',
				lastDurationMs: 999,
				runCount: 9,
				successCount: 8,
				errorCount: 1,
			}),
		],
	})
	expect(getJobRunObservabilityBatch).toHaveBeenCalledWith({
		env,
		userId: ownerIdFromStored('user-1'),
		jobIds: ['job-a', 'job-b'],
	})
	expect(batch[0]).toMatchObject({
		id: 'job-a',
		lastRunError: 'nope',
		runCount: 2,
		errorCount: 1,
	})
	expect(batch[1]).toMatchObject({
		id: 'job-b',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		lastRunError: undefined,
		lastDurationMs: undefined,
	})
})
