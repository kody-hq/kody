import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	executeWorkerIdMetadataKey,
	readExecuteEntry,
	type ExecuteEntry,
} from '#worker/run-records/execute-attribution.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { highlightJsonValue } from '#app/highlight-code.ts'
import { type ServerTimingEntry } from '#worker/server-timing.ts'
import { listToggleAudit } from '#worker/jobs/toggle-audit.ts'
import { type AccountToggleChange } from '#universal/loader-data.ts'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import {
	getRunRecord,
	listRunRecords,
	summarizeRunRecords,
} from '#worker/run-records/service.ts'
import {
	type RunErrorTriage,
	type RunLogLevel,
	type RunRecord,
	type RunRecordLog,
	type RunStartedBy,
	type RunStatus,
	type RunSurface,
	runRecordRetentionDays,
} from '#worker/run-records/types.ts'
import {
	accountActivitySummaryWindowMs,
	readAccountActivityFilters,
	statusFilterToRunStatus,
	surfaceFilterToRunSurface,
	type AccountActivityStatusFilter,
	type AccountActivitySurfaceFilter,
	type AccountActivityTriageFilter,
	type AccountActivityViewFilter,
} from '#universal/account-activity-filters.ts'

export {
	readAccountActivityFilters,
	statusFilterToRunStatus,
	surfaceFilterToRunSurface,
}

export type {
	AccountActivityStatusFilter,
	AccountActivitySurfaceFilter,
	AccountActivityTriageFilter,
	AccountActivityViewFilter,
}

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export type AccountActivityRunListItem = {
	id: string
	surface: RunSurface
	status: RunStatus
	name: string | null
	startedAt: string
	finishedAt: string | null
	durationMs: number | null
	errorName: string | null
	errorMessage: string | null
	errorTriage: RunErrorTriage | null
	packageId: string | null
	jobId: string | null
	logCount: number
	idempotencyKey: string | null
	entry: ExecuteEntry | null
	workerId: string | null
	startedBy: RunStartedBy | null
}

export type AccountActivityRunLog = {
	sequence: number
	level: RunLogLevel
	message: string
	fields: Record<string, unknown> | null
}

export type AccountActivityRunDetail = AccountActivityRunListItem & {
	kodyId: string | null
	sourceId: string | null
	publishedCommit: string | null
	storageId: string | null
	workflowId: string | null
	invocationId: string | null
	sessionId: string | null
	parentRunId: string | null
	triageNote: string | null
	triagedAt: string | null
	triagedBy: string | null
	metadata: Record<string, unknown>
	metadataHighlighted?: HighlightedCode
	logs: Array<AccountActivityRunLog>
}

export type AccountActivitySummary = {
	since: string
	total: number
	errors: number
	ignored: number
	resolved: number
	running: number
}

export type AccountActivityLoaderData = {
	ok: true
	viewFilter: AccountActivityViewFilter
	statusFilter: AccountActivityStatusFilter
	surfaceFilter: AccountActivitySurfaceFilter
	triageFilter: AccountActivityTriageFilter
	summary: AccountActivitySummary
	runs: Array<AccountActivityRunListItem>
	nextCursor: string | null
	selectedRun: AccountActivityRunDetail | null
	selectedRunId: string | null
	retentionDays: number
	/**
	 * Recent job and enablement on/off changes (newest first). Owners only:
	 * null for everyone else, on later pages, and when the read fails.
	 */
	toggleChanges: Array<AccountToggleChange> | null
}

export type { AccountToggleChange }

const toggleChangesLimit = 20

async function loadToggleChanges(input: {
	env: Env
	user: AuthenticatedUser
	orgId: string
	since: string
	cursor: string | null
}): Promise<Array<AccountToggleChange> | null> {
	if (input.cursor) return null
	if (input.user.request.membership?.role !== 'owner') return null
	try {
		const entries = await listToggleAudit({
			env: input.env,
			orgId: input.orgId,
			since: input.since,
			limit: toggleChangesLimit,
		})
		return entries.map(
			({ actorUserId: _actorUserId, credentialKind: _kind, ...entry }) => entry,
		)
	} catch (error) {
		console.warn('activity-toggle-changes-failed', {
			error: error instanceof Error ? error.message : String(error),
		})
		// Hide the panel: an empty list would read as "nothing changed".
		return null
	}
}

const accountActivityBasePath = '/account/activity'
const defaultPageSize = 25

