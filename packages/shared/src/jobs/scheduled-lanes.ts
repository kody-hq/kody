/**
 * Scheduled-lane names, queue message shape, and cron cadence shared between
 * the jobs worker (which owns the `*​/5 * * * *` cron trigger and the
 * scheduled dispatch queue, ADR 0016) and the main worker (which executes the
 * platform lanes via the `JobsHost` service binding).
 */

export const scheduledLaneNames = [
	'reconcile_artifacts_pushes',
	'repo_session_cleanup',
	'reconcile_inbound_deliveries',
	'system_email_retention',
	'storage_bucket_estimate_backfill',
	'community_listing_behind_backfill',
	'd1_storage_reconciliation',
	'second_agent_gift_reconciliation',
	'oauth_purge_expired',
	'retention',
	'unverified_account_purge',
	'soft_delete_purge',
	'usage_aggregation',
	'durable_object_duration_attribution',
	'auth_denial_alert',
	'dlq_depth_alert',
	'email_delivery_alert',
	'email_verification_stall_alert',
	'usage_entitlement_alert',
	'kit_subscriber_sync',
	'dr_export',
	'dr_export_watchdog',
	'job_schedule_watchdog',
	'fleet_users_affected_alert',
	'org_audit_outbox',
	'package_app_custom_hostnames_reconcile',
	'follow_maintenance',
] as const

export type ScheduledLaneName = (typeof scheduledLaneNames)[number]

export type ScheduledLaneMessage = {
	lane: ScheduledLaneName
	scheduledTime: number
	cron: string
}

/**
 * Isolated lane results shared by the jobs-worker consumer and origin
 * `JobsHost.runScheduledLane`. `d1_lock_contention` is the only replay-safe
 * transient outcome: the D1 write did not commit. `failed` may include
 * partial external side effects (alerts, billing, Kit, DR), so the queue
 * consumer must not retry it.
 */
export type ScheduledLaneOutcome = 'completed' | 'd1_lock_contention' | 'failed'

export const scheduledDispatchMaxRetries = 3
const scheduledDispatchRetryBaseDelaySeconds = 10
const scheduledDispatchRetryDelayFactor = 3
const scheduledDispatchRetryDelayCapSeconds = 90

export type ScheduledLaneQueueAction =
	| { action: 'ack'; reason: 'completed' }
	| { action: 'ack'; reason: 'terminal_failure' }
	| {
			action: 'retry'
			reason: 'transient_failure' | 'retry_exhausted'
			delaySeconds: number
	  }

function scheduledDispatchRetryDelaySeconds(attempts: number) {
	return Math.min(
		scheduledDispatchRetryBaseDelaySeconds *
			scheduledDispatchRetryDelayFactor ** Math.max(attempts - 1, 0),
		scheduledDispatchRetryDelayCapSeconds,
	)
}

export function resolveScheduledLaneQueueAction(input: {
	outcome: ScheduledLaneOutcome
	attempts: number
}): ScheduledLaneQueueAction {
	switch (input.outcome) {
		case 'completed':
			return { action: 'ack', reason: 'completed' }
		case 'failed':
			return { action: 'ack', reason: 'terminal_failure' }
		case 'd1_lock_contention':
			return {
				action: 'retry',
				reason:
					input.attempts > scheduledDispatchMaxRetries
						? 'retry_exhausted'
						: 'transient_failure',
				delaySeconds: scheduledDispatchRetryDelaySeconds(input.attempts),
			}
		default: {
			const exhaustive: never = input.outcome
			throw new Error(`Unhandled scheduled lane outcome: ${String(exhaustive)}`)
		}
	}
}

/**
 * Lanes the jobs worker executes locally (against its own database and
 * Durable Objects). Every other lane is forwarded to the main worker's
 * `JobsHost.runScheduledLane`.
 */
export const jobsWorkerLocalLanes = ['job_schedule_watchdog'] as const

export type JobsWorkerLocalLane = (typeof jobsWorkerLocalLanes)[number]

