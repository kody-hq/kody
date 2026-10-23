import { expect, test, vi } from 'vitest'
import * as Sentry from '@sentry/cloudflare'
import {
	consoleError,
	consoleWarn,
	silenceExpectedConsoleErrors,
	silenceExpectedConsoleWarns,
} from '#worker/test-support/console-spies.ts'
import {
	getScheduledLaneCadence,
	isInlineScheduledLane,
	scheduledDispatchMaxRetries,
	type ScheduledLaneMessage,
} from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import { type JobsWorkerEnv } from './env.ts'
import {
	dispatchScheduledLanes,
	handleScheduledDispatchQueue,
	runScheduledLaneWithFailureIsolation,
} from './scheduled.ts'

vi.mock('./watchdog.ts', () => ({
	runJobScheduleWatchdogTick: vi.fn().mockResolvedValue({
		overdueJobCount: 0,
		stuckSkippedJobCount: 0,
		repairedStuckJobCount: 0,
		usersSynced: 0,
		usersFailedSync: 0,
		usersSkippedCap: 0,
		scanTruncated: false,
		alerted: false,
	}),
}))

const { runJobScheduleWatchdogTick } = await import('./watchdog.ts')

function createEnv(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		JOBS_DB: {} as D1Database,
		JOB_MANAGER: {} as DurableObjectNamespace,
		HOST: {
			runScheduledLane: vi.fn().mockResolvedValue('completed'),
		},
		...overrides,
	} as unknown as JobsWorkerEnv
}

function message(
	lane: ScheduledLaneMessage['lane'],
	scheduledTime = Date.UTC(2026, 0, 1, 12, 0),
): ScheduledLaneMessage {
	return { lane, scheduledTime, cron: '*/5 * * * *' }
}

function dispatch(env: JobsWorkerEnv, scheduledTime: number) {
	return dispatchScheduledLanes({
		controller: { scheduledTime, cron: '*/5 * * * *' } as ScheduledController,
		env,
	})
}

function queueMessage(input: {
	id?: string
	body: unknown
	attempts?: number
}) {
	return {
		id: input.id ?? 'msg',
		body: input.body,
		attempts: input.attempts ?? 1,
		ack: vi.fn(),
		retry: vi.fn(),
	}
}

test('lane routing forwards platform work to HOST, runs watchdog locally, and acks invalid queue bodies', async () => {
	vi.mocked(runJobScheduleWatchdogTick).mockClear()
	const env = createEnv()
	await expect(
		runScheduledLaneWithFailureIsolation({
			env,
			message: message('oauth_purge_expired'),
		}),
	).resolves.toBe('completed')
	expect(env.HOST.runScheduledLane).toHaveBeenCalledWith(
		message('oauth_purge_expired'),
	)
	expect(runJobScheduleWatchdogTick).not.toHaveBeenCalled()

	vi.mocked(runJobScheduleWatchdogTick).mockClear()
	vi.mocked(env.HOST.runScheduledLane).mockClear()
	await expect(
		runScheduledLaneWithFailureIsolation({
			env,
			message: message('job_schedule_watchdog'),
		}),
	).resolves.toBe('completed')
	expect(runJobScheduleWatchdogTick).toHaveBeenCalledOnce()
	expect(env.HOST.runScheduledLane).not.toHaveBeenCalled()

	consoleError.mockImplementation(() => {})
	const invalidAck = vi.fn()
	const validAck = vi.fn()
	vi.mocked(env.HOST.runScheduledLane).mockClear()
	await handleScheduledDispatchQueue(
		{
			messages: [
				{ id: 'bad', body: { lane: 'nope' }, ack: invalidAck },
				{
					id: 'good',
					body: message('repo_session_cleanup'),
					ack: validAck,
				},
			],
		} as unknown as MessageBatch<unknown>,
		env,
	)
	expect(invalidAck).toHaveBeenCalledOnce()
	expect(validAck).toHaveBeenCalledOnce()
	expect(env.HOST.runScheduledLane).toHaveBeenCalledTimes(1)
	expect(env.HOST.runScheduledLane).toHaveBeenCalledWith(
		message('repo_session_cleanup'),
	)
})

test('cron dispatch enqueues cadence lanes, or runs them directly when the queue is missing', async () => {
	const send = vi.fn().mockResolvedValue(undefined)
	const queuedEnv = createEnv({ SCHEDULED_DISPATCH_QUEUE: { send } })
	const scheduledTime = Date.UTC(2026, 0, 1, 12, 0)
	await dispatch(queuedEnv, scheduledTime)
	const cadence = getScheduledLaneCadence(new Date(scheduledTime))
	const queuedLanes = cadence.filter((lane) => !isInlineScheduledLane(lane))
	expect(send).toHaveBeenCalledTimes(queuedLanes.length)
	for (const lane of ['retention', 'unverified_account_purge']) {
		expect(send).toHaveBeenCalledWith({
			lane,
			scheduledTime,
			cron: '*/5 * * * *',
		})
	}
	expect(send).not.toHaveBeenCalledWith(
		expect.objectContaining({ lane: 'dlq_depth_alert' }),
	)
	expect(queuedEnv.HOST.runScheduledLane).toHaveBeenCalledTimes(1)
	expect(queuedEnv.HOST.runScheduledLane).toHaveBeenCalledWith({
		lane: 'dlq_depth_alert',
		scheduledTime,
		cron: '*/5 * * * *',
	})

	const directEnv = createEnv()
	const directTime = Date.UTC(2026, 0, 1, 12, 10)
	await dispatch(directEnv, directTime)
	expect(directEnv.HOST.runScheduledLane).toHaveBeenCalledTimes(
		getScheduledLaneCadence(new Date(directTime)).length,
	)
})

