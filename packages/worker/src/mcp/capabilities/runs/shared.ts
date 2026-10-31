import { historyRanOn } from '#worker/execution-contexts/routing.ts'
import { z } from 'zod'
import {
	type RunRecord,
	type RunRecordLog,
	type RunRecordSummary,
	type RunRecordSurfaceSummary,
	runErrorTriageFilterValues,
	runErrorTriageMaxNoteLength,
	runErrorTriageValues,
	runLogLevelValues,
	runRecordDefaultPageSize,
	runRecordMaxPageSize,
	runStartedByClientValues,
	runStatusValues,
	runSurfaceValues,
} from '#worker/run-records/types.ts'

export const runSurfaceSchema = z.enum(runSurfaceValues)

export const runStatusSchema = z.enum(runStatusValues)

export const runErrorTriageSchema = z.enum(runErrorTriageValues)

export const runErrorTriageFilterSchema = z.enum(runErrorTriageFilterValues)

/** Wire values for `runUpdate`: set triage or reopen (`open`). */
export const runErrorTriageUpdateSchema = z.enum([
	'ignored',
	'resolved',
	'open',
])

export const runRecordSchema = z.object({
	id: z.string(),
	surface: runSurfaceSchema,
	status: runStatusSchema,
	name: z.string().nullable(),
	package_id: z.string().nullable(),
	kody_id: z.string().nullable(),
	source_id: z.string().nullable(),
	published_commit: z
		.string()
		.nullable()
		.describe(
			'Immutable commit SHA of the package source this run executed. Package workflow runs record it per attempt; see metadata.enqueued_commit for the commit resolved at enqueue.',
		),
	storage_id: z.string().nullable(),
	job_id: z.string().nullable(),
	workflow_id: z.string().nullable(),
	invocation_id: z.string().nullable(),
	session_id: z.string().nullable(),
	idempotency_key: z.string().nullable(),
	parent_run_id: z.string().nullable(),
	started_at: z.string(),
	finished_at: z.string().nullable(),
	duration_ms: z.number().int().nonnegative().nullable(),
	error_name: z.string().nullable(),
	error_message: z.string().nullable(),
	error_triage: runErrorTriageSchema
		.nullable()
		.describe(
			'Soft triage for error runs: ignored, resolved, or null when open / not an error.',
		),
	triage_note: z.string().nullable(),
	triaged_at: z.string().nullable(),
	triaged_by: z.string().nullable(),
	started_by: z
		.object({
			user_id: z.string().nullable(),
			username: z.string().nullable(),
			client: z.enum(runStartedByClientValues),
			label: z
				.string()
				.nullable()
				.describe(
					'Optional display label such as an API token name. Never a secret.',
				),
		})
		.nullable()
		.describe(
			'Who started this run (person + client). Null for legacy rows recorded before started_by existed, or when begin had no request context. Background clients (schedule, webhook, inbound-email, platform-event) name the enablement owner, not an interactive click.',
		),
	metadata: z.record(z.string(), z.unknown()),
	log_count: z.number().int().nonnegative(),
})

export const runRecordLogSchema = z.object({
	run_id: z.string(),
	sequence: z.number().int().nonnegative(),
	level: z.enum(runLogLevelValues),
	message: z.string(),
	fields: z.record(z.string(), z.unknown()).nullable(),
})

export const runRecordSurfaceSummarySchema = z.object({
	surface: runSurfaceSchema,
	total: z.number().int().nonnegative(),
	errors: z.number().int().nonnegative(),
})

export const runRecordSummarySchema = z.object({
	since: z.string(),
	total: z.number().int().nonnegative(),
	errors: z
		.number()
		.int()
		.nonnegative()
		.describe('Open (not ignored/resolved) error count.'),
	ignored: z
		.number()
		.int()
		.nonnegative()
		.describe('Error runs marked ignored.'),
	resolved: z
		.number()
		.int()
		.nonnegative()
		.describe('Error runs marked resolved.'),
	running: z.number().int().nonnegative(),
	by_surface: z.array(runRecordSurfaceSummarySchema),
})

export const runListLimitSchema = z
	.number()
	.int()
	.positive()
	.max(runRecordMaxPageSize)
	.optional()
	.describe(
		`Page size (default ${runRecordDefaultPageSize}, max ${runRecordMaxPageSize}).`,
	)

export const runTriageNoteSchema = z
	.string()
	.max(runErrorTriageMaxNoteLength)
	.optional()
	.describe(
		`Optional note (at most ${runErrorTriageMaxNoteLength} characters). Omit to preserve the current note when setting ignored/resolved; pass an empty string to clear it. Cleared automatically when triage is set to open.`,
	)

export function formatRunRecord(
	run: RunRecord,
): z.infer<typeof runRecordSchema> {
	return {
		id: run.id,
		surface: run.surface,
		status: run.status,
		name: run.name,
		package_id: run.packageId,
		kody_id: run.kodyId,
		source_id: run.sourceId,
		published_commit: run.publishedCommit,
		storage_id: run.storageId,
		job_id: run.jobId,
		workflow_id: run.workflowId,
		invocation_id: run.invocationId,
		session_id: run.sessionId,
		idempotency_key: run.idempotencyKey,
		parent_run_id: run.parentRunId,
		started_at: run.startedAt,
		finished_at: run.finishedAt,
		duration_ms: run.durationMs,
		error_name: run.errorName,
		error_message: run.errorMessage,
		error_triage: run.errorTriage,
		triage_note: run.triageNote,
		triaged_at: run.triagedAt,
		triaged_by: run.triagedBy,
		started_by: run.startedBy
			? {
					user_id: run.startedBy.userId,
					username: run.startedBy.username,
					client: run.startedBy.client,
					label: run.startedBy.label,
				}
			: null,
		metadata:
			run.surface === 'execute'
				? {
						...run.metadata,
						ranOn: historyRanOn(run.metadata['executionContext']),
					}
				: run.metadata,
		log_count: run.logCount,
	}
}

export function formatRunRecordLog(
	log: RunRecordLog,
): z.infer<typeof runRecordLogSchema> {
	return {
		run_id: log.runId,
		sequence: log.sequence,
		level: log.level,
		message: log.message,
		fields: log.fields,
	}
}

export function formatRunRecordSurfaceSummary(
	summary: RunRecordSurfaceSummary,
): z.infer<typeof runRecordSurfaceSummarySchema> {
	return {
		surface: summary.surface,
		total: summary.total,
		errors: summary.errors,
	}
}

export function formatRunRecordSummary(
	summary: RunRecordSummary,
): z.infer<typeof runRecordSummarySchema> {
	return {
		since: summary.since,
		total: summary.total,
		errors: summary.errors,
		ignored: summary.ignored,
		resolved: summary.resolved,
		running: summary.running,
		by_surface: summary.bySurface.map(formatRunRecordSurfaceSummary),
	}
}
