/**
 * Overlay user-scoped RunLog job_run_observability onto D1 job scheduling rows
 * for user-facing readers (jobGet, jobList, account jobs).
 */

import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	getJobRunObservability,
	getJobRunObservabilityBatch,
	type JobRunObservabilityRecord,
} from '#worker/run-records/service.ts'
import type { JobView } from './types.ts'

export function applyJobRunObservabilityToJobView(
	job: JobView,
	observability: JobRunObservabilityRecord | null | undefined,
): JobView {
	return {
		...job,
		lastRunAt: observability?.lastRunAt ?? job.lastRunAt,
		lastRunStatus: observability?.lastRunStatus ?? job.lastRunStatus,
		lastRunError: observability?.lastRunError ?? undefined,
		lastDurationMs: observability?.lastDurationMs ?? undefined,
		runCount: observability?.runCount ?? 0,
		successCount: observability?.successCount ?? 0,
		errorCount: observability?.errorCount ?? 0,
	}
}

export async function hydrateJobViewFromRunLog(input: {
	env: Env
	userId: OwnerId
	job: JobView
}): Promise<JobView> {
	const observability = await getJobRunObservability({
		env: input.env,
		userId: input.userId,
		jobId: input.job.id,
	})
	return applyJobRunObservabilityToJobView(input.job, observability)
}

export async function hydrateJobViewsFromRunLog(input: {
	env: Env
	userId: OwnerId
	jobs: Array<JobView>
}): Promise<Array<JobView>> {
	if (input.jobs.length === 0) return input.jobs
	const records = await getJobRunObservabilityBatch({
		env: input.env,
		userId: input.userId,
		jobIds: input.jobs.map((job) => job.id),
	})
	const byJobId = new Map(
		records.map((record) => [record.jobId, record] as const),
	)
	return input.jobs.map((job) =>
		applyJobRunObservabilityToJobView(job, byJobId.get(job.id)),
	)
}
