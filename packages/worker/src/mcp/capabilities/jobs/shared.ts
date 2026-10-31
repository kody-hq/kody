import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import {
	authorize,
	listScopeIncludes,
	orgResource,
	type ResourceListScope,
} from '#worker/authorization/authorize.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { resolveCronJobEnablementHint } from '#worker/enablements/job-enablement-hint.ts'
import { type JobManagerDebugState } from '#worker/jobs/manager-client.ts'
import { logJobSchedulerEvent } from '#worker/jobs/scheduler-logging.ts'
import {
	type JobExecutionResult,
	type JobSchedule,
	type JobSourceInspection,
	type JobUpdateInput,
	type JobView,
} from '#worker/jobs/types.ts'
import { type RunRecord } from '#worker/run-records/types.ts'

const intervalScheduleSchema = z.object({
	type: z.literal('interval'),
	every: z
		.string()
		.min(1)
		.describe(
			'Recurring interval such as 15m, 1h, or 1d using ms, s, m, h, or d units.',
		),
})

const cronScheduleSchema = z.object({
	type: z.literal('cron'),
	expression: z
		.string()
		.min(1)
		.describe(
			'Standard 5-field cron expression: minute hour day-of-month month day-of-week.',
		),
})

export const scheduledJobScheduleSchema = z.discriminatedUnion('type', [
	intervalScheduleSchema,
	cronScheduleSchema,
])

export const scheduledJobSummarySchema = scheduledJobScheduleSchema.describe(
	'Recurring package schedule (cron or interval). One-shot delayed work uses workflows.create(...).',
)

export const jobGetInputSchema = z
	.object({
		id: z
			.string()
			.min(1)
			.optional()
			.describe('Job id from jobList or jobGet output.'),
		job_id: z
			.string()
			.min(1)
			.optional()
			.describe('Alias for id, accepted for callers copying job_id outputs.'),
		includeCode: z
			.boolean()
			.optional()
			.describe(
				'When true, include the published job source entrypoint path and code in the response.',
			),
	})
	.refine((input) => input.id !== undefined || input.job_id !== undefined, {
		message: 'Provide id or job_id.',
		path: ['id'],
	})
	.refine(
		(input) =>
			input.id === undefined ||
			input.job_id === undefined ||
			input.id === input.job_id,
		{
			message: 'id and job_id must match when both are provided.',
			path: ['job_id'],
		},
	)

const nonNegativeIntegerSchema = z.number().int().min(0)

const jobRunHistoryEntrySchema = z.object({
	id: z
		.string()
		.optional()
		.describe('Run record id for drill-down with runGet when available.'),
	started_at: z.string(),
	finished_at: z.string(),
	status: z.enum(['success', 'error']),
	duration_ms: nonNegativeIntegerSchema,
	error: z.string().nullable(),
})

const runHistoryEntrySchema = z.object({
	id: z
		.string()
		.optional()
		.describe('Run record id for drill-down with runGet when available.'),
	started_at: z.string(),
	finished_at: z.string(),
	status: z.enum(['success', 'error']),
	duration_ms: nonNegativeIntegerSchema,
	error: z.string().optional(),
})

export type JobRecentRunOutput = z.infer<typeof jobRunHistoryEntrySchema>

export const jobInspectionSchema = z.object({
	id: z.string(),
	name: z.string(),
	source_id: z.string(),
	published_commit: z.string().nullable(),
	storage_id: z.string(),
	params: z.record(z.string(), z.unknown()).nullable(),
	schedule: scheduledJobSummarySchema,
	schedule_summary: z.string(),
	timezone: z.string(),
	enabled: z.boolean(),
	disabled_reason: z
		.string()
		.nullable()
		.describe(
			'Why the job is off: the reason given when someone turned it off, or what Kody did (expiry or auto-disable). Null while the job is on.',
		),
	kill_switch_enabled: z.boolean(),
	expires_at: z
		.string()
		.nullable()
		.describe('UTC ISO expiry timestamp, or null when the job never expires.'),
	expired: z
		.boolean()
		.describe(
			'True when expires_at is set and now is at or past that timestamp.',
		),
	created_at: z.string(),
	updated_at: z.string(),
	next_run_at: z.string(),
	due_now: z.boolean(),
	last_run_at: z.string().nullable(),
	last_run_status: z.enum(['success', 'error']).nullable(),
	last_run_error: z.string().nullable(),
	last_duration_ms: nonNegativeIntegerSchema.nullable(),
	run_count: nonNegativeIntegerSchema,
	success_count: nonNegativeIntegerSchema,
	error_count: nonNegativeIntegerSchema,
	recent_runs: z.array(jobRunHistoryEntrySchema),
	enablement_hint: z
		.string()
		.nullable()
		.describe(
			'When the job is enabled but has no on enablement (or only paused ones), an agent-directed message that includes the exact enablementEnable call. Null when the job is off or already has an on enablement.',
		),
})