/**
 * Lanes the cron runs directly on JobsHost instead of
 * `kody-scheduled-dispatch`. The DLQ depth alert watches that queue's
 * dead-letter queue, so the check cannot depend on the queue to be delivered.
 */
export const inlineScheduledLanes = [
	'dlq_depth_alert',
] as const satisfies ReadonlyArray<ScheduledLaneName>

export function isInlineScheduledLane(
	lane: ScheduledLaneName,
): lane is (typeof inlineScheduledLanes)[number] {
	return (inlineScheduledLanes as ReadonlyArray<string>).includes(lane)
}

export function isJobsWorkerLocalLane(
	lane: ScheduledLaneName,
): lane is JobsWorkerLocalLane {
	return (jobsWorkerLocalLanes as ReadonlyArray<string>).includes(lane)
}

export function isScheduledLaneName(
	value: unknown,
): value is ScheduledLaneName {
	return (
		typeof value === 'string' &&
		(scheduledLaneNames as ReadonlyArray<string>).includes(value)
	)
}

export function parseScheduledLaneMessage(
	body: unknown,
): ScheduledLaneMessage | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const record = body as Record<string, unknown>
	const lane = record['lane']
	const scheduledTime = record['scheduledTime']
	const cron = record['cron']
	if (
		!isScheduledLaneName(lane) ||
		typeof scheduledTime !== 'number' ||
		!Number.isFinite(scheduledTime) ||
		typeof cron !== 'string'
	) {
		return null
	}
	return { lane, scheduledTime, cron }
}

// Cadence predicates. These are the single source of truth; the main-worker
// modules that implement each lane re-export them so lane implementations and
// dispatch can never drift apart.

export const retentionCronGateMinutes = 5
export const retentionCronIntervalMinutes = 60

export function shouldRunRetentionCron(now: Date) {
	return (
		now.getUTCMinutes() < retentionCronGateMinutes &&
		now.getUTCMinutes() % retentionCronIntervalMinutes === 0
	)
}

export const usageAggregationCronGateMinutes = 5
export const usageAggregationCronIntervalMinutes = 60

export function shouldRunUsageAggregationCron(now: Date) {
	return (
		now.getUTCMinutes() < usageAggregationCronGateMinutes &&
		now.getUTCMinutes() % usageAggregationCronIntervalMinutes === 0
	)
}

/**
 * Hourly at minute 20: Cloudflare's per-object Durable Object analytics lag
 * a few minutes, and minute 0 already carries the heavier usage lanes.
 */
export function shouldRunDurableObjectDurationAttributionCron(now: Date) {
	return now.getUTCMinutes() === 20
}

export function shouldRunAuthDenialAlertCron(now: Date) {
	// Same hourly gate as retention / usage aggregation (minute 0).
	return now.getUTCMinutes() === 0
}

export function shouldRunEmailDeliveryAlertCron(now: Date) {
	return now.getUTCMinutes() === 0
}

export function shouldRunEmailVerificationStallAlertCron(now: Date) {
	return now.getUTCMinutes() === 0
}

export function shouldRunUsageEntitlementAlertCron(now: Date) {
	return now.getUTCMinutes() === 0
}

export function shouldRunKitSubscriberSyncCron(now: Date) {
	return now.getUTCMinutes() === 0
}

/**
 * Nightly DR export window: roughly 00:30–06:10 UTC on the worker's
 * every-5-minute cron (~68 ticks × 45 s ≈ 51 minutes of staging work).
 * Ticks outside this window are skipped so daytime traffic is not competing
 * with a full-platform export. Inside the window, each tick prefers the
 * oldest stranded day in the lookback (progress without summary), then today.
 * Completed days exit cheaply through the summary-object check.
 */
export function shouldRunDrExportCron(now: Date) {
	const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
	return minutes >= 30 && minutes <= 6 * 60 + 10
}

/**
 * Daytime catch-up cadence: outside the nightly window, every worker cron
 * tick (every 5 minutes) resumes the oldest stranded day in the lookback
 * until its summary is written. A single tick still spends at most the
 * normal ~45 s budget, so daytime blast radius stays bounded while backlog
 * drains ~3× faster than the previous 15-minute cadence. Ticks with no
 * stranded day exit after two cheap HEAD-style checks per lookback day.
 */
