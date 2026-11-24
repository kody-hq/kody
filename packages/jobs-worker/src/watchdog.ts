import * as Sentry from '@sentry/cloudflare'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	advanceStuckSkippedJobNextRunAt,
	listSilentlyOverdueJobRowsPage,
	listStuckSkippedJobRowsPage,
	type JobRow,
} from '@kody-internal/shared/jobs/repo.ts'
import { computeNextRunAt } from '@kody-internal/shared/jobs/schedule.ts'
import { logJobSchedulerEvent } from '@kody-internal/shared/jobs/scheduler-logging.ts'
import type { JobsWorkerEnv } from './env.ts'
import { jobManagerStub } from './manager.ts'
import { getWorkerStateValue, putWorkerStateValue } from './store.ts'
import { runEdge } from '@kody-internal/shared/effect/edge.ts'
import {
	d1,
	OutboundCallError,
	outbound,
	outboundCause,
} from '@kody-internal/shared/effect/outbound.ts'
import { Clock, Duration, Effect } from 'effect'

/**
 * Platform cron that detects enabled recurring jobs that should already have
 * run (or are permanently skipped by a stuck occurrence fence) and
 * best-effort re-arms each affected user's JobManager alarm (at most 50 users
 * per tick; individual syncs may fail; scans may be truncated). Complements
 * at-least-once claim safety: leases recover overlapping runs, but nothing
 * else notices when a per-user Durable Object alarm is lost or a fence leaves
 * next_run_at stuck.
 */

/** Due jobs older than this are treated as silently overdue. */
const jobScheduleWatchdogGraceMs = 5 * 60 * 1_000
const jobScheduleWatchdogPageSize = 100
/** Cap cross-user page accumulation so a large backlog cannot OOM the cron. */
const jobScheduleWatchdogMaxRowsPerTick = 5_000
const jobScheduleWatchdogMaxUsersPerTick = 50
const jobScheduleWatchdogMaxJobsLogged = 20
/** Avoid re-paging Sentry on the same sustained overdue set every tick. */
const jobScheduleWatchdogAlertCooldownMinutes = 6 * 60
const jobScheduleWatchdogAlertStateKey = 'ops-alert:job-schedule-watchdog:v1'

export type JobScheduleWatchdogResult = {
	overdueJobCount: number
	stuckSkippedJobCount: number
	repairedStuckJobCount: number
	usersSynced: number
	usersFailedSync: number
	usersSkippedCap: number
	scanTruncated: boolean
	alerted: boolean
}

function summarizeJobs(rows: Array<JobRow>) {
	// Omit user-authored job names from ops/Sentry payloads; job ids are enough.
	// Detection uses scheduling fences (next_run_at / claim / completed-for);
	// last_run_at is retention/observability and not needed in the sample.
	return rows.slice(0, jobScheduleWatchdogMaxJobsLogged).map((row) => ({
		jobId: row.id,
		userId: row.user_id,
		nextRunAt: row.next_run_at,
		lastCompletedScheduledFor: row.last_completed_scheduled_for,
	}))
}

/** One hung JobManager must not stall the tick for every later user. */
export const jobManagerSyncTimeoutMs = 30_000

const errorText = (error: OutboundCallError) => {
	const cause = outboundCause(error)
	return cause instanceof Error ? cause.message : String(cause)
}

const readAlertCooldownActive = Effect.fn('jobWatchdog.readAlertCooldown')(
	function* (env: JobsWorkerEnv, now: Date) {
		const lastSentRaw = yield* d1('job watchdog: read alert cooldown', () =>
			getWorkerStateValue(env.JOBS_DB, jobScheduleWatchdogAlertStateKey),
		)
		const lastSentMs = lastSentRaw ? Number(lastSentRaw) : NaN
		return (
			Number.isFinite(lastSentMs) &&
			now.getTime() - lastSentMs <
				jobScheduleWatchdogAlertCooldownMinutes * 60_000
		)
	},
	// Fail open: a missed cooldown costs a duplicate alert, a thrown one
	// costs the alert.
	Effect.catchTag('OutboundCallError', (error) =>
		Effect.logWarning('job-schedule-watchdog-cooldown-read-failed', {
			error: errorText(error),
		}).pipe(Effect.as(false)),
	),
)

