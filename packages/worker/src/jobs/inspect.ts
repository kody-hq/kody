import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	hydrateJobViewFromRunLog,
	hydrateJobViewsFromRunLog,
} from './job-run-observability-hydrate.ts'
import {
	getJobManagerDebugState,
	type JobManagerDebugState,
} from './manager-client.ts'
import { jobsData } from './jobs-data.ts'
import { toJobView } from './schedule.ts'
import type { JobSourceInspection, JobView } from './types.ts'

/**
 * Read-side job inspection helpers for capability/UI list+get paths.
 *
 * Kept separate from `service.ts` so `jobList` / `jobGet` do not lazy-load the
 * job execution graph (`run-kody-registry`, bundler, entitlements, …) on the
 * first cold-isolate capability dispatch.
 */
export async function listJobs(input: { env: Env; userId: OwnerId }) {
	const rows = await jobsData(input.env).listJobsForUser({
		userId: input.userId,
	})
	return hydrateJobViewsFromRunLog({
		env: input.env,
		userId: input.userId,
		jobs: rows.map((row) => toJobView(row.record)),
	})
}

export async function getJob(input: {
	env: Env
	userId: OwnerId
	jobId: string
}) {
	const row = await jobsData(input.env).getJobById({
		userId: input.userId,
		jobId: input.jobId,
	})
	if (!row) {
		// Caller-supplied job id that does not resolve for this user — keep it
		// off Sentry via McpCallerError (agent typos / stale ids are routine).
		throw new McpCallerError(`Job "${input.jobId}" was not found.`)
	}
	return hydrateJobViewFromRunLog({
		env: input.env,
		userId: input.userId,
		job: toJobView(row.record),
	})
}

export async function inspectJobsForUser(input: {
	env: Env
	userId: OwnerId
}): Promise<{
	jobs: Array<JobView>
	alarm: JobManagerDebugState
}> {
	const [jobs, alarm] = await Promise.all([
		listJobs(input),
		getJobManagerDebugState({
			env: input.env,
			userId: input.userId,
		}),
	])
	return {
		jobs,
		alarm,
	}
}

export async function getJobInspection(input: {
	env: Env
	userId: OwnerId
	jobId: string
	includeCode?: boolean
}): Promise<{
	job: JobView
	alarm: JobManagerDebugState
	source?: JobSourceInspection
}> {
	const [job, alarm] = await Promise.all([
		getJob(input),
		getJobManagerDebugState({
			env: input.env,
			userId: input.userId,
		}),
	])
	if (!input.includeCode) {
		return {
			job,
			alarm,
		}
	}
	// Rare path: pay for published-source resolution only when code is requested.
	const { inspectPublishedJobSource } =
		await import('./inspect-published-source.ts')
	const source = await inspectPublishedJobSource({
		env: input.env,
		userId: input.userId,
		job,
	})
	return {
		job,
		alarm,
		source,
	}
}