export const jobSourceInspectionSchema = z.object({
	entrypoint: z
		.string()
		.nullable()
		.describe(
			'Normalized manifest-declared job entrypoint path, when resolved.',
		),
	code: z
		.string()
		.nullable()
		.describe(
			'Stored source code for the entrypoint, or null when unavailable.',
		),
	error: z
		.string()
		.nullable()
		.describe('Source resolution error, or null when code was loaded.'),
})

export const jobManagerDebugSchema = z.object({
	binding_available: z.boolean(),
	status: z.enum(['missing_binding', 'idle', 'armed', 'out_of_sync']),
	stored_user_id: z.string().nullable(),
	alarm_scheduled_for: z.string().nullable(),
	next_runnable_job_id: z.string().nullable(),
	next_runnable_run_at: z.string().nullable(),
	alarm_in_sync: z.boolean().nullable(),
})

export const jobListOutputSchema = z.object({
	jobs: z.array(jobInspectionSchema),
	alarm: jobManagerDebugSchema,
})

export const jobGetOutputSchema = z.object({
	job: jobInspectionSchema,
	alarm: jobManagerDebugSchema,
	source: jobSourceInspectionSchema
		.optional()
		.describe('Published job source details when includeCode is true.'),
})

export const jobViewOutputSchema = z.object({
	job_id: z.string(),
	name: z.string(),
	source_id: z.string(),
	published_commit: z.string().nullable(),
	storage_id: z.string(),
	params: z.record(z.string(), z.unknown()).optional(),
	schedule: scheduledJobSummarySchema,
	schedule_summary: z.string(),
	timezone: z.string(),
	enabled: z.boolean(),
	disabled_reason: z
		.string()
		.nullable()
		.describe(
			'Why the job is off: the reason given when someone turned it off, or what Kody did (expiry or auto-disable). Null while the job is on.',
		),
	kill_switch_enabled: z.boolean(),
	expires_at: z.string().nullable(),
	expired: z.boolean(),
	created_at: z.string(),
	updated_at: z.string(),
	last_run_at: z.string().optional(),
	last_run_status: z.enum(['success', 'error']).optional(),
	last_run_error: z.string().optional(),
	last_duration_ms: nonNegativeIntegerSchema.optional(),
	next_run_at: z.string(),
	run_count: nonNegativeIntegerSchema,
	success_count: nonNegativeIntegerSchema,
	error_count: nonNegativeIntegerSchema,
	run_history: z.array(runHistoryEntrySchema),
	enablement_hint: z
		.string()
		.nullable()
		.describe(
			'When the job is enabled but has no on enablement (or only paused ones), an agent-directed message that includes the exact enablementEnable call. Null when the job is off or already has an on enablement.',
		),
})

export const jobExecutionOutputSchema = z.discriminatedUnion('ok', [
	z.object({
		ok: z.literal(true),
		result: z.unknown().optional(),
		logs: z.array(z.string()),
	}),
	z.object({
		ok: z.literal(false),
		error: z.string(),
		logs: z.array(z.string()),
	}),
])

export const jobRunNowInputSchema = z.object({
	id: z.string().min(1).describe('Existing job id to execute immediately.'),
})

