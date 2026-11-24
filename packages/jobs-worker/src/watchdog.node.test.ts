import type { JobRow } from '@kody-internal/shared/jobs/repo.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import type { JobsWorkerEnv } from './env.ts'
import { runJobScheduleWatchdogTick } from './watchdog.ts'

const mocks = vi.hoisted(() => ({
	listOverdue: vi.fn(
		async (..._args: Array<unknown>): Promise<Array<unknown>> => [],
	),
	listStuck: vi.fn(
		async (..._args: Array<unknown>): Promise<Array<unknown>> => [],
	),
	getWorkerStateValue: vi.fn(
		async (..._args: Array<unknown>): Promise<string | null> => null,
	),
	putWorkerStateValue: vi.fn(async (..._args: Array<unknown>) => {}),
	captureMessage: vi.fn(),
}))

vi.mock('@kody-internal/shared/jobs/repo.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('@kody-internal/shared/jobs/repo.ts')>()
	return {
		...actual,
		listSilentlyOverdueJobRowsPage: (...args: Array<unknown>) =>
			mocks.listOverdue(...args),
		listStuckSkippedJobRowsPage: (...args: Array<unknown>) =>
			mocks.listStuck(...args),
	}
})

vi.mock('./store.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./store.ts')>()
	return {
		...actual,
		getWorkerStateValue: (...args: Array<unknown>) =>
			mocks.getWorkerStateValue(...args),
		putWorkerStateValue: (...args: Array<unknown>) =>
			mocks.putWorkerStateValue(...args),
	}
})

vi.mock('@sentry/cloudflare', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@sentry/cloudflare')>()
	return {
		...actual,
		withScope: (callback: (scope: unknown) => void) =>
			callback({ setTag: () => {}, setContext: () => {} }),
		captureMessage: (...args: Array<unknown>) => mocks.captureMessage(...args),
	}
})

const now = new Date('2026-11-24T12:00:00.000Z')

function overdueRow(
	jobId: string,
	userId: string,
	nextRunAt = '2026-11-24T11:00:00.000Z',
): JobRow {
	return {
		id: jobId,
		user_id: ownerIdFromStored(userId),
		next_run_at: nextRunAt,
		last_completed_scheduled_for: null,
	} as unknown as JobRow
}

function envWithManagers(
	syncAlarm: (userId: string) => Promise<unknown>,
): JobsWorkerEnv {
	return {
		JOBS_DB: {},
		JOB_MANAGER: {
			idFromName: (name: string) => name,
			get: (id: string) => ({
				syncAlarm: (input: { userId: string }) => {
					expect(input.userId).toBe(id)
					return syncAlarm(id)
				},
			}),
		},
	} as unknown as JobsWorkerEnv
}

test('overdue users are synced once each and the first overdue tick alerts and starts the cooldown', async () => {
	consoleWarn.mockImplementation(() => {})
	mocks.listOverdue.mockResolvedValueOnce([
		overdueRow('job-1', 'user-b'),
		overdueRow('job-2', 'user-a'),
		overdueRow('job-3', 'user-b'),
	])
	const synced: Array<string> = []

	const result = await runJobScheduleWatchdogTick({
		env: envWithManagers(async (userId) => {
			synced.push(userId)
			return { ok: true }
		}),
		now,
	})

	expect(synced).toEqual(['user-a', 'user-b'])
	expect(result).toEqual({
		overdueJobCount: 3,
		stuckSkippedJobCount: 0,
		repairedStuckJobCount: 0,
		usersSynced: 2,
		usersFailedSync: 0,
		usersSkippedCap: 0,
		scanTruncated: false,
		alerted: true,
	})
	expect(mocks.putWorkerStateValue).toHaveBeenCalledWith(
		{},
		'ops-alert:job-schedule-watchdog:v1',
		String(now.getTime()),
	)
	expect(mocks.captureMessage).toHaveBeenCalledTimes(1)
})

test('an overdue set inside the alert cooldown is re-synced but not re-alerted', async () => {
	consoleWarn.mockImplementation(() => {})
	mocks.listOverdue.mockResolvedValueOnce([overdueRow('job-1', 'user-a')])
	mocks.getWorkerStateValue.mockResolvedValueOnce(
		String(now.getTime() - 60 * 60_000),
	)

	const result = await runJobScheduleWatchdogTick({
		env: envWithManagers(async () => ({ ok: true })),
		now,
	})

	expect(result).toMatchObject({ usersSynced: 1, alerted: false })
	expect(mocks.putWorkerStateValue).not.toHaveBeenCalled()
	expect(mocks.captureMessage).not.toHaveBeenCalled()
})

