import { expect, test, vi } from 'vitest'
import { silenceExpectedConsoleErrors } from '#worker/test-support/console-spies.ts'
import {
	jobD1UnavailableRearmDelayMs,
	tryRearmAlarmForRetryableD1Failure,
} from './manager-alarm-deferral.ts'

type JobManagerAlarmHarness = {
	ctx: {
		blockConcurrencyWhile: <T>(callback: () => Promise<T>) => Promise<T>
		storage: {
			get: (key: string) => Promise<string | undefined>
			getAlarm: () => Promise<number | null>
			setAlarm: (atMs: number) => Promise<void>
			deleteAlarm: () => Promise<void>
		}
	}
	env: {
		HOST: {
			runDueJobsForUser: (input: { userId: string }) => Promise<{
				dueJobCount: number
				successCount: number
				errorCount: number
				jobOutcomes: Array<unknown>
			}>
		}
	}
	syncAlarm?: (input: {
		userId: string
		source?: 'alarm' | 'rpc' | 'run_now'
	}) => Promise<unknown>
	alarm: (alarmInfo?: {
		retryCount?: number
		isRetry?: boolean
	}) => Promise<void>
}

test('tryRearmAlarmForRetryableD1Failure rearms on long-running export and skips other errors', async () => {
	const setAlarm = vi.fn(async (_atMs: number) => undefined)
	const nowMs = Date.UTC(2026, 9, 16, 12, 0, 0)
	const deferred = await tryRearmAlarmForRetryableD1Failure({
		setAlarm,
		userId: 'user-1',
		error: new Error('D1_ERROR: Currently processing a long-running export.'),
		phase: 'run_due_jobs',
		retryCount: 3,
		isRetry: true,
		nowMs,
	})
	expect(deferred).toBe(true)
	expect(setAlarm).toHaveBeenCalledTimes(1)
	expect(setAlarm).toHaveBeenCalledWith(nowMs + jobD1UnavailableRearmDelayMs)

	setAlarm.mockClear()
	const notDeferred = await tryRearmAlarmForRetryableD1Failure({
		setAlarm,
		userId: 'user-1',
		error: new Error('something else exploded'),
		phase: 'sync_alarm',
		nowMs,
	})
	expect(notDeferred).toBe(false)
	expect(setAlarm).not.toHaveBeenCalled()
})

test('tryRearmAlarmForRetryableD1Failure keeps an earlier armed alarm', async () => {
	const setAlarm = vi.fn(async (_atMs: number) => undefined)
	const nowMs = Date.UTC(2026, 9, 16, 12, 0, 0)
	const earlierAtMs = nowMs + 5_000
	const deferred = await tryRearmAlarmForRetryableD1Failure({
		setAlarm,
		getAlarm: async () => earlierAtMs,
		userId: 'user-1',
		error: new Error('D1_ERROR: Currently processing a long-running export.'),
		phase: 'run_due_jobs',
		nowMs,
	})
	expect(deferred).toBe(true)
	expect(setAlarm).toHaveBeenCalledWith(earlierAtMs)
})

test('JobManager alarm defers retryable D1 failures without rethrowing', async () => {
	silenceExpectedConsoleErrors(['job-scheduler'])
	const { JobManagerBase } = await import('./manager-do.ts')

	const setAlarm = vi.fn(async (_atMs: number) => undefined)
	const getAlarm = vi.fn(async () => null)
	const deleteAlarm = vi.fn(async () => undefined)
	const storageGet = vi.fn(async (key: string) =>
		key === 'user-id' ? 'user-1' : undefined,
	)
	const runDueJobsForUser = vi
		.fn()
		.mockRejectedValue(
			new Error('D1_ERROR: Currently processing a long-running export.'),
		)
	const syncAlarm = vi.fn()

	const state = {
		blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
		storage: {
			get: storageGet,
			getAlarm,
			setAlarm,
			deleteAlarm,
		},
	}
	const manager = new (JobManagerBase as unknown as new (
		state: unknown,
		env: unknown,
	) => JobManagerAlarmHarness)(state, {
		HOST: { runDueJobsForUser },
	})
	manager.syncAlarm = syncAlarm

	await expect(
		manager.alarm({ retryCount: 3, isRetry: true }),
	).resolves.toBeUndefined()
	expect(runDueJobsForUser).toHaveBeenCalledWith({ userId: 'user-1' })
	expect(setAlarm).toHaveBeenCalledTimes(1)
	const armedAt = setAlarm.mock.calls[0]?.[0]
	expect(typeof armedAt).toBe('number')
	expect(armedAt).toBeGreaterThan(Date.now())
	expect(armedAt).toBeLessThanOrEqual(
		Date.now() + jobD1UnavailableRearmDelayMs + 1_000,
	)
	expect(syncAlarm).not.toHaveBeenCalled()
})

test('JobManager alarm still rethrows non-retryable runDueJobs failures', async () => {
	silenceExpectedConsoleErrors(['job-scheduler'])
	const { JobManagerBase } = await import('./manager-do.ts')

	const setAlarm = vi.fn(async (_atMs: number) => undefined)
	const storageGet = vi.fn(async (key: string) =>
		key === 'user-id' ? 'user-1' : undefined,
	)
	const runDueJobsForUser = vi
		.fn()
		.mockRejectedValue(new Error('permanent job host failure'))

	const state = {
		blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
		storage: {
			get: storageGet,
			getAlarm: vi.fn(async () => null),
			setAlarm,
			deleteAlarm: vi.fn(async () => undefined),
		},
	}
	const manager = new (JobManagerBase as unknown as new (
		state: unknown,
		env: unknown,
	) => JobManagerAlarmHarness)(state, {
		HOST: { runDueJobsForUser },
	})

	await expect(manager.alarm()).rejects.toThrow('permanent job host failure')
	expect(setAlarm).not.toHaveBeenCalled()
})

test('JobManager alarm defers retryable D1 failures from syncAlarm', async () => {
	silenceExpectedConsoleErrors(['job-scheduler'])
	const { JobManagerBase } = await import('./manager-do.ts')

	const setAlarm = vi.fn(async (_atMs: number) => undefined)
	const storageGet = vi.fn(async (key: string) =>
		key === 'user-id' ? 'user-1' : undefined,
	)
	const runDueJobsForUser = vi.fn().mockResolvedValue({
		dueJobCount: 0,
		successCount: 0,
		errorCount: 0,
		jobOutcomes: [],
	})
	const syncAlarm = vi
		.fn()
		.mockRejectedValue(
			new Error('D1_ERROR: Currently processing a long-running export.'),
		)

	const state = {
		blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
		storage: {
			get: storageGet,
			getAlarm: vi.fn(async () => null),
			setAlarm,
			deleteAlarm: vi.fn(async () => undefined),
		},
	}
	const manager = new (JobManagerBase as unknown as new (
		state: unknown,
		env: unknown,
	) => JobManagerAlarmHarness)(state, {
		HOST: { runDueJobsForUser },
	})
	manager.syncAlarm = syncAlarm

	await expect(manager.alarm()).resolves.toBeUndefined()
	expect(syncAlarm).toHaveBeenCalledWith({ userId: 'user-1', source: 'alarm' })
	expect(setAlarm).toHaveBeenCalledTimes(1)
})
