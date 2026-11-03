import { formatJobError } from './schedule.ts'
import type { JobSchedule } from './types.ts'

const maxLoggedJobOutcomes = 10
const maxLoggedStringLength = 1_000
type SchedulerLogLevel = 'error' | 'info'

export type SchedulerJobOutcomeLog = {
	jobId: string
	scheduleType: JobSchedule['type']
	outcome: 'success' | 'failure'
	nextRunAt: string | null
	deleted: boolean
	error?: string
	rescheduleError?: string
}

export type SchedulerLogSource = 'alarm' | 'direct' | 'rpc' | 'run_now'

type JobSchedulerLogPayload = {
	event: string
	userId?: string
	jobId?: string | null
	scheduleType?: JobSchedule['type']
	sourceId?: string | null
	source?: SchedulerLogSource
	artifactKind?: 'app' | 'job' | 'module' | null
	artifactName?: string | null
	artifactEntryPoint?: string | null
	artifactCacheHit?: boolean
	artifactPublishedCommit?: string | null
	snapshotSource?: 'kv' | 'artifacts' | null
	buildDurationMs?: number
	dependencyCount?: number
	cleanupDeletedSourceId?: string | null
	cleanupDeletedStorageId?: string | null
	nextJobId?: string | null
	nextRunAt?: string | null
	currentAlarmAt?: string | null
	reason?: string
	dueJobCount?: number
	successCount?: number
	errorCount?: number
	jobOutcomes?: Array<SchedulerJobOutcomeLog>
	truncatedJobOutcomeCount?: number
	retryCount?: number
	isRetry?: boolean
	errorName?: string
	errorMessage?: string
	timestamp?: string
}

export function schedulerErrorFields(error: unknown): {
	errorName: string
	errorMessage: string
} {
	if (error instanceof Error) {
		return {
			errorName: error.name,
			errorMessage: error.message,
		}
	}

	return {
		errorName: 'Unknown',
		errorMessage: formatJobError(error),
	}
}

export function summarizeSchedulerJobOutcomes(
	jobOutcomes: Array<SchedulerJobOutcomeLog>,
): Pick<JobSchedulerLogPayload, 'jobOutcomes' | 'truncatedJobOutcomeCount'> {
	if (jobOutcomes.length <= maxLoggedJobOutcomes) {
		return { jobOutcomes }
	}

	return {
		jobOutcomes: jobOutcomes.slice(0, maxLoggedJobOutcomes),
		truncatedJobOutcomeCount: jobOutcomes.length - maxLoggedJobOutcomes,
	}
}

export function logJobSchedulerEvent(input: JobSchedulerLogPayload): void {
	writeSchedulerLog('info', input)
}

export function logJobSchedulerError(input: JobSchedulerLogPayload): void {
	writeSchedulerLog('error', input)
}

function writeSchedulerLog(
	level: SchedulerLogLevel,
	input: JobSchedulerLogPayload,
): void {
	try {
		const payload = sanitizeSchedulerLogPayload(input)
		console[level](
			'job-scheduler',
			JSON.stringify({
				...payload,
				timestamp: payload.timestamp ?? new Date().toISOString(),
			}),
		)
	} catch (error) {
		console.warn('job-scheduler-log-failed', {
			event: input.event,
			level,
			errorMessage: formatJobError(error),
		})
	}
}

function truncateLoggedString(value: string): string {
	if (value.length <= maxLoggedStringLength) {
		return value
	}

	return `${value.slice(0, maxLoggedStringLength)}...[truncated ${value.length - maxLoggedStringLength} chars]`
}

function truncateOptionalLoggedString<T extends string | null | undefined>(
	value: T,
): T {
	return typeof value === 'string' ? (truncateLoggedString(value) as T) : value
}

function sanitizeSchedulerJobOutcome(
	jobOutcome: SchedulerJobOutcomeLog,
): SchedulerJobOutcomeLog {
	return {
		...jobOutcome,
		...(jobOutcome.error
			? { error: truncateLoggedString(jobOutcome.error) }
			: {}),
		...(jobOutcome.rescheduleError
			? {
					rescheduleError: truncateLoggedString(jobOutcome.rescheduleError),
				}
			: {}),
	}
}

function sanitizeSchedulerLogPayload(
	input: JobSchedulerLogPayload,
): JobSchedulerLogPayload {
	return {
		...input,
		sourceId: truncateOptionalLoggedString(input.sourceId),
		artifactName: truncateOptionalLoggedString(input.artifactName),
		artifactEntryPoint: truncateOptionalLoggedString(input.artifactEntryPoint),
		artifactPublishedCommit: truncateOptionalLoggedString(
			input.artifactPublishedCommit,
		),
		cleanupDeletedSourceId: truncateOptionalLoggedString(
			input.cleanupDeletedSourceId,
		),
		cleanupDeletedStorageId: truncateOptionalLoggedString(
			input.cleanupDeletedStorageId,
		),
		...(input.errorMessage
			? { errorMessage: truncateLoggedString(input.errorMessage) }
			: {}),
		...(input.jobOutcomes
			? {
					jobOutcomes: input.jobOutcomes.map(sanitizeSchedulerJobOutcome),
				}
			: {}),
	}
}