test('a JobManager sync that never settles fails that user after a deadline, and the tick still syncs the rest and alerts', async () => {
	consoleWarn.mockImplementation(() => {})
	vi.useFakeTimers()
	try {
		mocks.listOverdue.mockResolvedValueOnce([
			overdueRow('job-1', 'user-a'),
			overdueRow('job-2', 'user-b'),
		])
		const synced: Array<string> = []
		const tick = runJobScheduleWatchdogTick({
			env: envWithManagers((userId) => {
				if (userId === 'user-a') return new Promise(() => {})
				synced.push(userId)
				return Promise.resolve({ ok: true })
			}),
			now,
		})
		let settled = false
		void tick.finally(() => {
			settled = true
		})
		for (let minute = 0; minute < 10 && !settled; minute += 1) {
			await vi.advanceTimersByTimeAsync(60_000)
		}

		expect(settled).toBe(true)
		const result = await tick
		expect(synced).toEqual(['user-b'])
		expect(result).toMatchObject({
			usersSynced: 1,
			usersFailedSync: 1,
			alerted: true,
		})
		expect(mocks.captureMessage).toHaveBeenCalledTimes(1)
	} finally {
		vi.useRealTimers()
	}
})

test('a failed alert cooldown read still alerts instead of failing the tick', async () => {
	consoleWarn.mockImplementation(() => {})
	mocks.listOverdue.mockResolvedValueOnce([overdueRow('job-1', 'user-a')])
	mocks.getWorkerStateValue.mockRejectedValueOnce(
		new Error('cooldown read failed'),
	)

	const result = await runJobScheduleWatchdogTick({
		env: envWithManagers(async () => ({ ok: true })),
		now,
	})

	expect(result).toMatchObject({ usersSynced: 1, alerted: true })
	expect(mocks.captureMessage).toHaveBeenCalledTimes(1)
})

test('past the per-tick user cap, the stalest owners are synced instead of the same late-sorting owners being skipped every tick', async () => {
	consoleWarn.mockImplementation(() => {})
	const fresh = Array.from({ length: 50 }, (_, index) =>
		overdueRow(`job-a${index}`, `user-a${String(index).padStart(2, '0')}`),
	)
	const stale = Array.from({ length: 10 }, (_, index) =>
		overdueRow(`job-z${index}`, `user-z${index}`, '2026-11-20T00:00:00.000Z'),
	)
	mocks.listOverdue.mockResolvedValueOnce([...fresh, ...stale])
	const synced: Array<string> = []

	const result = await runJobScheduleWatchdogTick({
		env: envWithManagers(async (userId) => {
			synced.push(userId)
			return { ok: true }
		}),
		now,
	})

	expect(synced).toHaveLength(50)
	expect(new Set(synced).size).toBe(50)
	for (const row of stale) expect(synced).toContain(row.user_id)
	expect(result).toMatchObject({
		usersSynced: 50,
		usersFailedSync: 0,
		usersSkippedCap: 10,
		alerted: true,
	})
})

test('hung JobManager syncs run a few at a time, so the tick reaches the alert lane long before the cron limit', async () => {
	consoleWarn.mockImplementation(() => {})
	vi.useFakeTimers()
	try {
		mocks.listOverdue.mockResolvedValueOnce(
			Array.from({ length: 10 }, (_, index) =>
				overdueRow(`job-${index}`, `user-${index}`),
			),
		)
		const tick = runJobScheduleWatchdogTick({
			env: envWithManagers(() => new Promise(() => {})),
			now,
		})
		let settled = false
		void tick.finally(() => {
			settled = true
		})
		await vi.advanceTimersByTimeAsync(61_000)

		expect(settled).toBe(true)
		expect(await tick).toMatchObject({
			usersSynced: 0,
			usersFailedSync: 10,
			alerted: true,
		})
		expect(mocks.captureMessage).toHaveBeenCalledTimes(1)
	} finally {
		vi.useRealTimers()
	}
})

test('a failed alert cooldown write still alerts instead of failing the tick', async () => {
	consoleWarn.mockImplementation(() => {})
	mocks.listOverdue.mockResolvedValueOnce([overdueRow('job-1', 'user-a')])
	mocks.putWorkerStateValue.mockRejectedValueOnce(
		new Error('cooldown write failed'),
	)

	const result = await runJobScheduleWatchdogTick({
		env: envWithManagers(async () => ({ ok: true })),
		now,
	})

	expect(result).toMatchObject({ usersSynced: 1, alerted: true })
	expect(mocks.captureMessage).toHaveBeenCalledTimes(1)
})