export const jobUpdateInputSchema = z
	.object({
		id: z
			.string()
			.min(1)
			.describe('Existing job id from jobList or jobGet output.'),
		name: z
			.unknown()
			.optional()
			.describe(
				'Rejected. A job is named by its key in package.json#kody.jobs; rename it there and publish.',
			),
		params: z
			.record(z.string(), z.unknown())
			.nullable()
			.optional()
			.describe(
				'Optional replacement params object passed as the first argument to the job entrypoint. Pass null to clear existing params.',
			),
		schedule: scheduledJobScheduleSchema
			.optional()
			.describe(
				'Optional replacement recurring schedule (cron or interval). One-shot delayed work uses workflows.create(...).',
			),
		timezone: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				'Optional timezone label for cron display and schedule calculation. Pass null to reset to UTC.',
			),
		enabled: z
			.boolean()
			.optional()
			.describe('Enable or disable the job without deleting it.'),
		kill_switch_enabled: z
			.boolean()
			.optional()
			.describe(
				'Force the job off regardless of schedule. This remains visible in jobList and jobGet for debugging.',
			),
		expires_at: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				'Optional UTC ISO timestamp after which the platform stops scheduling this job and auto-disables it (enabled=false). Pass null to clear.',
			),
		reason: z
			.string()
			.trim()
			.max(500)
			.optional()
			.describe(
				'Optional short reason for turning the job on or off. Recorded in the org audit log with who changed it, when, and from where. When turning the job off, it is also saved as the job disabled_reason.',
			),
		code: z
			.unknown()
			.optional()
			.describe(
				'Rejected. Job source cannot be changed via jobUpdate. Edit a package job in the package repo and publish.',
			),
	})
	.superRefine((input, ctx) => {
		if (input.code !== undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['code'],
				message: 'Job code cannot be changed via jobUpdate.',
			})
			return
		}
		if (input.name !== undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['name'],
				message:
					'Job name cannot be changed via jobUpdate. Rename the job in package.json#kody.jobs and publish.',
			})
			return
		}
		if (
			input.params === undefined &&
			input.schedule === undefined &&
			input.timezone === undefined &&
			input.enabled === undefined &&
			input.kill_switch_enabled === undefined &&
			input.expires_at === undefined
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Provide at least one mutable field to update.',
			})
		}
	})

export const jobRunNowOutputSchema = z.object({
	job: jobViewOutputSchema,
	execution: jobExecutionOutputSchema,
})

export type JobGetCapabilityInput = z.infer<typeof jobGetInputSchema>
export type JobRunNowCapabilityInput = z.infer<typeof jobRunNowInputSchema>
export type JobUpdateCapabilityInput = z.infer<typeof jobUpdateInputSchema>

export function resolveJobGetId(input: { id?: string; job_id?: string }) {
	if (input.id && input.job_id && input.id !== input.job_id) {
		throw new Error('id and job_id must match when both are provided.')
	}
	const jobId = input.id ?? input.job_id
	if (!jobId) {
		throw new Error('Job id is required.')
	}
	return jobId
}

function assertNeverScheduledJobSchedule(schedule: never): never {
	throw new Error(
		`Unhandled scheduled job schedule: ${JSON.stringify(schedule)}`,
	)
}

export function buildJobScheduleSummaryOutput(schedule: JobView['schedule']) {
	switch (schedule.type) {
		case 'interval':
			return {
				type: 'interval' as const,
				every: schedule.every,
			}
		case 'cron':
			return {
				type: 'cron' as const,
				expression: schedule.expression,
			}
	}
	return assertNeverScheduledJobSchedule(schedule)
}

export function toJobSchedule(
	schedule: z.infer<typeof scheduledJobScheduleSchema>,
): JobSchedule {
	switch (schedule.type) {
		case 'interval':
			return {
				type: 'interval',
				every: schedule.every,
			}
		case 'cron':
			return {
				type: 'cron',
				expression: schedule.expression,
			}
	}
	return assertNeverScheduledJobSchedule(schedule)
}

