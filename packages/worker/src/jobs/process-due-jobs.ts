import { rescheduleFailedDisabledReason } from '@kody-internal/shared/jobs/disabled-reason.ts'
import { type SchedulerJobOutcomeLog } from './scheduler-logging.ts'
import { computeNextRunAtAfterOccurrence, formatJobError } from './schedule.ts'
import {
	type JobExecutionOutcome,
	type JobRecord,
	type JobRunStatus,
} from './types.ts'

export type ProcessDueJobsResult = {
	saveJobs: Array<JobRecord>
	successCount: number
	errorCount: number
	jobOutcomes: Array<SchedulerJobOutcomeLog>
}

export async function processDueJobs(input: {
	jobs: Array<JobRecord>
	now?: Date
	/**
	 * Claimed occurrence timestamp. When set, `next_run_at` advances from this
	 * slot (catch-up), not from wall-clock `now`, so late settles cannot skip
	 * intermediate firings.
	 */
	scheduledFor?: string | null
	executeJob: (job: JobRecord) => Promise<JobExecutionOutcome>
}): Promise<ProcessDueJobsResult> {
	const now = input.now ?? new Date()
	const saveJobs: Array<JobRecord> = []
	const jobOutcomes: Array<SchedulerJobOutcomeLog> = []
	let successCount = 0
	let errorCount = 0

	for (const job of input.jobs) {
		const outcome = await input.executeJob(job).catch((error) => {
			const startedAt = now.toISOString()
			return {
				execution: {
					ok: false as const,
					error: formatJobError(error),
					logs: [],
				},
				startedAt,
				finishedAt: startedAt,
				durationMs: 0,
			}
		})
		const executionError = outcome.execution.ok
			? undefined
			: outcome.execution.error
		if (outcome.execution.ok) {
			successCount += 1
		} else {
			errorCount += 1
		}

		try {
			const occurrenceForNext =
				input.scheduledFor?.trim() || job.nextRunAt || now.toISOString()
			const updated = applyExecutionOutcome(job, outcome, {
				updatedAt: now.toISOString(),
				nextRunAt: computeNextRunAtAfterOccurrence({
					schedule: job.schedule,
					timezone: job.timezone,
					scheduledFor: occurrenceForNext,
				}),
			})
			saveJobs.push(updated)
			jobOutcomes.push({
				jobId: job.id,
				scheduleType: job.schedule.type,
				outcome: outcome.execution.ok ? 'success' : 'failure',
				nextRunAt: updated.nextRunAt,
				deleted: false,
				...(executionError ? { error: executionError } : {}),
			})
		} catch (error) {
			const rescheduleError = formatJobError(error)
			if (outcome.execution.ok) {
				successCount -= 1
				errorCount += 1
			}
			const failedRescheduleError = `Failed to reschedule job: ${rescheduleError}`
			const updated = applyExecutionOutcome(
				job,
				outcome.execution.ok
					? {
							...outcome,
							execution: {
								ok: false as const,
								error: failedRescheduleError,
								logs: outcome.execution.logs,
							},
						}
					: outcome,
				{
					updatedAt: now.toISOString(),
					enabled: false,
					disabledReason: rescheduleFailedDisabledReason(rescheduleError),
				},
			)
			saveJobs.push(updated)
			jobOutcomes.push({
				jobId: job.id,
				scheduleType: job.schedule.type,
				outcome: 'failure',
				nextRunAt: updated.nextRunAt,
				deleted: false,
				error: executionError ?? rescheduleError,
				rescheduleError,
			})
		}
	}

	return {
		saveJobs,
		successCount,
		errorCount,
		jobOutcomes,
	}
}

export function applyExecutionOutcome(
	job: JobRecord,
	outcome: JobExecutionOutcome,
	overrides: Partial<JobRecord> = {},
): JobRecord {
	const status: JobRunStatus = outcome.execution.ok ? 'success' : 'error'
	return {
		...job,
		updatedAt: overrides.updatedAt ?? outcome.finishedAt,
		lastRunAt: outcome.finishedAt,
		lastRunStatus: status,
		nextRunAt: overrides.nextRunAt ?? job.nextRunAt,
		enabled: overrides.enabled ?? job.enabled,
		disabledReason:
			overrides.disabledReason === undefined
				? job.disabledReason
				: overrides.disabledReason,
		killSwitchEnabled: overrides.killSwitchEnabled ?? job.killSwitchEnabled,
	}
}