test('retryable D1 lock contention is distinguished from ordinary failures', async () => {
	consoleWarn.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
	for (const [error, outcome] of [
		['D1_ERROR: database is locked', 'd1_lock_contention'],
		['boom', 'failed'],
	] as const) {
		const env = createEnv({
			HOST: { runScheduledLane: vi.fn().mockRejectedValue(new Error(error)) },
		})
		await expect(
			runScheduledLaneWithFailureIsolation({
				env,
				message: message('retention'),
			}),
		).resolves.toBe(outcome)
	}
})

test('queue consumer acks completed and terminal work, retries lock contention with backoff, and preserves scheduledTime', async () => {
	silenceExpectedConsoleWarns([
		'scheduled_lane_d1_lock_contention lane=retention',
	])
	silenceExpectedConsoleErrors([
		'scheduled_lane_failed lane=retention',
		'scheduled_lane_message_invalid',
		'scheduled_lane_terminal_not_retried',
		'scheduled_lane_retry_exhausted',
	])
	const captureMessage = vi.spyOn(Sentry, 'captureMessage')
	const scheduledTime = Date.UTC(2026, 0, 1, 12, 0)
	const retention = message('retention', scheduledTime)
	const host = vi
		.fn()
		.mockResolvedValueOnce('completed')
		.mockResolvedValueOnce('d1_lock_contention')
		.mockResolvedValueOnce('failed')
		.mockResolvedValueOnce('d1_lock_contention')
	const env = createEnv({ HOST: { runScheduledLane: host } })

	const completed = queueMessage({ id: 'completed', body: retention })
	const lock = queueMessage({ id: 'lock', body: retention, attempts: 1 })
	const failed = queueMessage({ id: 'failed', body: retention })
	const invalid = queueMessage({
		id: 'invalid',
		body: { lane: 'nope' },
	})
	const exhausted = queueMessage({
		id: 'exhausted',
		body: retention,
		attempts: scheduledDispatchMaxRetries + 1,
	})

	await handleScheduledDispatchQueue(
		{
			messages: [completed, lock, failed, invalid, exhausted],
		} as unknown as MessageBatch<unknown>,
		env,
	)

	expect(completed.ack).toHaveBeenCalledOnce()
	expect(completed.retry).not.toHaveBeenCalled()
	expect(lock.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 10 })
	expect(lock.ack).not.toHaveBeenCalled()
	expect(failed.ack).toHaveBeenCalledOnce()
	expect(failed.retry).not.toHaveBeenCalled()
	expect(invalid.ack).toHaveBeenCalledOnce()
	expect(invalid.retry).not.toHaveBeenCalled()
	expect(exhausted.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 90 })
	expect(exhausted.ack).not.toHaveBeenCalled()
	expect(consoleError).toHaveBeenCalledWith(
		'scheduled_lane_terminal_not_retried',
		expect.objectContaining({
			lane: 'retention',
			scheduledTime,
			attempts: 1,
			outcome: 'failed',
		}),
	)

	expect(consoleError).toHaveBeenCalledWith(
		'scheduled_lane_message_invalid',
		expect.objectContaining({ queueMessageId: 'invalid' }),
	)

	expect(consoleError).toHaveBeenCalledWith(
		'scheduled_lane_retry_exhausted',
		expect.objectContaining({
			lane: 'retention',
			scheduledTime,
			attempts: scheduledDispatchMaxRetries + 1,
			outcome: 'd1_lock_contention',
		}),
	)
	expect(captureMessage).toHaveBeenCalledWith(
		'scheduled_lane_retry_exhausted lane=retention',
	)

	expect(host).toHaveBeenCalledTimes(4)
	for (const call of host.mock.calls) {
		expect(call[0]).toEqual(retention)
	}

	const laterLock = queueMessage({
		id: 'later-lock',
		body: retention,
		attempts: 2,
	})
	host.mockResolvedValueOnce('d1_lock_contention')
	await handleScheduledDispatchQueue(
		{ messages: [laterLock] } as unknown as MessageBatch<unknown>,
		env,
	)
	expect(laterLock.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
	expect(laterLock.ack).not.toHaveBeenCalled()
})

test('failed queue sends fall back inline for that lane only, keep scheduledTime, and do not invent extra lane retries', async () => {
	silenceExpectedConsoleErrors([
		'scheduled_lane_dispatch_failed lane=oauth_purge_expired',
		'scheduled_lane_inline_d1_lock_contention',
	])
	const host = vi.fn(async (message: ScheduledLaneMessage) =>
		message.lane === 'dlq_depth_alert' ? 'completed' : 'd1_lock_contention',
	)
	const failingSend = vi.fn(async (body: ScheduledLaneMessage) => {
		if (body.lane === 'oauth_purge_expired') {
			throw new Error('queue unavailable')
		}
	})
	const env = createEnv({
		HOST: { runScheduledLane: host },
		SCHEDULED_DISPATCH_QUEUE: { send: failingSend },
	})
	const fallbackTime = Date.UTC(2026, 0, 1, 12, 10)
	await dispatch(env, fallbackTime)
	expect(host.mock.calls.map((call) => call[0])).toEqual([
		{
			lane: 'dlq_depth_alert',
			scheduledTime: fallbackTime,
			cron: '*/5 * * * *',
		},
		{
			lane: 'oauth_purge_expired',
			scheduledTime: fallbackTime,
			cron: '*/5 * * * *',
		},
	])
	expect(consoleError).toHaveBeenCalledWith(
		'scheduled_lane_inline_d1_lock_contention',
		expect.objectContaining({
			lane: 'oauth_purge_expired',
			scheduledTime: fallbackTime,
		}),
	)
})