const collectPagedJobRows = Effect.fn('jobWatchdog.collectPagedJobRows')(
	function* (
		operation: string,
		page: (afterId: string | null) => Promise<Array<JobRow>>,
	) {
		const rows: Array<JobRow> = []
		let afterId: string | null = null
		while (true) {
			const next: Array<JobRow> = yield* d1(operation, () => page(afterId))
			if (next.length === 0) break
			rows.push(...next)
			if (next.length < jobScheduleWatchdogPageSize) {
				return { rows, truncated: false }
			}
			if (rows.length >= jobScheduleWatchdogMaxRowsPerTick) {
				return {
					rows: rows.slice(0, jobScheduleWatchdogMaxRowsPerTick),
					truncated: true,
				}
			}
			afterId = next[next.length - 1]!.id
		}
		return { rows, truncated: false }
	},
)

const captureWatchdogAlert = Effect.fn('jobWatchdog.captureAlert')(function* (
	env: JobsWorkerEnv,
	now: Date,
	result: Omit<JobScheduleWatchdogResult, 'alerted'>,
	overdueSample: Array<JobRow>,
	stuckSample: Array<JobRow>,
) {
	if (result.overdueJobCount === 0 && result.stuckSkippedJobCount === 0) {
		return false
	}
	// Cooldown lives in the jobs D1 (jobs_worker_state), replacing the main
	// worker's BUNDLE_ARTIFACTS_KV cooldown key from before the extraction.
	const alerted = !(yield* readAlertCooldownActive(env, now))
	if (alerted) {
		yield* d1('job watchdog: write alert cooldown', () =>
			putWorkerStateValue(
				env.JOBS_DB,
				jobScheduleWatchdogAlertStateKey,
				String(now.getTime()),
			),
		).pipe(
			Effect.catchTag('OutboundCallError', (error) =>
				Effect.logWarning('job-schedule-watchdog-cooldown-write-failed', {
					error: errorText(error),
				}),
			),
		)
	}
	const payload = {
		...result,
		overdueSample: summarizeJobs(overdueSample),
		stuckSample: summarizeJobs(stuckSample),
	}
	yield* Effect.logWarning('job-schedule-watchdog-overdue', payload)
	if (alerted) {
		yield* Effect.sync(() =>
			Sentry.withScope((scope) => {
				scope.setTag('scheduled.lane', 'job_schedule_watchdog')
				scope.setContext('job_schedule_watchdog', payload)
				Sentry.captureMessage(
					'Enabled jobs were silently overdue or stuck-skipped; JobManager alarms were re-synced.',
					'warning',
				)
			}),
		)
	}
	return alerted
})

const repairStuckJob = Effect.fn('jobWatchdog.repairStuckJob')(
	function* (env: JobsWorkerEnv, row: JobRow, nowIso: string) {
		// Advance from the stuck occurrence, not wall clock, so late repair
		// cannot skip intermediate firings (at-most-one catch-up per pass).
		const nextRunAt = yield* Effect.try(() =>
			computeNextRunAt({
				schedule: row.record.schedule,
				timezone: row.record.timezone,
				from: row.next_run_at,
			}),
		)
		// The pre-extraction watchdog wrapped this in the main worker's
		// account write lease. Account deletion now serializes through
		// JobsService.purgeUser (which deletes every row for the user), so a
		// stuck-fence advance racing a purge at worst repairs a row that is
		// deleted moments later.
		const repaired = yield* d1('job watchdog: advance stuck job', () =>
			advanceStuckSkippedJobNextRunAt({
				db: env.JOBS_DB,
				userId: row.user_id,
				jobId: row.id,
				nextRunAt,
				updatedAt: nowIso,
			}),
		)
		if (!repaired) return false
		logJobSchedulerEvent({
			event: 'watchdog_repaired_stuck_skipped_job',
			userId: row.user_id,
			jobId: row.id,
			scheduleType: row.record.schedule.type,
			nextRunAt,
			reason: 'last_completed_equals_occurrence',
		})
		return true
	},
	(effect, _env, row) =>
		Effect.catch(effect, (error) =>
			Effect.logWarning('job-schedule-watchdog-repair-failed', {
				jobId: row.id,
				userId: row.user_id,
				error:
					error instanceof OutboundCallError ? errorText(error) : error.message,
			}).pipe(Effect.as(false)),
		),
)