export function formatJobRecentRunFromRecord(
	run: RunRecord,
): JobRecentRunOutput | null {
	if (run.status === 'running' || run.finishedAt == null) return null
	return {
		id: run.id,
		started_at: run.startedAt,
		finished_at: run.finishedAt,
		status: run.status,
		duration_ms: run.durationMs ?? 0,
		error: run.errorMessage,
	}
}

export function buildJobViewOutput(
	job: JobView,
	input: {
		recentRuns?: Array<JobRecentRunOutput>
		now?: Date
		enablementHint?: string | null
	} = {},
) {
	const now = input.now ?? new Date()
	const expiresAt = job.expiresAt ?? null
	const expired =
		expiresAt != null &&
		Number.isFinite(new Date(expiresAt).valueOf()) &&
		new Date(expiresAt).valueOf() <= now.valueOf()
	const recentRuns = input.recentRuns ?? []
	return {
		job_id: job.id,
		name: job.name,
		source_id: job.sourceId,
		published_commit: job.publishedCommit,
		storage_id: job.storageId,
		params: job.params,
		schedule: buildJobScheduleSummaryOutput(job.schedule),
		schedule_summary: job.scheduleSummary,
		timezone: job.timezone,
		enabled: job.enabled,
		disabled_reason: job.enabled ? null : (job.disabledReason ?? null),
		kill_switch_enabled: job.killSwitchEnabled,
		expires_at: expiresAt,
		expired,
		created_at: job.createdAt,
		updated_at: job.updatedAt,
		last_run_at: job.lastRunAt,
		last_run_status: job.lastRunStatus,
		last_run_error: job.lastRunError,
		last_duration_ms: job.lastDurationMs,
		next_run_at: job.nextRunAt,
		run_count: job.runCount,
		success_count: job.successCount,
		error_count: job.errorCount,
		run_history: recentRuns.map((entry) => ({
			id: entry.id,
			started_at: entry.started_at,
			finished_at: entry.finished_at,
			status: entry.status,
			duration_ms: entry.duration_ms,
			...(entry.error ? { error: entry.error } : {}),
		})),
		enablement_hint: input.enablementHint ?? null,
	}
}

export function buildJobSourceInspectionOutput(source: JobSourceInspection) {
	return {
		entrypoint: source.entrypoint,
		code: source.code,
		error: source.error,
	}
}

export function buildJobInspectionOutput(
	job: JobView,
	input: {
		now?: Date
		recentRuns?: Array<JobRecentRunOutput>
		enablementHint?: string | null
	} = {},
) {
	const now = input.now ?? new Date()
	const nextRunAtValue = new Date(job.nextRunAt).valueOf()
	const expiresAt = job.expiresAt ?? null
	const expired =
		expiresAt != null &&
		Number.isFinite(new Date(expiresAt).valueOf()) &&
		new Date(expiresAt).valueOf() <= now.valueOf()
	const dueNow =
		job.enabled &&
		job.killSwitchEnabled === false &&
		!expired &&
		Number.isFinite(nextRunAtValue) &&
		nextRunAtValue <= now.valueOf()

	return {
		id: job.id,
		name: job.name,
		source_id: job.sourceId,
		published_commit: job.publishedCommit,
		storage_id: job.storageId,
		params: job.params ?? null,
		schedule: buildJobScheduleSummaryOutput(job.schedule),
		schedule_summary: job.scheduleSummary,
		timezone: job.timezone,
		enabled: job.enabled,
		disabled_reason: job.enabled ? null : (job.disabledReason ?? null),
		kill_switch_enabled: job.killSwitchEnabled,
		expires_at: expiresAt,
		expired,
		created_at: job.createdAt,
		updated_at: job.updatedAt,
		next_run_at: job.nextRunAt,
		due_now: dueNow,
		last_run_at: job.lastRunAt ?? null,
		last_run_status: job.lastRunStatus ?? null,
		last_run_error: job.lastRunError ?? null,
		last_duration_ms: job.lastDurationMs ?? null,
		run_count: job.runCount,
		success_count: job.successCount,
		error_count: job.errorCount,
		recent_runs: input.recentRuns ?? [],
		enablement_hint: input.enablementHint ?? null,
	}
}

