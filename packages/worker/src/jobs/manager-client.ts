import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	type JobManagerDebugState,
	type JobManagerDebugStatus,
} from '@kody-internal/shared/jobs/manager-debug.ts'
import {
	optionalOrgAuditWriter,
	orgAuditCauseFromCaller,
} from '#worker/orgs/org-audit.ts'
import { recordJobRunAudit } from './job-audit.ts'
import { jobsData, jobsService } from './jobs-data.ts'
import {
	logJobSchedulerError,
	logJobSchedulerEvent,
	schedulerErrorFields,
} from './scheduler-logging.ts'
import { type JobRepoCheckPolicy } from './types.ts'

export { type JobManagerDebugState, type JobManagerDebugStatus }

/**
 * JobManager scheduling operations, routed to the jobs worker's
 * `JobsService` (which owns the JobManager Durable Object namespace since
 * the ADR 0016 extraction). When the JOBS binding is absent (tests, local
 * single-worker dev) the operations degrade the same way the old missing
 * JOB_MANAGER binding did: syncs and purges no-op, debug state reports
 * `missing_binding`, and run-now fails loudly.
 */
export async function purgeJobManagerForUser(input: {
	env: Env
	userId: OwnerId
}) {
	const jobs = jobsService(input.env)
	if (!jobs) {
		// No jobs worker: still clear the fallback store's rows so account
		// deletion leaves no job data behind; only the DO purge is skipped.
		await jobsData(input.env).purgeUserJobsData({ userId: input.userId })
		return {
			ok: true as const,
			userId: input.userId,
			purged: false,
		}
	}
	return jobs.purgeUser({ userId: input.userId })
}

export async function syncJobManagerAlarm(input: {
	env: Env
	userId: OwnerId
}) {
	const jobs = jobsService(input.env)
	if (!jobs) {
		logJobSchedulerEvent({
			event: 'sync_alarm_skipped_missing_binding',
			userId: input.userId,
			reason: 'missing_jobs_binding',
		})
		return {
			ok: true as const,
			userId: input.userId,
			nextRunAt: null,
		}
	}
	logJobSchedulerEvent({
		event: 'sync_alarm_requested',
		userId: input.userId,
	})
	try {
		const result = await jobs.syncAlarm({
			userId: input.userId,
		})
		logJobSchedulerEvent({
			event: 'sync_alarm_completed',
			userId: result.userId,
			nextRunAt: result.nextRunAt,
			reason:
				result.nextRunAt == null
					? 'no_runnable_job_found'
					: 'alarm_state_updated',
		})
		return result
	} catch (error) {
		logJobSchedulerError({
			event: 'sync_alarm_request_failed',
			userId: input.userId,
			...schedulerErrorFields(error),
		})
		throw error
	}
}

const missingBindingDebugState: JobManagerDebugState = {
	bindingAvailable: false,
	status: 'missing_binding',
	storedUserId: null,
	alarmScheduledFor: null,
	nextRunnableJobId: null,
	nextRunnableRunAt: null,
	alarmInSync: null,
}

export async function getJobManagerDebugState(input: {
	env: Env
	userId: OwnerId
}) {
	const jobs = jobsService(input.env)
	if (!jobs) {
		return missingBindingDebugState
	}
	return jobs.getDebugState({
		userId: input.userId,
	})
}

export async function exportJobManagerForUser(input: {
	env: Env
	userId: OwnerId
}) {
	const jobs = jobsService(input.env)
	if (!jobs) {
		return missingBindingDebugState
	}
	return jobs.exportUser({
		userId: input.userId,
	})
}

/**
 * Run one job now (trigger `manual`). Both manual lanes, the website Run now
 * button and the `jobRunNow` capability, come through here, so the `job.ran`
 * org audit row is recorded here once the run finishes, success or error.
 */
export async function runJobNowViaManager(input: {
	env: Env
	userId: OwnerId
	jobId: string
	callerContext?: McpCallerContext | null
	repoCheckPolicyOverride?: JobRepoCheckPolicy | null
}) {
	const jobs = jobsService(input.env)
	if (!jobs) {
		throw new Error('Missing JOBS binding for jobs scheduling.')
	}
	const result = await jobs.runJobNow({
		userId: input.userId,
		jobId: input.jobId,
		callerContext: input.callerContext ?? null,
		repoCheckPolicyOverride: input.repoCheckPolicyOverride,
	})
	await recordJobRunAudit(
		optionalOrgAuditWriter(
			input.env,
			input.callerContext?.request ?? null,
			input.callerContext ? orgAuditCauseFromCaller(input.callerContext) : null,
		),
		{
			orgId: input.userId,
			jobId: result.job.id,
			name: result.job.name,
			ok: result.execution.ok,
		},
	)
	return result
}
