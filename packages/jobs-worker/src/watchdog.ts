import * as Sentry from '@sentry/cloudflare'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { runD1WithRetry } from '@kody-internal/shared/d1-retry.ts'
import {
	advanceStuckSkippedJobNextRunAt,
	listSilentlyOverdueJobRowsPage,
	listStuckSkippedJobRowsPage,
	type JobRow,
} from '@kody-internal/shared/jobs/repo.ts'
import { computeNextRunAt } from '@kody-internal/shared/jobs/schedule.ts'
import { logJobSchedulerEvent } from '@kody-internal/shared/jobs/scheduler-logging.ts'
import { type JobsWorkerEnv } from './env.ts'
import { jobManagerStub } from './manager.ts'
import { getWorkerStateValue, putWorkerStateValue } from './store.ts'

/**
 * Platform cron that detects enabled recurring jobs that should already have
 * run (or are permanently skipped by a stuck occurrence fence) and re-arms
 * each affected user's JobManager alarm. Complements at-least-once claim
 * safety: leases recover overlapping runs, but nothing else notices when a
 * per-user Durable Object alarm is lost or a fence leaves next_run_at stuck.
 */

/** Due jobs older than this are treated as silently overdue. */
export const jobScheduleWatchdogGraceMs = 5 * 60 * 1_000
export const jobScheduleWatchdogPageSize = 100
/** Cap cross-user page accumulation so a large backlog cannot OOM the cron. */
export const jobScheduleWatchdogMaxRowsPerTick = 5_000
export const jobScheduleWatchdogMaxUsersPerTick = 50
export const jobScheduleWatchdogMaxJobsLogged = 20
/** Avoid re-paging Sentry on the same sustained overdue set every tick. */
export const jobScheduleWatchdogAlertCooldownMinutes = 6 * 60
export const jobScheduleWatchdogAlertStateKey =
	'ops-alert:job-schedule-watchdog:v1'

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

async function collectPagedJobRows(input: {
	page: (afterId: string | null) => Promise<Array<JobRow>>
}): Promise<{ rows: Array<JobRow>; truncated: boolean }> {
	const rows: Array<JobRow> = []
	let afterId: string | null = null
	while (true) {
		const page = await runD1WithRetry(() => input.page(afterId))
		if (page.length === 0) break
		rows.push(...page)
		if (page.length < jobScheduleWatchdogPageSize) {
			return { rows, truncated: false }
		}
		if (rows.length >= jobScheduleWatchdogMaxRowsPerTick) {
			return {
				rows: rows.slice(0, jobScheduleWatchdogMaxRowsPerTick),
				truncated: true,
			}
		}
		afterId = page[page.length - 1]!.id
	}
	return { rows, truncated: false }
}

async function maybeCaptureWatchdogAlert(input: {
	env: JobsWorkerEnv
	now: Date
	result: Omit<JobScheduleWatchdogResult, 'alerted'>
	overdueSample: Array<JobRow>
	stuckSample: Array<JobRow>
}): Promise<boolean> {
	if (
		input.result.overdueJobCount === 0 &&
		input.result.stuckSkippedJobCount === 0
	) {
		return false
	}

	// Cooldown lives in the jobs D1 (jobs_worker_state), replacing the main
	// worker's BUNDLE_ARTIFACTS_KV cooldown key from before the extraction.
	let alerted = true
	const lastSentRaw = await getWorkerStateValue(
		input.env.JOBS_DB,
		jobScheduleWatchdogAlertStateKey,
	)
	const lastSentMs = lastSentRaw ? Number(lastSentRaw) : NaN
	if (
		Number.isFinite(lastSentMs) &&
		input.now.getTime() - lastSentMs <
			jobScheduleWatchdogAlertCooldownMinutes * 60_000
	) {
		alerted = false
	} else {
		await putWorkerStateValue(
			input.env.JOBS_DB,
			jobScheduleWatchdogAlertStateKey,
			String(input.now.getTime()),
		)
	}

	const payload = {
		...input.result,
		overdueSample: summarizeJobs(input.overdueSample),
		stuckSample: summarizeJobs(input.stuckSample),
	}
	console.warn('job-schedule-watchdog-overdue', payload)
	if (alerted) {
		Sentry.withScope((scope) => {
			scope.setTag('scheduled.lane', 'job_schedule_watchdog')
			scope.setContext('job_schedule_watchdog', payload)
			Sentry.captureMessage(
				'Enabled jobs were silently overdue or stuck-skipped; JobManager alarms were re-synced.',
				'warning',
			)
		})
	}
	return alerted
}

