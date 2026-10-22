import { isRetryableD1LockError } from '@kody-internal/shared/d1-retry.ts'
import {
	logJobSchedulerEvent,
	schedulerErrorFields,
} from '@kody-internal/shared/jobs/scheduler-logging.ts'
import { isWorkersHungRequestCanceledError } from '@kody-internal/shared/workers-hung-request.ts'

/**
 * Backoff when JobManager alarm work hits a transient D1 platform lock/export
 * blip. Longer than the 1s backlog rearm so we do not hammer an in-progress
 * Cloudflare D1 REST/API export.
 */
export const jobD1UnavailableRearmDelayMs = 30_000

/**
 * When `error` is a retryable D1 lock/export blip, arm a short-backoff alarm
 * and return true so the Durable Object alarm handler can return without
 * rethrowing (preserving CF alarm retries and ensuring a follow-up wake).
 * Non-retryable errors return false; the caller should rethrow.
 *
 * If an earlier alarm is already armed (for example a concurrent `syncAlarm`
 * that scheduled a nearer wake), keep that earlier time instead of pushing it
 * out to the D1 backoff.
 */
export async function tryRearmAlarmForRetryableD1Failure(input: {
	setAlarm: (atMs: number) => Promise<void>
	getAlarm?: () => Promise<number | null>
	userId: string
	error: unknown
	phase: 'run_due_jobs' | 'sync_alarm'
	retryCount?: number
	isRetry?: boolean
	nowMs?: number
}): Promise<boolean> {
	if (!isRetryableD1LockError(input.error)) {
		return false
	}
	const proposedAtMs =
		(input.nowMs ?? Date.now()) + jobD1UnavailableRearmDelayMs
	const currentAlarmAt = input.getAlarm ? await input.getAlarm() : null
	const alarmAtMs =
		currentAlarmAt != null && currentAlarmAt < proposedAtMs
			? currentAlarmAt
			: proposedAtMs
	await input.setAlarm(alarmAtMs)
	logJobSchedulerEvent({
		event: 'alarm_deferred_d1_unavailable',
		userId: input.userId,
		reason: input.phase,
		retryCount: input.retryCount,
		isRetry: input.isRetry,
		nextRunAt: new Date(alarmAtMs).toISOString(),
		currentAlarmAt:
			currentAlarmAt == null ? null : new Date(currentAlarmAt).toISOString(),
		...schedulerErrorFields(input.error),
	})
	return true
}

/**
 * When HOST.runDueJobsForUser was canceled as a hung Workers request, settle
 * claimed jobs on a fresh HOST RPC and return true so the alarm can syncAlarm
 * and complete without rethrowing (CF alarm retries would re-hang).
 */
export async function trySettleHungRunDueJobsFailure(input: {
	settleHungDueJobsForUser: (args: {
		userId: string
	}) => Promise<{ settledCount: number }>
	userId: string
	error: unknown
	retryCount?: number
	isRetry?: boolean
}): Promise<boolean> {
	if (!isWorkersHungRequestCanceledError(input.error)) {
		return false
	}
	try {
		const settled = await input.settleHungDueJobsForUser({
			userId: input.userId,
		})
		logJobSchedulerEvent({
			event: 'alarm_hung_request_settled',
			userId: input.userId,
			retryCount: input.retryCount,
			isRetry: input.isRetry,
			errorCount: settled.settledCount,
			reason: 'workers_hung_request',
			...schedulerErrorFields(input.error),
		})
	} catch (settleError) {
		logJobSchedulerEvent({
			event: 'alarm_hung_request_settle_failed',
			userId: input.userId,
			retryCount: input.retryCount,
			isRetry: input.isRetry,
			reason: 'workers_hung_request',
			...schedulerErrorFields(settleError),
		})
	}
	return true
}