export function shouldRunDrExportCatchUpCron(now: Date) {
	if (shouldRunDrExportCron(now)) return false
	return now.getUTCMinutes() % 5 === 0
}

/**
 * One cron tick after the export window closes (06:15–06:19 UTC). The
 * watchdog fails loudly (lane failure → Sentry) when the night's staging
 * summary is missing, because the exporter itself never errors when it
 * merely runs out of window.
 */
export function shouldRunDrExportWatchdogCron(now: Date) {
	const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
	return minutes >= 6 * 60 + 15 && minutes < 6 * 60 + 20
}

export const jobScheduleWatchdogIntervalMinutes = 15

export function shouldRunJobScheduleWatchdogCron(now: Date) {
	return now.getUTCMinutes() % jobScheduleWatchdogIntervalMinutes === 0
}

/** Same 15-minute cadence as the job schedule watchdog. */
export function shouldRunFleetUsersAffectedAlertCron(now: Date) {
	return now.getUTCMinutes() % jobScheduleWatchdogIntervalMinutes === 0
}

/**
 * Which lanes a cron tick at `scheduledAt` should dispatch. DR export lanes
 * are dispatched on cadence regardless of configuration; the main worker
 * skips them cheaply when DR export is not configured (the jobs worker has no
 * access to the main worker's DR configuration vars).
 */
export function getScheduledLaneCadence(
	scheduledAt: Date,
): Array<ScheduledLaneName> {
	const lanes: Array<ScheduledLaneName> = [
		'reconcile_artifacts_pushes',
		'repo_session_cleanup',
		'reconcile_inbound_deliveries',
		'system_email_retention',
		'storage_bucket_estimate_backfill',
		'community_listing_behind_backfill',
		'd1_storage_reconciliation',
		'second_agent_gift_reconciliation',
		'oauth_purge_expired',
		'org_audit_outbox',
		'package_app_custom_hostnames_reconcile',
		'follow_maintenance',
		'dlq_depth_alert',
	]
	if (shouldRunRetentionCron(scheduledAt)) {
		lanes.push('retention', 'unverified_account_purge', 'soft_delete_purge')
	}
	if (shouldRunUsageAggregationCron(scheduledAt)) {
		lanes.push('usage_aggregation')
	}
	if (shouldRunDurableObjectDurationAttributionCron(scheduledAt)) {
		lanes.push('durable_object_duration_attribution')
	}
	if (shouldRunAuthDenialAlertCron(scheduledAt)) {
		lanes.push('auth_denial_alert')
	}
	if (shouldRunEmailDeliveryAlertCron(scheduledAt)) {
		lanes.push('email_delivery_alert')
	}
	if (shouldRunEmailVerificationStallAlertCron(scheduledAt)) {
		lanes.push('email_verification_stall_alert')
	}
	if (shouldRunUsageEntitlementAlertCron(scheduledAt)) {
		lanes.push('usage_entitlement_alert')
	}
	if (shouldRunKitSubscriberSyncCron(scheduledAt)) {
		lanes.push('kit_subscriber_sync')
	}
	if (
		shouldRunDrExportCron(scheduledAt) ||
		shouldRunDrExportCatchUpCron(scheduledAt)
	) {
		lanes.push('dr_export')
	}
	if (shouldRunDrExportWatchdogCron(scheduledAt)) {
		lanes.push('dr_export_watchdog')
	}
	if (shouldRunJobScheduleWatchdogCron(scheduledAt)) {
		lanes.push('job_schedule_watchdog')
	}
	if (shouldRunFleetUsersAffectedAlertCron(scheduledAt)) {
		lanes.push('fleet_users_affected_alert')
	}
	return lanes
}

export const scheduledDispatchQueueBinding = 'SCHEDULED_DISPATCH_QUEUE'
export const scheduledDispatchQueueName = 'kody-scheduled-dispatch'
export const scheduledDispatchDeadLetterQueueName =
	'kody-scheduled-dispatch-dlq'