/**
 * The scheduler's next job is org-wide state. Its id and timing are shown only
 * when that job is within the caller's read scope.
 */
export function buildJobManagerDebugOutput(
	state: JobManagerDebugState,
	scope: ResourceListScope,
) {
	const nextJobVisible =
		state.nextRunnableJobId == null ||
		listScopeIncludes(scope, state.nextRunnableJobId)
	return {
		binding_available: state.bindingAvailable,
		status: state.status,
		stored_user_id: state.storedUserId,
		alarm_scheduled_for: nextJobVisible ? state.alarmScheduledFor : null,
		next_runnable_job_id: nextJobVisible ? state.nextRunnableJobId : null,
		next_runnable_run_at: nextJobVisible ? state.nextRunnableRunAt : null,
		alarm_in_sync: state.alarmInSync,
	}
}

export function buildJobRunNowOutput(input: {
	job: JobView
	execution: JobExecutionResult
	enablementHint?: string | null
}) {
	return {
		job: buildJobViewOutput(input.job, {
			enablementHint: input.enablementHint,
		}),
		execution: input.execution,
	}
}

export function resolveJobUpdateBody(
	input: JobUpdateCapabilityInput,
): JobUpdateInput {
	return {
		id: input.id,
		params: input.params,
		schedule:
			input.schedule === undefined ? undefined : toJobSchedule(input.schedule),
		timezone: input.timezone,
		enabled: input.enabled,
		killSwitchEnabled: input.kill_switch_enabled,
		...(input.expires_at !== undefined ? { expiresAt: input.expires_at } : {}),
		...(input.reason ? { reason: input.reason } : {}),
	}
}

/** Every single-job surface checks the job itself, not only the surface. */
export async function authorizeJob(input: {
	env: Env
	callerContext: CapabilityContext['callerContext']
	permission: Extract<OrgPermission, `job:${string}`>
	jobId: string
}) {
	const request = requireMcpRequest(input.callerContext)
	await authorize(
		{ env: input.env, request },
		input.permission,
		orgResource(request, 'job', input.jobId),
	)
}

export async function runJobNowFromArgs(input: {
	env: Env
	callerContext: CapabilityContext['callerContext']
	args: JobRunNowCapabilityInput
}) {
	requireMcpUser(input.callerContext)
	await authorizeJob({
		env: input.env,
		callerContext: input.callerContext,
		permission: 'job:execute',
		jobId: input.args.id,
	})
	const { runJobNowViaManager } = await import('#worker/jobs/manager-client.ts')
	const result = await runJobNowViaManager({
		env: input.env,
		userId: ownerIdFromCaller(input.callerContext),
		jobId: input.args.id,
		callerContext: input.callerContext,
	})
	const enablementHint = await resolveCronJobEnablementHint({
		env: input.env,
		orgId: ownerIdFromCaller(input.callerContext),
		jobId: result.job.id,
		jobName: result.job.name,
		enabled: result.job.enabled,
	})
	return buildJobRunNowOutput({ ...result, enablementHint })
}

export async function updateJobFromArgs(input: {
	env: Env
	callerContext: CapabilityContext['callerContext']
	args: JobUpdateCapabilityInput
}) {
	requireMcpUser(input.callerContext)
	await authorizeJob({
		env: input.env,
		callerContext: input.callerContext,
		permission: 'job:write',
		jobId: input.args.id,
	})
	const { updateJob } = await import('#worker/jobs/service.ts')
	const updated = await updateJob({
		env: input.env,
		callerContext: input.callerContext,
		body: resolveJobUpdateBody(input.args),
	})
	logJobSchedulerEvent({
		event: 'job_updated',
		userId: ownerIdFromCaller(input.callerContext),
		jobId: updated.id,
		scheduleType: updated.schedule.type,
		nextRunAt: updated.nextRunAt,
	})
	const enablementHint = await resolveCronJobEnablementHint({
		env: input.env,
		orgId: ownerIdFromCaller(input.callerContext),
		jobId: updated.id,
		jobName: updated.name,
		enabled: updated.enabled,
	})
	return buildJobViewOutput(updated, { enablementHint })
}