const syncUserAlarm = (env: JobsWorkerEnv, userId: OwnerId) =>
	outbound(
		'job watchdog: JobManager syncAlarm',
		() => jobManagerStub(env, userId).syncAlarm({ userId }),
		{ timeout: Duration.millis(jobManagerSyncTimeoutMs) },
	).pipe(
		Effect.tap(() =>
			Effect.sync(() =>
				logJobSchedulerEvent({
					event: 'watchdog_sync_alarm',
					userId,
					reason: 'silently_overdue_or_stuck_skipped',
				}),
			),
		),
		Effect.as(true),
		Effect.catchTag('OutboundCallError', (error) =>
			Effect.logWarning('job-schedule-watchdog-sync-failed', {
				userId,
				error: errorText(error),
			}).pipe(Effect.as(false)),
		),
	)

const watchdogTick = Effect.fn('jobWatchdog.tick')(function* (
	env: JobsWorkerEnv,
	now: Date,
) {
	const nowIso = now.toISOString()
	const overdueBeforeIso = new Date(
		now.getTime() - jobScheduleWatchdogGraceMs,
	).toISOString()
	const overduePage = yield* collectPagedJobRows(
		'job watchdog: scan overdue page',
		(afterId) =>
			listSilentlyOverdueJobRowsPage(env.JOBS_DB, {
				overdueBeforeIso,
				nowIso,
				afterId,
				limit: jobScheduleWatchdogPageSize,
			}),
	)
	const stuckPage = yield* collectPagedJobRows(
		'job watchdog: scan stuck page',
		(afterId) =>
			listStuckSkippedJobRowsPage(env.JOBS_DB, {
				nowIso,
				afterId,
				limit: jobScheduleWatchdogPageSize,
			}),
	)
	const overdueRows = overduePage.rows
	const stuckRows = stuckPage.rows
	const usersNeedingSync = new Set<OwnerId>()
	for (const row of [...overdueRows, ...stuckRows]) {
		usersNeedingSync.add(row.user_id)
	}
	const repairs = yield* Effect.forEach(stuckRows, (row) =>
		repairStuckJob(env, row, nowIso),
	)

	const userIds = [...usersNeedingSync].sort()
	const usersToSync = userIds.slice(0, jobScheduleWatchdogMaxUsersPerTick)
	// One user at a time: the per-call deadline, not parallelism, bounds a
	// tick, and each JobManager wake costs a Durable Object request.
	const syncs = yield* Effect.forEach(usersToSync, (userId) =>
		syncUserAlarm(env, userId),
	)
	const usersSynced = syncs.filter(Boolean).length
	const baseResult = {
		overdueJobCount: overdueRows.length,
		stuckSkippedJobCount: stuckRows.length,
		repairedStuckJobCount: repairs.filter(Boolean).length,
		usersSynced,
		usersFailedSync: syncs.length - usersSynced,
		usersSkippedCap: Math.max(
			0,
			userIds.length - jobScheduleWatchdogMaxUsersPerTick,
		),
		scanTruncated: overduePage.truncated || stuckPage.truncated,
	}
	const alerted = yield* captureWatchdogAlert(
		env,
		now,
		baseResult,
		overdueRows,
		stuckRows,
	)
	return { ...baseResult, alerted } satisfies JobScheduleWatchdogResult
})

/**
 * Scan silently overdue and stuck-skipped jobs, repair stuck fences, and
 * best-effort re-arm each affected user's JobManager alarm (at most 50 users
 * per tick; individual syncs may fail; scans may be truncated). Caps page
 * accumulation and Sentry cooldown live in this module; cadence is
 * `shouldRunJobScheduleWatchdogCron` (every 15 minutes).
 */
export async function runJobScheduleWatchdogTick(input: {
	env: JobsWorkerEnv
	now?: Date
}): Promise<JobScheduleWatchdogResult> {
	return runEdge(
		Effect.gen(function* () {
			const now = input.now ?? new Date(yield* Clock.currentTimeMillis)
			return yield* watchdogTick(input.env, now)
		}),
	)
}
