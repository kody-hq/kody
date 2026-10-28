import { type McpCallerContext, type McpUserContext } from '../chat.ts'
import { type OwnerId } from '../owner-person-ids.ts'

export type JobSchedule =
	| {
			type: 'cron'
			expression: string
	  }
	| {
			type: 'interval'
			every: string
	  }

export type JobRunStatus = 'success' | 'error'

export type JobRepoCheckPolicy = {
	allowTypecheckFailures?: boolean
}

export type JobRecord = {
	version: 1
	id: string
	userId: OwnerId
	name: string
	sourceId: string
	publishedCommit: string | null
	repoCheckPolicy?: JobRepoCheckPolicy
	storageId: string
	params?: Record<string, unknown>
	schedule: JobSchedule
	timezone: string
	enabled: boolean
	killSwitchEnabled: boolean
	/**
	 * Optional UTC ISO timestamp after which the platform stops scheduling and
	 * auto-disables the job (`enabled = false`). Null means never expires.
	 * Separate from `lease_expires_at` (claim lease).
	 */
	expiresAt: string | null
	/**
	 * Why the job is off, in plain words: the reason given when someone turned
	 * it off, or what Kody did (auto-disable or expiry).
	 * Null while the job is on, and for jobs turned off before this existed.
	 */
	disabledReason?: string | null
	createdAt: string
	updatedAt: string
	lastRunAt?: string
	lastRunStatus?: JobRunStatus
	lastRunError?: string
	lastDurationMs?: number
	nextRunAt: string
	runCount: number
	successCount: number
	errorCount: number
}

export type JobView = Omit<JobRecord, 'userId'> & {
	scheduleSummary: string
}

export type JobSourceInspection = {
	entrypoint: string | null
	code: string | null
	error: string | null
}

export type JobSearchProjection = {
	id: string
	name: string
	description: string
	scheduleSummary: string
	sourceId: string
	publishedCommit: string | null
	storageId: string
	updatedAt: string
}

export type JobExecutionResult =
	| {
			ok: true
			result?: unknown
			logs: Array<string>
	  }
	| {
			ok: false
			error: string
			logs: Array<string>
	  }

export type JobExecutionOutcome = {
	execution: JobExecutionResult
	startedAt: string
	finishedAt: string
	durationMs: number
}

export type PersistedJobCallerContext = Pick<
	McpCallerContext,
	'baseUrl' | 'executionOrigin' | 'storageContext' | 'repoContext'
> & {
	user: McpUserContext
}

export type JobUpdateInput = {
	id: string
	params?: Record<string, unknown> | null
	schedule?: JobSchedule
	timezone?: string | null
	enabled?: boolean
	killSwitchEnabled?: boolean
	/** Pass null to clear expiry. Omit to leave unchanged. */
	expiresAt?: string | null
	/** Why `enabled` changed, recorded in the org audit log. */
	reason?: string | null
}