export async function runJobScheduleWatchdogTick(input: {
	env: JobsWorkerEnv
	now?: Date
}): Promise<JobScheduleWatchdogResult> {
	const now = input.now ?? new Date()
	const nowIso = now.toISOString()
	const overdueBeforeIso = new Date(
		now.getTime() - jobScheduleWatchdogGraceMs,
	).toISOString()

	const overduePage = await collectPagedJobRows({
		page: (afterId) =>
			listSilentlyOverdueJobRowsPage(input.env.JOBS_DB, {
				overdueBeforeIso,
				nowIso,
				afterId,
				limit: jobScheduleWatchdogPageSize,
			}),
	})
	const stuckPage = await collectPagedJobRows({
		page: (afterId) =>
			listStuckSkippedJobRowsPage(input.env.JOBS_DB, {
				nowIso,
				afterId,
				limit: jobScheduleWatchdogPageSize,
			}),
	})
	const overdueRows = overduePage.rows
	const stuckRows = stuckPage.rows
	const scanTruncated = overduePage.truncated || stuckPage.truncated

	let repairedStuckJobCount = 0
	const usersNeedingSync = new Set<OwnerId>()
	for (const row of overdueRows) {
		usersNeedingSync.add(row.user_id)
	}

	for (const row of stuckRows) {
		usersNeedingSync.add(row.user_id)
		try {
			// Advance from the stuck occurrence, not wall clock, so late repair
			// cannot skip intermediate firings (at-most-one catch-up per pass).
			const nextRunAt = computeNextRunAt({
				schedule: row.record.schedule,
				timezone: row.record.timezone,
				from: row.next_run_at,
			})
			// The pre-extraction watchdog wrapped this in the main worker's
			// account write lease. Account deletion now serializes through
			// JobsService.purgeUser (which deletes every row for the user), so a
			// stuck-fence advance racing a purge at worst repairs a row that is
			// deleted moments later.
			const repaired = await advanceStuckSkippedJobNextRunAt({
				db: input.env.JOBS_DB,
				userId: row.user_id,
				jobId: row.id,
				nextRunAt,
				updatedAt: nowIso,
			})
			if (repaired) {
				repairedStuckJobCount += 1
				logJobSchedulerEvent({
					event: 'watchdog_repaired_stuck_skipped_job',
					userId: row.user_id,
					jobId: row.id,
					scheduleType: row.record.schedule.type,
					nextRunAt,
					reason: 'last_completed_equals_occurrence',
				})
			}
		} catch (error) {
			console.warn('job-schedule-watchdog-repair-failed', {
				jobId: row.id,
				userId: row.user_id,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	const userIds = [...usersNeedingSync].sort()
	const usersToSync = userIds.slice(0, jobScheduleWatchdogMaxUsersPerTick)
	const usersSkippedCap = Math.max(
		0,
		userIds.length - jobScheduleWatchdogMaxUsersPerTick,
	)
	let usersSynced = 0
	let usersFailedSync = 0
	for (const userId of usersToSync) {
		try {
			await jobManagerStub(input.env, userId).syncAlarm({ userId })
			usersSynced += 1
			logJobSchedulerEvent({
				event: 'watchdog_sync_alarm',
				userId,
				reason: 'silently_overdue_or_stuck_skipped',
			})
		} catch (error) {
			usersFailedSync += 1
			console.warn('job-schedule-watchdog-sync-failed', {
				userId,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	const baseResult = {
		overdueJobCount: overdueRows.length,
		stuckSkippedJobCount: stuckRows.length,
		repairedStuckJobCount,
		usersSynced,
		usersFailedSync,
		usersSkippedCap,
		scanTruncated,
	}
	const alerted = await maybeCaptureWatchdogAlert({
		env: input.env,
		now,
		result: baseResult,
		overdueSample: overdueRows,
		stuckSample: stuckRows,
	})

	return {
		...baseResult,
		alerted,
	}
}