export function readAccountActivitySelectedRunId(
	requestUrl: string,
	pathRunId?: string,
) {
	if (pathRunId?.trim()) return pathRunId.trim()
	const url = new URL(requestUrl, 'http://localhost')
	const detailPrefix = `${accountActivityBasePath}/`
	if (url.pathname.startsWith(detailPrefix)) {
		const segment = url.pathname.slice(detailPrefix.length)
		if (segment && !segment.includes('/')) {
			try {
				const runId = decodeURIComponent(segment)
				if (runId) return runId
			} catch {
				if (segment) return segment
			}
		}
	}
	const selected = url.searchParams.get('selected')?.trim()
	return selected ? selected : null
}

function readMetadataString(
	metadata: Record<string, unknown>,
	key: string,
): string | null {
	const value = metadata[key]
	return typeof value === 'string' && value.trim() ? value : null
}

function toListItem(run: RunRecord): AccountActivityRunListItem {
	return {
		id: run.id,
		surface: run.surface,
		status: run.status,
		name: run.name,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		durationMs: run.durationMs,
		errorName: run.errorName,
		errorMessage: run.errorMessage,
		errorTriage: run.errorTriage,
		packageId: run.packageId,
		jobId: run.jobId,
		logCount: run.logCount,
		idempotencyKey: run.idempotencyKey,
		entry: readExecuteEntry(run.metadata),
		workerId: readMetadataString(run.metadata, executeWorkerIdMetadataKey),
		startedBy: run.startedBy,
	}
}

async function toDetail(
	env: Env,
	run: RunRecord,
	logs: Array<RunRecordLog>,
	serverTiming?: Array<ServerTimingEntry>,
): Promise<AccountActivityRunDetail> {
	return {
		...toListItem(run),
		kodyId: run.kodyId,
		sourceId: run.sourceId,
		publishedCommit: run.publishedCommit,
		storageId: run.storageId,
		workflowId: run.workflowId,
		invocationId: run.invocationId,
		sessionId: run.sessionId,
		parentRunId: run.parentRunId,
		triageNote: run.triageNote,
		triagedAt: run.triagedAt,
		triagedBy: run.triagedBy,
		metadata: run.metadata,
		metadataHighlighted: await highlightJsonValue(env, run.metadata, {
			serverTiming,
		}),
		logs: logs
			.slice()
			.sort((a, b) => a.sequence - b.sequence)
			.map((entry) => ({
				sequence: entry.sequence,
				level: entry.level,
				message: entry.message,
				fields: entry.fields,
			})),
	}
}

function summarySince(now: Date) {
	return new Date(now.getTime() - accountActivitySummaryWindowMs).toISOString()
}

export async function loadAccountActivityData(input: {
	env: Env
	user: AuthenticatedUser
	selectedRunId: string | null
	viewFilter: AccountActivityViewFilter
	statusFilter: AccountActivityStatusFilter
	surfaceFilter: AccountActivitySurfaceFilter
	triageFilter: AccountActivityTriageFilter
	cursor: string | null
	now?: Date
	serverTiming?: Array<ServerTimingEntry>
}): Promise<AccountActivityLoaderData> {
	const userId = ownerIdFromCaller({
		request: input.user.request,
		user: input.user.mcpUser,
	})
	const now = input.now ?? new Date()
	const {
		selectedRunId,
		viewFilter,
		statusFilter,
		surfaceFilter,
		triageFilter,
		cursor,
	} = input
	const since = summarySince(now)

	const [summary, page, selectedRecord, toggleChanges] = await Promise.all([
		summarizeRunRecords({
			env: input.env,
			userId,
			since,
		}),
		listRunRecords({
			env: input.env,
			userId,
			filter: {
				status: statusFilterToRunStatus(statusFilter),
				surface: surfaceFilterToRunSurface(surfaceFilter),
				since,
				errorTriage: triageFilter,
			},
			limit: defaultPageSize,
			cursor,
		}),
		selectedRunId
			? getRunRecord({
					env: input.env,
					userId,
					runId: selectedRunId,
				})
			: Promise.resolve(null),
		loadToggleChanges({
			env: input.env,
			user: input.user,
			orgId: userId,
			since,
			cursor,
		}),
	])

	return {
		ok: true,
		viewFilter,
		statusFilter,
		surfaceFilter,
		triageFilter,
		summary: {
			since: summary.since,
			total: summary.total,
			errors: summary.errors,
			ignored: summary.ignored,
			resolved: summary.resolved,
			running: summary.running,
		},
		runs: page.runs.map(toListItem),
		nextCursor: page.nextCursor,
		selectedRun: selectedRecord
			? await toDetail(
					input.env,
					selectedRecord.run,
					selectedRecord.logs,
					input.serverTiming,
				)
			: null,
		selectedRunId,
		retentionDays: runRecordRetentionDays,
		toggleChanges,
	}
}
