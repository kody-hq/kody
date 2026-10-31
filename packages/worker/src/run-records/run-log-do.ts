import {
	type SkillReadEvent,
	type SkillReadSummary,
} from '#universal/skill-metrics.ts'
import {
	initializeSkillReads,
	insertSkillRead,
	summarizeSkillReads,
	exportSkillReads,
} from './skill-reads.ts'
import { type WorkspaceRunBucket } from '#universal/workspace-charts.ts'
import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import {
	chunkArray,
	maxD1BoundParameters,
} from '@kody-internal/shared/chunk.ts'
import { toJsonSafeValue } from '@kody-internal/shared/json-safe-value.ts'
import {
	type DurableObjectPitrRpc,
	getRecoveryBookmark,
	restoreToBookmark,
} from '#worker/dr/do-pitr.ts'
import {
	releasedWorkflowProjectionIdempotencyKey,
	terminalWorkflowStatusValues,
} from '#worker/package-runtime/workflow-statuses.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import { type RunLogAdminInsightsSnapshot } from './admin-insights-snapshot.ts'
import {
	emptyRunLogFailureCounts,
	headerOnlyPlacementRefusalMarkers,
	type RunLogFailureCounts,
	type RunLogPackageFailureSummary,
	type RunLogPackageFailureSummaryInput,
	type RunLogPackageFailureSummaryRow,
} from './package-failure-summary.ts'
import {
	type ActivationMilestone,
	type ActivationMilestoneRecord,
	type PackageRunSuccessRecord,
	countsTowardPackageActivation,
} from './package-activation-state.ts'
import {
	type JobRunObservabilityRecord,
	type JobRunObservabilityStatus,
	type JobRunObservabilityUpsertInput,
} from './job-run-observability.ts'
import {
	type WorkflowProjectionRecord,
	type WorkflowProjectionReserveResult,
	type WorkflowProjectionSourceType,
	type WorkflowProjectionUpsertInput,
	creatingWorkflowProjectionStatus,
	parseWorkflowProjectionSourceRevision,
	workflowProjectionActiveStatuses,
	workflowProjectionCreatingTtlMs,
	workflowProjectionReservationStatuses,
} from './workflow-projection.ts'
import {
	type RunErrorTriage,
	type RunErrorTriageFilter,
	type RunLogLevel,
	type RunRecord,
	type RunRecordLog,
	type RunRecordPage,
	type RunRecordSummary,
	type RunStatus,
	type RunSurface,
	packageInvocationLedgerRetentionDays,
	runErrorTriageMaxNoteLength,
	runErrorTriageValues,
	runErrorTriageForPlatformInterrupt,
	runRecordMaxJsonBytes,
	runRecordMaxLogEntriesPerRun,
	runRecordMaxRunsPerUser,
	runRecordMaxTextBytes,
	runRecordDefaultPageSize,
	runRecordMaxPageSize,
	runRecordPlatformInterruptedErrorMessage,
	runRecordPlatformInterruptedErrorName,
	runRecordRetentionAlarmMs,
	runRecordRetentionDays,
	runRecordRetentionEmptyBackoffMaxMs,
	runRecordRetentionEmptyBackoffMinMs,
	runRecordRetentionEveryNFinishes,
	runRecordStaleRunningTtlMsForSurface,
	runRecordStaleRunningTtlMsScheduledJob,
	isScheduledJobIdempotencyKey,
	runSurfaceValues,
	workflowProjectionRetentionDays,
} from './types.ts'
import { normalizeRunStartedBy, type RunStartedBy } from './run-started-by.ts'
import { recordDurableObjectPlatformRowsRead } from '#worker/usage/durable-object-rows.ts'

const textEncoder = new TextEncoder()
const maxAgeDeletesPerFinish = 100
const maxExcessDeletesPerFinish = 100
const maxStaleRunningReconcilesPerPass = 100
const maxLedgerAgeDeletesPerPass = 100
const maxWorkflowProjectionAgeDeletesPerPass = 100
const maxStaleCreatingDeletesPerPass = 100

const metaRunCountKey = 'run_count'
const metaFinishesSinceRetentionKey = 'finishes_since_retention'
const metaRetentionEmptyBackoffKey = 'retention_empty_backoff_ms'
const metaSchemaVersionKey = 'schema_version'
/** YYYYMMDD coverage floor for warm v12→v13 (no backfill). Fresh DOs omit this. */
const metaRunDayCountsSinceKey = 'run_day_counts_since'
/** Bump when initializeSchema's DDL set changes; warm objects skip DDL. */
const runLogSchemaVersion = 18

function utcDayToMetaInt(day: string): number {
	return Number(day.replaceAll('-', ''))
}

function metaIntToUtcDay(value: number): string {
	const digits = String(value).padStart(8, '0')
	return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
}

type RunLogSqlBillingOp =
	| 'listRuns'
	| 'getRun'
	| 'summarize'
	| 'enforceRetention'
	| 'reconcileStaleRunning'
	| 'finishRun'
	| 'exportRuns'
	| 'findRunByIdempotencyKey'
	| 'healStaleRunning'
	| 'updateRunErrorTriage'

export const runLogSqlBillingOps = [
	'listRuns',
	'getRun',
	'summarize',
	'enforceRetention',
	'reconcileStaleRunning',
	'finishRun',
	'exportRuns',
	'findRunByIdempotencyKey',
	'healStaleRunning',
	'updateRunErrorTriage',
] as const satisfies ReadonlyArray<RunLogSqlBillingOp>

function sqlBillingMetaKey(
	op: RunLogSqlBillingOp,
	kind: 'rr' | 'rw' | 'n',
): string {
	return `sql_${kind}_${op}`
}

export type RunLogSqlBillingOpStats = {
	op: RunLogSqlBillingOp
	rowsRead: number
	rowsWritten: number
	calls: number
}

export type RunLogSqlBillingStats = {
	databaseSize: number
	rowsReadTotal: number
	rowsWrittenTotal: number
	ops: Array<RunLogSqlBillingOpStats>
}

type RunLogSqlIndexInfo = {
	seq: number
	name: string
	unique: boolean
	origin: string
	partial: boolean
}

type RunLogSqlColumnInfo = {
	cid: number
	name: string
	type: string
	notnull: boolean
	dfltValue: string | null
	pk: number
}

type RunLogSqlExplainStep = {
	id: number
	parent: number
	detail: string
}

type RunLogSqlTableCounts = {
	runs: number
	runLogs: number
	packageInvocationLedger: number
	workflowProjections: number
	runDayCounts: number
}

export type RunLogSqlBillingInspection = {
	schemaVersion: number | null
	billing: RunLogSqlBillingStats
	runLogsIndexes: Array<RunLogSqlIndexInfo>
	runLogsColumns: Array<RunLogSqlColumnInfo>
	tableCounts: RunLogSqlTableCounts
	runCount: {
		meta: number | null
		actual: number
		matches: boolean
	}
	explainRunLogsDeleteByRunId: Array<RunLogSqlExplainStep>
	explainRunLogsSelectByRunId: Array<RunLogSqlExplainStep>
}

/** Placeholder bind for EXPLAIN QUERY PLAN — not a real run id. */
const sqlBillingExplainProbeRunId = '__admin_sql_probe__'

const sqlBillingCountableTables = {
	runs: 'runs',
	run_logs: 'run_logs',
	package_invocation_ledger: 'package_invocation_ledger',
	workflow_projections: 'workflow_projections',
	run_day_counts: 'run_day_counts',
} as const

/**
 * Cursor namespaces for `exportRuns` phases after the raw run-id phase.
 * Run-phase cursors stay raw run ids for backward compatibility with cursors
 * minted before later phases existed.
 */
const exportLedgerCursorPrefix = 'invocation-ledger:'
const exportWorkflowProjectionsCursorPrefix = 'workflow-projections:'
const exportJobRunObservabilityCursorPrefix = 'job-run-observability:'
const exportPackageRunSuccessesCursorPrefix = 'package-run-successes:'
const exportActivationMilestonesCursorPrefix = 'activation-milestones:'
const exportSkillReadsCursorPrefix = 'skill-reads:'

const platformInterruptTriageNote =
	'auto-ignored: idempotent scheduler or delivery queue will retry'
const platformInterruptTriagedBy = 'system:platform-interrupt'

const retentionMs = runRecordRetentionDays * 24 * 60 * 60 * 1000
const ledgerRetentionMs =
	packageInvocationLedgerRetentionDays * 24 * 60 * 60 * 1000
const workflowProjectionRetentionMs =
	workflowProjectionRetentionDays * 24 * 60 * 60 * 1000

const workflowProjectionTerminalStatuses: ReadonlyArray<string> =
	terminalWorkflowStatusValues

export type RunLogRowInput = {
	id: string
	surface: RunSurface
	status: RunStatus
	name: string | null
	packageId: string | null
	kodyId: string | null
	sourceId: string | null
	publishedCommit: string | null
	storageId: string | null
	jobId: string | null
	workflowId: string | null
	invocationId: string | null
	sessionId: string | null
	idempotencyKey: string | null
	parentRunId: string | null
	startedAt: string
	finishedAt: string | null
	durationMs: number | null
	errorName: string | null
	errorMessage: string | null
	startedBy: RunStartedBy | null
	metadataJson: string
	createdAt: string
	updatedAt: string
}

export type RunLogEntryInput = {
	sequence: number
	level: RunLogLevel
	message: string
	fieldsJson: string | null
}

export type PackageInvocationLedgerStatus =
	| 'in_progress'
	| 'completed'
	| 'failed'

/**
 * One keyed package-invocation idempotency row. Same shape as the legacy D1
 * `package_invocations` table minus `user_id` — the DO identity is the user.
 */
export type PackageInvocationLedgerRecord = {
	id: string
	tokenId: string
	packageId: string
	packageKodyId: string
	exportName: string
	idempotencyKey: string
	requestHash: string
	source: string | null
	topic: string | null
	/**
	 * Stable id for the delivery/attempt lineage that holds this claim (for
	 * example a webhook ack `deliveryId`). Same-owner retries may reclaim a
	 * fresh `in_progress` row; other callers still wait for stale expiry or a
	 * terminal response so genuine sender duplicates keep deduping.
	 */
	claimOwner: string | null
	status: PackageInvocationLedgerStatus
	/** Bounded replay cache; `null` when the terminal response was oversized. */
	responseJson: string | null
	createdAt: string
	updatedAt: string
}

export type PackageInvocationLedgerKey = {
	tokenId: string
	packageId: string
	exportName: string
	idempotencyKey: string
}

export type PackageInvocationClaimInput = PackageInvocationLedgerKey & {
	id: string
	packageKodyId: string
	requestHash: string
	source: string | null
	topic: string | null
	/** See {@link PackageInvocationLedgerRecord.claimOwner}. */
	claimOwner?: string | null
}

export type PackageInvocationClaimResult =
	| {
			outcome: 'claimed'
			invocationId: string
			claimUpdatedAt: string
			/** True when a stale `in_progress` row was taken over in place. */
			reclaimed: boolean
	  }
	| { outcome: 'existing'; record: PackageInvocationLedgerRecord }

type ListRunsInput = {
	surface?: RunSurface | null
	status?: RunStatus | null
	packageId?: string | null
	jobId?: string | null
	workflowId?: string | null
	name?: string | null
	since?: string | null
	until?: string | null
	errorTriage?: RunErrorTriageFilter | null
	startedByUserId?: string | null
	executionContextId?: string | null
	limit: number
	cursor?: string | null
}

export type UpdateRunErrorTriageInput = {
	runId: string
	/** `null` clears triage (reopen). */
	errorTriage: RunErrorTriage | null
	/**
	 * When true, keep the existing note (used when the caller omitted `note`
	 * so RPC cannot rely on `undefined` surviving structured clone).
	 */
	preserveTriageNote?: boolean
	/**
	 * `null` or empty clears the note. Ignored when `preserveTriageNote` is
	 * true, and cleared automatically when reopening (`errorTriage: null`).
	 */
	triageNote?: string | null
	triagedBy: string
}

export type UpdateRunErrorTriageResult =
	| { ok: true; run: RunRecord }
	| { ok: false; reason: 'not_found' }
	| { ok: false; reason: 'not_error'; status: RunStatus; runId: string }

export type BulkUpdateRunErrorTriageFilter = {
	surface?: RunSurface | null
	packageId?: string | null
	jobId?: string | null
	name?: string | null
	errorName?: string | null
	errorMessage?: string | null
	errorTriage?: RunErrorTriageFilter | null
}

export type BulkUpdateRunErrorTriageInput = {
	runIds?: Array<string> | null
	filter?: BulkUpdateRunErrorTriageFilter | null
	errorTriage: RunErrorTriage | null
	preserveTriageNote?: boolean
	triageNote?: string | null
	triagedBy: string
	limit: number
	dryRun?: boolean
}

export type BulkUpdateRunErrorTriageResult = {
	matchedRunIds: Array<string>
	updatedCount: number
	hasMore: boolean
}

type ExportRunsInput = {
	pageSize: number
	startAfter?: string | null
}

export type ExportRunsResult = {
	runs: Array<RunRecord>
	logs: Array<RunRecordLog>
	packageInvocations: Array<PackageInvocationLedgerRecord>
	workflowProjections: Array<WorkflowProjectionRecord>
	jobRunObservability: Array<JobRunObservabilityRecord>
	packageRunSuccesses: Array<PackageRunSuccessRecord>
	activationMilestones: Array<ActivationMilestoneRecord>
	skillReads: Array<SkillReadEvent>
	nextStartAfter: string | null
	truncated: boolean
}

type CursorPayload = {
	startedAt: string
	id: string
}

type WorkflowProjectionListInput = {
	limit: number
	cursor?: string | null
	status?: string | null
	/** When set, matches `status IN (...)`. Ignored when `status` is set. */
	statuses?: ReadonlyArray<string> | null
	bindingName?: string | null
	/** Exact workflow projection id (dynwf-… / pkgwf-…). */
	id?: string | null
	packageId?: string | null
	/** Inclusive lower bound on created_at (canonical ISO). */
	since?: string | null
}

function truncateUtf8(value: string, maxBytes: number) {
	if (textEncoder.encode(value).length <= maxBytes) return value
	const suffix = '... [truncated]'
	let low = 0
	let high = value.length
	let best = ''
	while (low <= high) {
		const midpoint = Math.floor((low + high) / 2)
		const candidate = `${value.slice(0, midpoint)}${suffix}`
		if (textEncoder.encode(candidate).length <= maxBytes) {
			best = candidate
			low = midpoint + 1
		} else {
			high = midpoint - 1
		}
	}
	return best
}

function serializeJson(value: unknown, maxBytes = runRecordMaxJsonBytes) {
	const json = JSON.stringify(toJsonSafeValue(value))
	if (textEncoder.encode(json).length <= maxBytes) return json
	let preview = truncateUtf8(json, Math.max(0, maxBytes - 128))
	let wrapped = JSON.stringify({
		__truncated__: true,
		preview,
	})
	while (textEncoder.encode(wrapped).length > maxBytes && preview.length > 0) {
		preview = preview.slice(0, Math.floor(preview.length * 0.8))
		wrapped = JSON.stringify({
			__truncated__: true,
			preview,
		})
	}
	return wrapped
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== 'string' || value.length === 0) return {}
	try {
		const parsed = JSON.parse(value) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {}
		}
		return parsed as Record<string, unknown>
	} catch {
		return {}
	}
}

function isRunSurface(value: string): value is RunSurface {
	return (runSurfaceValues as ReadonlyArray<string>).includes(value)
}

function encodeCursor(payload: CursorPayload) {
	return btoa(JSON.stringify(payload))
}

function decodeCursor(cursor: string): CursorPayload | null {
	try {
		const parsed = JSON.parse(atob(cursor)) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return null
		}
		const record = parsed as Record<string, unknown>
		const startedAt = record['startedAt']
		const id = record['id']
		if (typeof startedAt !== 'string' || typeof id !== 'string') return null
		return { startedAt, id }
	} catch {
		return null
	}
}

function normalizePageSize(pageSize: number | undefined, fallback: number) {
	const requested =
		typeof pageSize === 'number' && Number.isFinite(pageSize)
			? Math.trunc(pageSize)
			: fallback
	return Math.min(Math.max(requested, 1), runRecordMaxPageSize)
}

function sqlNumber(value: SqlStorageValue | undefined): number {
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (typeof value === 'bigint') return Number(value)
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value)
		return Number.isFinite(parsed) ? parsed : 0
	}
	return 0
}

function sqlString(value: SqlStorageValue | undefined): string {
	if (value == null) return ''
	return String(value)
}

function sqlFlag(value: SqlStorageValue | undefined): boolean {
	return sqlNumber(value) !== 0
}

function mapSqlIndexInfo(
	row: Record<string, SqlStorageValue>,
): RunLogSqlIndexInfo {
	return {
		seq: sqlNumber(row['seq']),
		name: sqlString(row['name']),
		unique: sqlFlag(row['unique']),
		origin: sqlString(row['origin']),
		partial: sqlFlag(row['partial']),
	}
}

function mapSqlColumnInfo(
	row: Record<string, SqlStorageValue>,
): RunLogSqlColumnInfo {
	return {
		cid: sqlNumber(row['cid']),
		name: sqlString(row['name']),
		type: sqlString(row['type']),
		notnull: sqlFlag(row['notnull']),
		dfltValue: row['dflt_value'] == null ? null : sqlString(row['dflt_value']),
		pk: sqlNumber(row['pk']),
	}
}

function mapSqlExplainStep(
	row: Record<string, SqlStorageValue>,
): RunLogSqlExplainStep {
	return {
		// EXPLAIN QUERY PLAN columns are selectid/from/detail; bytecode EXPLAIN uses id/parent.
		id: sqlNumber(row['selectid'] ?? row['id']),
		parent: sqlNumber(row['from'] ?? row['parent']),
		detail: sqlString(row['detail']),
	}
}

function isRunErrorTriage(value: string): value is RunErrorTriage {
	return (runErrorTriageValues as ReadonlyArray<string>).includes(value)
}

function mapRunRow(
	row: Record<string, SqlStorageValue>,
	logCount: number,
): RunRecord {
	const surface = String(row['surface'] ?? '')
	const status = String(row['status'] ?? '')
	const rawTriage =
		row['error_triage'] == null ? null : String(row['error_triage'])
	return {
		id: String(row['id']),
		surface: (isRunSurface(surface) ? surface : 'execute') as RunSurface,
		status: status as RunStatus,
		name: row['name'] == null ? null : String(row['name']),
		packageId: row['package_id'] == null ? null : String(row['package_id']),
		kodyId:
			row['package_kody_id'] == null ? null : String(row['package_kody_id']),
		sourceId: row['source_id'] == null ? null : String(row['source_id']),
		publishedCommit:
			row['published_commit'] == null ? null : String(row['published_commit']),
		storageId: row['storage_id'] == null ? null : String(row['storage_id']),
		jobId: row['job_id'] == null ? null : String(row['job_id']),
		workflowId: row['workflow_id'] == null ? null : String(row['workflow_id']),
		invocationId:
			row['invocation_id'] == null ? null : String(row['invocation_id']),
		sessionId: row['session_id'] == null ? null : String(row['session_id']),
		idempotencyKey:
			row['idempotency_key'] == null ? null : String(row['idempotency_key']),
		parentRunId:
			row['parent_run_id'] == null ? null : String(row['parent_run_id']),
		startedAt: String(row['started_at']),
		finishedAt: row['finished_at'] == null ? null : String(row['finished_at']),
		durationMs:
			row['duration_ms'] == null ? null : Number(row['duration_ms']) || 0,
		errorName: row['error_name'] == null ? null : String(row['error_name']),
		errorMessage:
			row['error_message'] == null ? null : String(row['error_message']),
		errorTriage: rawTriage && isRunErrorTriage(rawTriage) ? rawTriage : null,
		triageNote: row['triage_note'] == null ? null : String(row['triage_note']),
		triagedAt: row['triaged_at'] == null ? null : String(row['triaged_at']),
		triagedBy: row['triaged_by'] == null ? null : String(row['triaged_by']),
		startedBy: mapStartedByColumns(row),
		metadata: parseJsonRecord(row['metadata_json']),
		logCount,
	}
}

function mapStartedByColumns(
	row: Record<string, SqlStorageValue>,
): RunStartedBy | null {
	const clientRaw =
		row['started_by_client'] == null ? null : String(row['started_by_client'])
	if (!clientRaw) return null
	return normalizeRunStartedBy({
		userId:
			row['started_by_user_id'] == null
				? null
				: String(row['started_by_user_id']),
		username:
			row['started_by_username'] == null
				? null
				: String(row['started_by_username']),
		client: clientRaw as RunStartedBy['client'],
		label:
			row['started_by_label'] == null ? null : String(row['started_by_label']),
		profileId:
			row['started_by_profile_id'] == null
				? null
				: String(row['started_by_profile_id']),
		profileChain: parseProfileChainColumn(row['started_by_profile_chain']),
	})
}

function parseProfileChainColumn(value: SqlStorageValue | undefined) {
	if (typeof value !== 'string' || !value) return null
	try {
		const parsed: unknown = JSON.parse(value)
		return Array.isArray(parsed) &&
			parsed.every((entry) => typeof entry === 'string')
			? (parsed as Array<string>)
			: null
	} catch {
		return null
	}
}

function mapLogRow(row: Record<string, SqlStorageValue>): RunRecordLog {
	return {
		runId: String(row['run_id']),
		sequence: Number(row['sequence']) || 0,
		level: String(row['level']) as RunLogLevel,
		message: String(row['message']),
		fields:
			row['fields_json'] == null ? null : parseJsonRecord(row['fields_json']),
	}
}

function normalizeClaimOwner(value: string | null | undefined): string | null {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : null
}

function mapInvocationLedgerRow(
	row: Record<string, SqlStorageValue>,
): PackageInvocationLedgerRecord {
	const status = String(row['status'] ?? '')
	return {
		id: String(row['id']),
		tokenId: String(row['token_id']),
		packageId: String(row['package_id']),
		packageKodyId: String(row['package_kody_id']),
		exportName: String(row['export_name']),
		idempotencyKey: String(row['idempotency_key']),
		requestHash: String(row['request_hash']),
		source: row['source'] == null ? null : String(row['source']),
		topic: row['topic'] == null ? null : String(row['topic']),
		claimOwner: row['claim_owner'] == null ? null : String(row['claim_owner']),
		status: (status === 'completed' || status === 'failed'
			? status
			: 'in_progress') as PackageInvocationLedgerStatus,
		responseJson:
			row['response_json'] == null ? null : String(row['response_json']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function mapWorkflowProjectionRow(
	row: Record<string, SqlStorageValue>,
): WorkflowProjectionRecord {
	const rawSourceType = String(row['source_type'] ?? '')
	const sourceType: WorkflowProjectionSourceType =
		rawSourceType === 'inline' ? 'inline' : 'package'
	return {
		id: String(row['id']),
		bindingName: String(row['binding_name']),
		sourceType,
		packageId: row['package_id'] == null ? null : String(row['package_id']),
		kodyId: row['kody_id'] == null ? null : String(row['kody_id']),
		sourceId: row['source_id'] == null ? null : String(row['source_id']),
		workflowName: String(row['workflow_name']),
		exportName: row['export_name'] == null ? null : String(row['export_name']),
		idempotencyKey: String(row['idempotency_key']),
		runAt: String(row['run_at']),
		planDate: row['plan_date'] == null ? null : String(row['plan_date']),
		status: row['status'] == null ? null : String(row['status']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
		completedAt:
			row['completed_at'] == null ? null : String(row['completed_at']),
		lastError: row['last_error'] == null ? null : String(row['last_error']),
		enqueuedCommit:
			row['enqueued_commit'] == null ? null : String(row['enqueued_commit']),
		sourceRevision: parseWorkflowProjectionSourceRevision(
			row['source_revision'],
		),
	}
}

function mapJobRunObservabilityRow(
	row: Record<string, SqlStorageValue>,
): JobRunObservabilityRecord {
	const rawStatus = row['last_run_status']
	const lastRunStatus: JobRunObservabilityStatus | null =
		rawStatus === 'success' || rawStatus === 'error' ? rawStatus : null
	return {
		jobId: String(row['job_id']),
		lastRunAt: row['last_run_at'] == null ? null : String(row['last_run_at']),
		lastRunStatus,
		lastRunError:
			row['last_run_error'] == null ? null : String(row['last_run_error']),
		lastDurationMs:
			row['last_duration_ms'] == null
				? null
				: Number(row['last_duration_ms']) || 0,
		runCount: Number(row['run_count'] ?? 0) || 0,
		successCount: Number(row['success_count'] ?? 0) || 0,
		errorCount: Number(row['error_count'] ?? 0) || 0,
		updatedAt: String(row['updated_at']),
	}
}

function mapPackageRunSuccessRow(
	row: Record<string, SqlStorageValue>,
): PackageRunSuccessRecord {
	return {
		packageId: String(row['package_id']),
		successCount: Number(row['success_count'] ?? 0) || 0,
		updatedAt: String(row['updated_at']),
	}
}

function mapActivationMilestoneRow(
	row: Record<string, SqlStorageValue>,
): ActivationMilestoneRecord {
	return {
		milestone: String(row['milestone']) as ActivationMilestone,
		reachedAt: String(row['reached_at']),
		packageId: row['package_id'] == null ? null : String(row['package_id']),
	}
}

function clampMetadataJson(metadataJson: string) {
	if (textEncoder.encode(metadataJson).length <= runRecordMaxJsonBytes) {
		return metadataJson
	}
	return serializeJson(parseJsonRecord(metadataJson))
}

class RunLogBase extends DurableObject<Env> {
	/**
	 * In-isolate cache: once we know an alarm is scheduled, hot finishes skip
	 * getAlarm/setAlarm. Cleared when a pass self-terminates with no rows left
	 * to prune, or when a new `running` insert may need an earlier wake.
	 */
	private retentionAlarmArmed = false
	/**
	 * In-isolate: the DO is empty of future retention work. Cleared on every
	 * startRun/finishRun write so ensureRetentionAlarm re-arms for the new
	 * row's due-time instead of trusting a stale idle conclusion.
	 */
	private retentionIdleConfirmed = false
	/**
	 * In-isolate memo for `run_log_meta` counters. Durable Object handlers are
	 * single-threaded and these keys are only written through setMeta helpers
	 * below, so repeated getRunCount / getFinishesSinceRetention in one jsrpc
	 * (finish → retention → alarm arming) can reuse the loaded value instead of
	 * re-issuing identical SELECTs (Sentry "Inefficient Database Queries").
	 * Cleared on schema init / clearAll so SQL rebuild paths reload fresh.
	 */
	private runCountCache: number | null = null
	private finishesSinceRetentionCache: number | null = null
	/**
	 * Per-op SqlStorageCursor.rowsRead/rowsWritten accumulators for this
	 * isolate. Durable totals use atomic run_log_meta increments. Rows read
	 * also stream to `durable_object_platform_rows_read` (observe-only, never
	 * in include or overage math) keyed by the DO name, which is the user's
	 * stable id.
	 */
	private sqlBillingByOp = new Map<
		RunLogSqlBillingOp,
		{ rowsRead: number; rowsWritten: number; calls: number }
	>()
	/** Same-isolate summarize reuse; cleared on any run-row mutation. */
	private summarizeMemo: {
		cacheKey: string
		summary: RunRecordSummary
	} | null = null

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.ctx.blockConcurrencyWhile(async () => {
			this.initializeSchema()
			this.ensureRunCountMeta()
			// Observe existing alarm only — never arm in the constructor.
			// An unvisited DO never runs (platform constraint); the first write
			// re-converges via ensureRetentionAlarm after clearing idle.
			this.retentionAlarmArmed = (await this.ctx.storage.getAlarm()) != null
		})
	}

	async recordSkillRead(event: SkillReadEvent): Promise<void> {
		insertSkillRead(this.ctx.storage.sql, event)
	}
	async skillReadSummary(input: {
		since: string
		packageIds: Array<string>
	}): Promise<SkillReadSummary> {
		return summarizeSkillReads(this.ctx.storage.sql, input)
	}

	private initializeSchema() {
		// Schema rebuild (clearAll / DR restore / warm-migration tests) may
		// rewrite storage under us; drop counter memos so the next read reloads.
		this.runCountCache = null
		this.finishesSinceRetentionCache = null
		this.summarizeMemo = null
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS run_log_meta (
				key TEXT PRIMARY KEY NOT NULL,
				value INTEGER NOT NULL
			)
		`)
		const installedVersion = this.getMeta(metaSchemaVersionKey)
		if (installedVersion === runLogSchemaVersion) return

		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS runs (
				id TEXT PRIMARY KEY NOT NULL,
				surface TEXT NOT NULL,
				status TEXT NOT NULL,
				name TEXT,
				package_id TEXT,
				package_kody_id TEXT,
				source_id TEXT,
				published_commit TEXT,
				storage_id TEXT,
				job_id TEXT,
				workflow_id TEXT,
				invocation_id TEXT,
				session_id TEXT,
				idempotency_key TEXT,
				parent_run_id TEXT,
				started_at TEXT NOT NULL,
				finished_at TEXT,
				duration_ms INTEGER,
				error_name TEXT,
				error_message TEXT,
				metadata_json TEXT NOT NULL DEFAULT '{}',
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				error_triage TEXT,
				triage_note TEXT,
				triaged_at TEXT,
				triaged_by TEXT,
				started_by_user_id TEXT,
				started_by_username TEXT,
				started_by_client TEXT,
				started_by_label TEXT,
				started_by_profile_id TEXT,
				started_by_profile_chain TEXT,
				log_count INTEGER NOT NULL DEFAULT 0
			)
		`)
		if (installedVersion != null && installedVersion < 10) {
			this.migrateRunsErrorTriageForV10()
		}
		if (installedVersion != null && installedVersion < 15) {
			this.migrateRunsStartedByForV15()
		}
		if (installedVersion != null && installedVersion < 18) {
			this.migrateRunsStartedByProfileForV18()
		}
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC, id DESC)`,
		)
		// Replace pre-id composites so keyset list filters can use covering indexes.
		this.ctx.storage.sql.exec(`DROP INDEX IF EXISTS idx_runs_surface_started`)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_runs_surface_started_id ON runs(surface, started_at DESC, id DESC)`,
		)
		this.ctx.storage.sql.exec(`DROP INDEX IF EXISTS idx_runs_status_started`)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_runs_status_started_id ON runs(status, started_at DESC, id DESC)`,
		)
		this.ctx.storage.sql.exec(`DROP INDEX IF EXISTS idx_runs_job_started`)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_runs_job_started_id ON runs(job_id, started_at DESC, id DESC)`,
		)
		this.ctx.storage.sql.exec(`DROP INDEX IF EXISTS idx_runs_package_started`)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_runs_package_started_id ON runs(package_id, started_at DESC, id DESC)`,
		)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_runs_name_started_id ON runs(name, started_at DESC, id DESC)`,
		)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_runs_started_by_user_started_id ON runs(started_by_user_id, started_at DESC, id DESC)`,
		)
		// Non-unique: package invocations / workflows may reuse the same
		// idempotency key across history. Keyed execute claim/replay stays
		// race-free because claimRun select-then-insert runs in one DO RPC.
		// Drop any unique index from schema v3 so warm objects can migrate.
		this.ctx.storage.sql.exec(`DROP INDEX IF EXISTS idx_runs_idempotency_key`)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_runs_idempotency_key
			ON runs(idempotency_key) WHERE idempotency_key IS NOT NULL`,
		)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS run_logs (
				run_id TEXT NOT NULL,
				sequence INTEGER NOT NULL,
				level TEXT NOT NULL,
				message TEXT NOT NULL,
				fields_json TEXT,
				PRIMARY KEY (run_id, sequence)
			)
		`)
		// After run_logs exists: warm objects need the column + one-time backfill.
		if (installedVersion != null && installedVersion < 11) {
			this.migrateRunsLogCountForV11()
		}
		// Keyed package-invocation idempotency ledger (migrated from the D1
		// package_invocations table). No user_id column: the DO identity is the
		// user. The unique index is the exactly-once claim scope; unlike D1's
		// INSERT OR IGNORE it never races because DO execution is serialized.
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS package_invocation_ledger (
				id TEXT PRIMARY KEY NOT NULL,
				token_id TEXT NOT NULL,
				package_id TEXT NOT NULL,
				package_kody_id TEXT NOT NULL,
				export_name TEXT NOT NULL,
				idempotency_key TEXT NOT NULL,
				request_hash TEXT NOT NULL,
				source TEXT,
				topic TEXT,
				claim_owner TEXT,
				status TEXT NOT NULL,
				response_json TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`)
		if (installedVersion != null && installedVersion < 12) {
			this.migrateInvocationLedgerClaimOwnerForV12()
		}
		this.ctx.storage.sql.exec(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_invocation_ledger_key
			ON package_invocation_ledger(token_id, package_id, export_name, idempotency_key)`,
		)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_invocation_ledger_status_created
			ON package_invocation_ledger(status, created_at ASC)`,
		)
		// Dedicated unpruned workflow projections (binding_name scopes concurrent
		// occupancy per Cloudflare Workflow binding). Correctness state for
		// idempotency and concurrent_workflows — never derived from pruned runs.
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS workflow_projections (
				id TEXT PRIMARY KEY NOT NULL,
				binding_name TEXT NOT NULL,
				source_type TEXT NOT NULL CHECK (source_type IN ('package', 'inline')),
				package_id TEXT,
				kody_id TEXT,
				source_id TEXT,
				workflow_name TEXT NOT NULL,
				export_name TEXT,
				idempotency_key TEXT NOT NULL,
				run_at TEXT NOT NULL,
				plan_date TEXT,
				status TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				completed_at TEXT,
				last_error TEXT,
				enqueued_commit TEXT,
				source_revision TEXT
			)
		`)
		if (installedVersion != null && installedVersion < 14) {
			this.migrateWorkflowProjectionSourceRevisionForV14()
		}
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_workflow_projections_created
			ON workflow_projections(created_at DESC, id DESC)`,
		)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_workflow_projections_status
			ON workflow_projections(status)`,
		)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_workflow_projections_idempotency
			ON workflow_projections(idempotency_key, created_at ASC)`,
		)
		// Dedicated unpruned per-job last-run outcome + counters. Not runs.
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS job_run_observability (
				job_id TEXT PRIMARY KEY NOT NULL,
				last_run_at TEXT,
				last_run_status TEXT,
				last_run_error TEXT,
				last_duration_ms INTEGER,
				run_count INTEGER NOT NULL DEFAULT 0,
				success_count INTEGER NOT NULL DEFAULT 0,
				error_count INTEGER NOT NULL DEFAULT 0,
				updated_at TEXT NOT NULL
			)
		`)
		if (installedVersion != null && installedVersion < 9) {
			this.rebuildJobRunObservabilityForV9()
		}
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_workflow_projections_binding_idempotency
			ON workflow_projections(binding_name, idempotency_key, created_at ASC)`,
		)
		// Dedicated unpruned package activation counters + milestones.
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS package_run_successes (
				package_id TEXT PRIMARY KEY NOT NULL,
				success_count INTEGER NOT NULL CHECK (success_count >= 0),
				updated_at TEXT NOT NULL
			)
		`)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS activation_milestones (
				milestone TEXT PRIMARY KEY NOT NULL CHECK (
					milestone IN ('package_run_succeeded', 'package_activated')
				),
				reached_at TEXT NOT NULL,
				package_id TEXT
			)
		`)
		// Durable per-UTC-day Overview aggregates. Survives the 2,000-run cap so
		// busy workspaces keep a complete 7-day chart. Top-level non-export only;
		// no backfill (pre-deploy history cannot be recovered).
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS run_day_counts (
				day TEXT NOT NULL,
				surface TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
				count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
				PRIMARY KEY (day, surface, status)
			)
		`)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_run_day_counts_day
			ON run_day_counts(day)`,
		)
		if (installedVersion != null && installedVersion < 16) {
			this.migrateRetrieverRunsForV16()
		}
		// Warm objects only: record the migration UTC day as the coverage floor.
		// Fresh objects keep a null boundary (no partial-history note).
		if (installedVersion != null && installedVersion < 13) {
			if (this.getMeta(metaRunDayCountsSinceKey) == null) {
				this.setMeta(
					metaRunDayCountsSinceKey,
					utcDayToMetaInt(new Date().toISOString().slice(0, 10)),
				)
			}
		}
		initializeSkillReads(this.ctx.storage.sql)
		this.setMeta(metaSchemaVersionKey, runLogSchemaVersion)
	}

	private rebuildJobRunObservabilityForV9() {
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec(
				`CREATE TABLE job_run_observability_v9 (
					job_id TEXT PRIMARY KEY NOT NULL,
					last_run_at TEXT,
					last_run_status TEXT,
					last_run_error TEXT,
					last_duration_ms INTEGER,
					run_count INTEGER NOT NULL DEFAULT 0,
					success_count INTEGER NOT NULL DEFAULT 0,
					error_count INTEGER NOT NULL DEFAULT 0,
					updated_at TEXT NOT NULL
				)`,
			)
			this.ctx.storage.sql.exec(
				`INSERT INTO job_run_observability_v9 (
					job_id, last_run_at, last_run_status, last_run_error,
					last_duration_ms, run_count, success_count, error_count, updated_at
				)
				SELECT
					job_id, last_run_at, last_run_status, last_run_error,
					last_duration_ms, run_count, success_count, error_count, updated_at
				FROM job_run_observability`,
			)
			this.ctx.storage.sql.exec(`DROP TABLE job_run_observability`)
			this.ctx.storage.sql.exec(
				`ALTER TABLE job_run_observability_v9 RENAME TO job_run_observability`,
			)
		})
	}

	/**
	 * Soft error-triage columns for Activity noise control. Warm objects may
	 * already have these columns when CREATE TABLE IF NOT EXISTS ran against
	 * the current DDL before the version gate called this helper — ignore
	 * duplicate-column errors so re-entry stays idempotent.
	 */
	private migrateRunsErrorTriageForV10() {
		for (const column of [
			'error_triage',
			'triage_note',
			'triaged_at',
			'triaged_by',
		] as const) {
			try {
				this.ctx.storage.sql.exec(`ALTER TABLE runs ADD COLUMN ${column} TEXT`)
			} catch {
				// Column already present on a partially migrated object.
			}
		}
	}

	/**
	 * Who started the run (person + client). No historical backfill — legacy
	 * rows keep NULL and Activity shows unknown.
	 */
	/**
	 * The profile (ADR 0092) a run acted as, and its chain frozen at start
	 * (ids, root first), so attribution survives a later purge.
	 */
	private migrateRunsStartedByProfileForV18() {
		for (const column of [
			'started_by_profile_id',
			'started_by_profile_chain',
		] as const) {
			try {
				this.ctx.storage.sql.exec(`ALTER TABLE runs ADD COLUMN ${column} TEXT`)
			} catch {
				// Column already present on a partially migrated object.
			}
		}
	}

	private migrateRunsStartedByForV15() {
		for (const column of [
			'started_by_user_id',
			'started_by_username',
			'started_by_client',
			'started_by_label',
		] as const) {
			try {
				this.ctx.storage.sql.exec(`ALTER TABLE runs ADD COLUMN ${column} TEXT`)
			} catch {
				// Column already present on a partially migrated object.
			}
		}
	}

	/**
	 * Denormalized `runs.log_count` so list/get/export stop paying a correlated
	 * `COUNT(*)` over `run_logs` per row (production rows-read hotspot).
	 * One-time backfill may scan `run_logs`; afterward reads use the column.
	 */
	private migrateRunsLogCountForV11() {
		try {
			this.ctx.storage.sql.exec(
				`ALTER TABLE runs ADD COLUMN log_count INTEGER NOT NULL DEFAULT 0`,
			)
		} catch {
			// Column already present on a partially migrated object.
		}
		this.ctx.storage.sql.exec(
			`UPDATE runs
			SET log_count = (
				SELECT COUNT(*) FROM run_logs l WHERE l.run_id = runs.id
			)`,
		)
	}

	/**
	 * Claim-owner column so queue retries of the same delivery can take over a
	 * fresh `in_progress` claim without waiting the full stale window (which is
	 * longer than the webhook ack retry budget).
	 */
	private migrateInvocationLedgerClaimOwnerForV12() {
		try {
			this.ctx.storage.sql.exec(
				`ALTER TABLE package_invocation_ledger ADD COLUMN claim_owner TEXT`,
			)
		} catch {
			// Column already present on a partially migrated object.
		}
	}

	/**
	 * Package workflow source provenance: the published commit resolved when
	 * the workflow was queued and the revision policy it was created with.
	 * Rows queued before this column stay NULL (they were never pinned).
	 */
	private migrateWorkflowProjectionSourceRevisionForV14() {
		for (const column of ['enqueued_commit', 'source_revision']) {
			try {
				this.ctx.storage.sql.exec(
					`ALTER TABLE workflow_projections ADD COLUMN ${column} TEXT`,
				)
			} catch {
				// Column already present on a partially migrated object.
			}
		}
	}

	private migrateRetrieverRunsForV16() {
		this.transactionSyncWithMetaCache(() => {
			const runCount = this.getMeta(metaRunCountKey)
			this.ctx.storage.sql.exec(`
				DELETE FROM run_logs
				WHERE run_id IN (SELECT id FROM runs WHERE surface = 'retriever')
			`)
			this.ctx.storage.sql.exec(`DELETE FROM runs WHERE surface = 'retriever'`)
			this.ctx.storage.sql.exec(
				`DELETE FROM run_day_counts WHERE surface = 'retriever'`,
			)
			if (runCount != null) {
				const countRow = this.ctx.storage.sql
					.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM runs`)
					.one()
				this.setMeta(metaRunCountKey, Number(countRow.n ?? 0) || 0)
			}
		})
	}

	private getMeta(key: string): number | null {
		const row = this.ctx.storage.sql
			.exec<{ value: number }>(
				`SELECT value FROM run_log_meta WHERE key = ? LIMIT 1`,
				key,
			)
			.toArray()[0]
		return row == null ? null : Number(row.value) || 0
	}

	private setMeta(key: string, value: number) {
		this.ctx.storage.sql.exec(
			`INSERT INTO run_log_meta (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			key,
			value,
		)
		if (key === metaRunCountKey) this.runCountCache = value
		if (key === metaFinishesSinceRetentionKey) {
			this.finishesSinceRetentionCache = value
		}
	}

	/** Atomic increment — no prior SELECT, so instrumentation stays cheap. */
	private adjustMeta(key: string, delta: number) {
		if (delta === 0) return
		this.ctx.storage.sql.exec(
			`INSERT INTO run_log_meta (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`,
			key,
			delta,
		)
	}

	private recordSqlBilling(
		op: RunLogSqlBillingOp,
		cursor: Pick<
			SqlStorageCursor<Record<string, SqlStorageValue>>,
			'rowsRead' | 'rowsWritten'
		>,
	) {
		const rowsRead = Number(cursor.rowsRead) || 0
		const rowsWritten = Number(cursor.rowsWritten) || 0
		const prev = this.sqlBillingByOp.get(op) ?? {
			rowsRead: 0,
			rowsWritten: 0,
			calls: 0,
		}
		prev.rowsRead += rowsRead
		prev.rowsWritten += rowsWritten
		prev.calls += 1
		this.sqlBillingByOp.set(op, prev)
		const userId = this.ctx.id.name
		if (userId) {
			recordDurableObjectPlatformRowsRead({
				env: this.env,
				userId,
				doClass: 'RunLog',
				rowsRead,
			})
		}
		this.adjustMeta(sqlBillingMetaKey(op, 'rr'), rowsRead)
		this.adjustMeta(sqlBillingMetaKey(op, 'rw'), rowsWritten)
		this.adjustMeta(sqlBillingMetaKey(op, 'n'), 1)
	}

	/**
	 * Run a SQL statement and attribute its cursor rowsRead/rowsWritten to `op`
	 * after the cursor is consumed. Mutations that return no rows still expose
	 * billing counters on the cursor after exec.
	 */
	private execSqlTracked<T extends Record<string, SqlStorageValue>>(
		op: RunLogSqlBillingOp,
		query: string,
		...bindings: Array<SqlStorageValue>
	): {
		toArray: () => Array<T>
		one: () => T
		run: () => void
	} {
		const cursor = this.ctx.storage.sql.exec<T>(query, ...bindings)
		return {
			toArray: () => {
				const rows = cursor.toArray()
				this.recordSqlBilling(op, cursor)
				return rows
			},
			one: () => {
				const row = cursor.one()
				this.recordSqlBilling(op, cursor)
				return row
			},
			run: () => {
				// Drain so rowsWritten/rowsRead settle for write statements.
				cursor.toArray()
				this.recordSqlBilling(op, cursor)
			},
		}
	}

	/**
	 * `setMeta` updates counter memos eagerly so hot paths skip re-SELECTs.
	 * When those writes run inside `transactionSync`, a later failure rolls
	 * SQL back but would leave the memos ahead of storage — drop them before
	 * rethrowing so the next read reloads.
	 */
	private transactionSyncWithMetaCache<T>(fn: () => T): T {
		try {
			return this.ctx.storage.transactionSync(fn)
		} catch (error) {
			this.runCountCache = null
			this.finishesSinceRetentionCache = null
			throw error
		}
	}

	private ensureRunCountMeta() {
		const existing = this.getMeta(metaRunCountKey)
		if (existing != null) {
			this.runCountCache = existing
			return
		}
		const countRow = this.ctx.storage.sql
			.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM runs`)
			.one()
		const count = Number(countRow.n ?? 0) || 0
		this.setMeta(metaRunCountKey, count)
		this.setMeta(metaFinishesSinceRetentionKey, 0)
	}

	private getRunCount() {
		if (this.runCountCache == null) {
			this.runCountCache = this.getMeta(metaRunCountKey) ?? 0
		}
		return this.runCountCache
	}

	private adjustRunCount(delta: number) {
		if (delta === 0) return
		this.setMeta(metaRunCountKey, Math.max(0, this.getRunCount() + delta))
	}

	private getFinishesSinceRetention() {
		if (this.finishesSinceRetentionCache == null) {
			this.finishesSinceRetentionCache =
				this.getMeta(metaFinishesSinceRetentionKey) ?? 0
		}
		return this.finishesSinceRetentionCache
	}

	private setFinishesSinceRetention(value: number) {
		this.setMeta(metaFinishesSinceRetentionKey, value)
	}

	private invalidateReadMemos() {
		this.summarizeMemo = null
	}

	private resetRetentionEmptyBackoff() {
		this.setMeta(metaRetentionEmptyBackoffKey, 0)
	}

	private nextRetentionEmptyBackoffMs(): number {
		const previous = this.getMeta(metaRetentionEmptyBackoffKey) ?? 0
		const next =
			previous <= 0
				? runRecordRetentionEmptyBackoffMinMs
				: Math.min(previous * 2, runRecordRetentionEmptyBackoffMaxMs)
		this.setMeta(metaRetentionEmptyBackoffKey, next)
		return next
	}

	private summarizeCacheKey(since: string): string {
		const sinceMs = Date.parse(since)
		if (!Number.isFinite(sinceMs) || sinceMs <= 0) return 'all'
		return `since:${String(Math.floor(sinceMs / 60_000))}`
	}

	private runMatchesListFilters(
		run: RunRecord,
		input: Pick<ListRunsInput, 'status' | 'errorTriage'>,
	): boolean {
		if (input.status && run.status !== input.status) return false
		const errorTriage = input.errorTriage ?? null
		if (errorTriage === 'open') return run.errorTriage == null
		if (errorTriage === 'ignored') return run.errorTriage === 'ignored'
		if (errorTriage === 'resolved') return run.errorTriage === 'resolved'
		if (errorTriage === 'all' || errorTriage == null) return true
		const exhaustive: never = errorTriage
		throw new Error(`Unhandled error triage filter: ${String(exhaustive)}`)
	}

	private hasCapEvictableRun(): boolean {
		return (
			this.ctx.storage.sql
				.exec<{ ok: number }>(
					`SELECT 1 AS ok FROM runs WHERE status != 'running' LIMIT 1`,
				)
				.toArray()[0] != null
		)
	}

	private runExists(runId: string) {
		const row = this.ctx.storage.sql
			.exec<{ ok: number }>(
				`SELECT 1 AS ok FROM runs WHERE id = ? LIMIT 1`,
				runId,
			)
			.toArray()[0]
		return row != null
	}

	private findRunByIdempotencyKey(input: {
		idempotencyKey: string
		surface?: RunSurface | null
	}): RunRecord | null {
		// Prefer an in-flight row, then the newest terminal row, so execute
		// replay sees the attempt that still owns the key. Scope by surface
		// when provided so execute keys cannot collide with package/workflow
		// history that reused the same string.
		const clauses = ['r.idempotency_key = ?']
		const params: Array<SqlStorageValue> = [input.idempotencyKey]
		if (input.surface) {
			clauses.push('r.surface = ?')
			params.push(input.surface)
		}
		const row = this.execSqlTracked<Record<string, SqlStorageValue>>(
			'findRunByIdempotencyKey',
			`SELECT r.*
			FROM runs r
			WHERE ${clauses.join(' AND ')}
			ORDER BY (r.status = 'running') DESC, r.started_at DESC, r.id DESC
			LIMIT 1`,
			...params,
		).toArray()[0]
		if (!row) return null
		return mapRunRow(row, Number(row['log_count'] ?? 0) || 0)
	}

	/**
	 * Overview charts count top-level non-export runs only (same filter as the
	 * former dashboardBuckets scan). Child runs and package exports are omitted
	 * so totals are not double-counted.
	 */
	private countsTowardDashboard(run: {
		surface: string
		parentRunId?: string | null
	}): boolean {
		return run.surface !== 'export' && !run.parentRunId
	}

	private utcDayFromIso(iso: string): string {
		return iso.slice(0, 10)
	}

	private adjustRunDayCount(input: {
		day: string
		surface: string
		status: RunStatus
		delta: number
	}) {
		if (input.delta === 0) return
		if (input.delta > 0) {
			this.ctx.storage.sql.exec(
				`INSERT INTO run_day_counts (day, surface, status, count)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(day, surface, status) DO UPDATE SET
					count = count + excluded.count`,
				input.day,
				input.surface,
				input.status,
				input.delta,
			)
			return
		}
		const remove = -input.delta
		this.ctx.storage.sql.exec(
			`UPDATE run_day_counts
			SET count = count - ?
			WHERE day = ? AND surface = ? AND status = ? AND count >= ?`,
			remove,
			input.day,
			input.surface,
			input.status,
			remove,
		)
		this.ctx.storage.sql.exec(
			`DELETE FROM run_day_counts
			WHERE day = ? AND surface = ? AND status = ? AND count <= 0`,
			input.day,
			input.surface,
			input.status,
		)
	}

	/**
	 * Move durable day counts when a dashboard-eligible run starts, finishes,
	 * or is marked stale. Cap eviction must not call this: history stays in
	 * run_day_counts after the runs row is gone.
	 */
	private runDayCountsCoverageSince(): string | null {
		const meta = this.getMeta(metaRunDayCountsSinceKey)
		return meta == null ? null : metaIntToUtcDay(meta)
	}

	/** Clamp startedAt to the warm coverage floor when counting day aggregates. */
	private runDayCountDayFromStartedAt(startedAt: string): string {
		let day = this.utcDayFromIso(startedAt)
		const coverageSince = this.runDayCountsCoverageSince()
		if (coverageSince != null && day < coverageSince) day = coverageSince
		return day
	}

	private applyRunDayCountTransition(input: {
		previousStatus: RunStatus | null
		run: Pick<
			RunLogRowInput,
			'surface' | 'parentRunId' | 'startedAt' | 'status'
		>
	}) {
		if (!this.countsTowardDashboard(input.run)) return
		// Clamp pre-migration startedAt days up to the warm coverage floor so
		// MIN(day) cannot drift before the no-backfill boundary.
		const day = this.runDayCountDayFromStartedAt(input.run.startedAt)
		const surface = input.run.surface
		const next = input.run.status
		if (input.previousStatus == null) {
			this.adjustRunDayCount({ day, surface, status: next, delta: 1 })
			return
		}
		if (input.previousStatus === next) return
		this.adjustRunDayCount({
			day,
			surface,
			status: input.previousStatus,
			delta: -1,
		})
		this.adjustRunDayCount({ day, surface, status: next, delta: 1 })
	}

	private insertRunningRun(run: RunLogRowInput) {
		const existed = this.runExists(run.id)
		if (!existed) {
			this.upsertRun(run, 'ignore')
			// INSERT OR IGNORE: count only when the row is new.
			if (this.runExists(run.id)) {
				this.adjustRunCount(1)
				this.applyRunDayCountTransition({
					previousStatus: null,
					run,
				})
				// New row ⇒ future age/stale work exists; idle conclusion is stale.
				// Clear armed too: a new `running` row may need an earlier wake.
				this.retentionIdleConfirmed = false
				this.retentionAlarmArmed = false
				this.invalidateReadMemos()
				this.resetRetentionEmptyBackoff()
			}
		}
	}

	private upsertRun(run: RunLogRowInput, mode: 'ignore' | 'replace') {
		const metadataJson = clampMetadataJson(run.metadataJson || '{}')
		const startedBy = normalizeRunStartedBy(run.startedBy)
		// New rows start with open triage (NULL). On conflict, preserve soft
		// triage for error finishes; clear it when the terminal status is not
		// error so success/running rows never stay hidden behind stale triage.
		// started_by is set at begin; COALESCE keeps a begin stamp if finish
		// somehow omits it.
		const statement =
			mode === 'ignore'
				? `INSERT OR IGNORE INTO runs (
					id, surface, status, name, package_id, package_kody_id, source_id,
					published_commit, storage_id, job_id, workflow_id, invocation_id,
					session_id, idempotency_key, parent_run_id, started_at, finished_at,
					duration_ms, error_name, error_message, metadata_json, created_at,
					updated_at, error_triage, triage_note, triaged_at, triaged_by,
					started_by_user_id, started_by_username, started_by_client, started_by_label,
					started_by_profile_id, started_by_profile_chain
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)`
				: `INSERT INTO runs (
					id, surface, status, name, package_id, package_kody_id, source_id,
					published_commit, storage_id, job_id, workflow_id, invocation_id,
					session_id, idempotency_key, parent_run_id, started_at, finished_at,
					duration_ms, error_name, error_message, metadata_json, created_at,
					updated_at, error_triage, triage_note, triaged_at, triaged_by,
					started_by_user_id, started_by_username, started_by_client, started_by_label,
					started_by_profile_id, started_by_profile_chain
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					surface = excluded.surface,
					status = excluded.status,
					name = excluded.name,
					package_id = excluded.package_id,
					package_kody_id = excluded.package_kody_id,
					source_id = excluded.source_id,
					published_commit = excluded.published_commit,
					storage_id = excluded.storage_id,
					job_id = excluded.job_id,
					workflow_id = excluded.workflow_id,
					invocation_id = excluded.invocation_id,
					session_id = excluded.session_id,
					idempotency_key = excluded.idempotency_key,
					parent_run_id = excluded.parent_run_id,
					started_at = excluded.started_at,
					finished_at = excluded.finished_at,
					duration_ms = excluded.duration_ms,
					error_name = excluded.error_name,
					error_message = excluded.error_message,
					metadata_json = excluded.metadata_json,
					updated_at = excluded.updated_at,
					error_triage = CASE
						WHEN excluded.status = 'error' THEN runs.error_triage
						ELSE NULL
					END,
					triage_note = CASE
						WHEN excluded.status = 'error' THEN runs.triage_note
						ELSE NULL
					END,
					triaged_at = CASE
						WHEN excluded.status = 'error' THEN runs.triaged_at
						ELSE NULL
					END,
					triaged_by = CASE
						WHEN excluded.status = 'error' THEN runs.triaged_by
						ELSE NULL
					END,
					started_by_user_id = COALESCE(excluded.started_by_user_id, runs.started_by_user_id),
					started_by_username = COALESCE(excluded.started_by_username, runs.started_by_username),
					started_by_client = COALESCE(excluded.started_by_client, runs.started_by_client),
					started_by_label = COALESCE(excluded.started_by_label, runs.started_by_label),
					started_by_profile_id = COALESCE(excluded.started_by_profile_id, runs.started_by_profile_id),
					started_by_profile_chain = COALESCE(excluded.started_by_profile_chain, runs.started_by_profile_chain)`
		this.ctx.storage.sql.exec(
			statement,
			run.id,
			run.surface,
			run.status,
			run.name,
			run.packageId,
			run.kodyId,
			run.sourceId,
			run.publishedCommit,
			run.storageId,
			run.jobId,
			run.workflowId,
			run.invocationId,
			run.sessionId,
			run.idempotencyKey,
			run.parentRunId,
			run.startedAt,
			run.finishedAt,
			run.durationMs,
			run.errorName,
			run.errorMessage,
			metadataJson,
			run.createdAt,
			run.updatedAt,
			startedBy?.userId ?? null,
			startedBy?.username ?? null,
			startedBy?.client ?? null,
			startedBy?.label ?? null,
			startedBy?.profileId ?? null,
			startedBy?.profileChain?.length
				? JSON.stringify(startedBy.profileChain)
				: null,
		)
	}

	private clearSystemPlatformInterruptTriageBeforeErrorFinish(
		run: Pick<RunLogRowInput, 'id' | 'status'>,
	) {
		if (run.status !== 'error') return
		this.ctx.storage.sql.exec(
			`UPDATE runs
			SET error_triage = NULL,
				triage_note = NULL,
				triaged_at = NULL,
				triaged_by = NULL
			WHERE id = ?
				AND error_name = ?
				AND triaged_by = ?`,
			run.id,
			runRecordPlatformInterruptedErrorName,
			platformInterruptTriagedBy,
		)
	}

	private replaceLogs(runId: string, logs: Array<RunLogEntryInput>) {
		this.execSqlTracked(
			'finishRun',
			`DELETE FROM run_logs WHERE run_id = ?`,
			runId,
		).run()
		this.insertLogRows(runId, logs)
	}

	/**
	 * Insert log rows for a run that has none yet (claim-time phase line).
	 * Finish still replaces the set, so a completed attempt keeps sandbox logs.
	 */
	private insertInitialLogs(runId: string, logs: Array<RunLogEntryInput>) {
		if (logs.length === 0) return
		this.insertLogRows(runId, logs)
	}

	private insertLogRows(runId: string, logs: Array<RunLogEntryInput>) {
		const kept = logs.slice(-runRecordMaxLogEntriesPerRun)
		let insertRowsRead = 0
		let insertRowsWritten = 0
		for (const [index, log] of kept.entries()) {
			const message = truncateUtf8(String(log.message), runRecordMaxTextBytes)
			const fieldsJson =
				log.fieldsJson == null
					? null
					: clampMetadataJson(String(log.fieldsJson))
			const cursor = this.ctx.storage.sql.exec(
				`INSERT INTO run_logs (run_id, sequence, level, message, fields_json)
				VALUES (?, ?, ?, ?, ?)`,
				runId,
				index,
				log.level,
				message,
				fieldsJson,
			)
			cursor.toArray()
			insertRowsRead += Number(cursor.rowsRead) || 0
			insertRowsWritten += Number(cursor.rowsWritten) || 0
		}
		if (kept.length > 0) {
			this.recordSqlBilling('finishRun', {
				rowsRead: insertRowsRead,
				rowsWritten: insertRowsWritten,
			})
		}
		this.execSqlTracked(
			'finishRun',
			`UPDATE runs SET log_count = ? WHERE id = ?`,
			kept.length,
			runId,
		).run()
	}

	private deleteRunsByIds(ids: Array<string>) {
		// Cap/age eviction deletes runs rows only. Durable run_day_counts keep
		// Overview history for the retention window.
		for (const id of ids) {
			this.ctx.storage.sql.exec(`DELETE FROM run_logs WHERE run_id = ?`, id)
			this.ctx.storage.sql.exec(`DELETE FROM runs WHERE id = ?`, id)
		}
		this.adjustRunCount(-ids.length)
		if (ids.length > 0) this.invalidateReadMemos()
	}

	private isStaleRunning(input: {
		surface: string
		startedAt: string
		nowMs?: number
		idempotencyKey?: string | null
	}): boolean {
		const surface = isRunSurface(input.surface) ? input.surface : 'execute'
		const startedMs = Date.parse(input.startedAt)
		if (!Number.isFinite(startedMs)) return false
		const nowMs = input.nowMs ?? Date.now()
		const ttlMs =
			surface === 'job' && isScheduledJobIdempotencyKey(input.idempotencyKey)
				? runRecordStaleRunningTtlMsScheduledJob
				: runRecordStaleRunningTtlMsForSurface(surface)
		return nowMs - startedMs >= ttlMs
	}

	private markRunningInterrupted(input: {
		id: string
		surface: RunSurface
		idempotencyKey: string | null
		startedAt: string
		parentRunId?: string | null
		finishedAt?: string
	}) {
		const existing = this.ctx.storage.sql
			.exec<{
				status: string
				surface: string
				started_at: string
				parent_run_id: string | null
				job_id: string | null
			}>(
				`SELECT status, surface, started_at, parent_run_id, job_id
				FROM runs WHERE id = ? LIMIT 1`,
				input.id,
			)
			.toArray()[0]
		if (!existing || existing.status !== 'running') return

		const finishedAt = input.finishedAt ?? new Date().toISOString()
		const startedMs = Date.parse(input.startedAt)
		const finishedMs = Date.parse(finishedAt)
		const durationMs =
			Number.isFinite(startedMs) && Number.isFinite(finishedMs)
				? Math.max(0, finishedMs - startedMs)
				: null
		const errorTriage = runErrorTriageForPlatformInterrupt({
			surface: input.surface,
			idempotencyKey: input.idempotencyKey,
		})
		// Scheduled ticks must be able to claim the occurrence again after a
		// stranded `running` row is interrupted. Clearing the key keeps the
		// interrupted attempt as visible history without consuming the slot.
		const releaseScheduledJobKey = isScheduledJobIdempotencyKey(
			input.idempotencyKey,
		)
		this.ctx.storage.sql.exec(
			`UPDATE runs
			SET status = 'error',
				finished_at = ?,
				duration_ms = ?,
				error_name = ?,
				error_message = ?,
				error_triage = ?,
				triage_note = ?,
				triaged_at = ?,
				triaged_by = ?,
				updated_at = ?,
				idempotency_key = CASE WHEN ? THEN NULL ELSE idempotency_key END
			WHERE id = ? AND status = 'running'`,
			finishedAt,
			durationMs,
			runRecordPlatformInterruptedErrorName,
			runRecordPlatformInterruptedErrorMessage,
			errorTriage,
			errorTriage ? platformInterruptTriageNote : null,
			errorTriage ? finishedAt : null,
			errorTriage ? platformInterruptTriagedBy : null,
			finishedAt,
			releaseScheduledJobKey ? 1 : 0,
			input.id,
		)
		this.applyRunDayCountTransition({
			previousStatus: 'running',
			run: {
				surface: isRunSurface(existing.surface)
					? existing.surface
					: input.surface,
				parentRunId:
					existing.parent_run_id == null
						? null
						: String(existing.parent_run_id),
				startedAt: String(existing.started_at),
				status: 'error',
			},
		})
		const jobId = existing.job_id?.trim() || null
		if (releaseScheduledJobKey && jobId) {
			// Surface the missed/interrupted occurrence on jobGet / Activity
			// counters even when the next claim has not run yet.
			this.writeJobRunObservabilityOutcome({
				jobId,
				status: 'error',
				ranAt: finishedAt,
				error: runRecordPlatformInterruptedErrorMessage,
				durationMs,
			})
		}
		// Row became terminal: age-prune now applies, so any prior idle
		// conclusion is stale (covers reconcile + heal-on-read callers).
		this.retentionIdleConfirmed = false
		this.invalidateReadMemos()
	}

	/**
	 * Prefer marking stranded `running` rows terminal over deleting them: an
	 * interrupted attempt is useful history. `error` +
	 * `platform_interrupted` is used because the public status union has no
	 * dedicated unknown-outcome value; live "is it running?" state must not be
	 * read from these rows anyway. Idempotent queue/subscription deliveries stay
	 * auto-ignored; scheduled-job keys clear their idempotency so the tick can
	 * still run and the interrupt stays owner-visible.
	 *
	 * TTL is surface-aware: sandbox-backed surfaces (execute/export/…) heal in
	 * minutes; scheduled job ticks heal after the execution lease; workflow rows
	 * keep the day-scale TTL.
	 */
	private reconcileStaleRunning() {
		const nowMs = Date.now()
		const finishedAt = new Date(nowMs).toISOString()
		// Per-surface cutoffs keep long-lived job/workflow rows from filling the
		// batch and starving short-lived execute/export rows.
		const shortLivedCutoff = new Date(
			nowMs - runRecordStaleRunningTtlMsForSurface('execute'),
		).toISOString()
		const backgroundCutoff = new Date(
			nowMs - runRecordStaleRunningTtlMsForSurface('webhook'),
		).toISOString()
		// Apply each job-key class cutoff in SQL before LIMIT so mid-age
		// non-scheduled job rows cannot fill the page ahead of lease-stale
		// `scheduled-job:…` rows. {@link isStaleRunning} remains the source of
		// truth inside the loop.
		const scheduledJobCutoff = new Date(
			nowMs - runRecordStaleRunningTtlMsScheduledJob,
		).toISOString()
		const jobCutoff = new Date(
			nowMs - runRecordStaleRunningTtlMsForSurface('job'),
		).toISOString()
		const longLivedCutoff = new Date(
			nowMs - runRecordStaleRunningTtlMsForSurface('workflow'),
		).toISOString()
		const candidates = this.execSqlTracked<{
			id: string
			started_at: string
			surface: RunSurface
			idempotency_key: string | null
		}>(
			'reconcileStaleRunning',
			`SELECT id, started_at, surface, idempotency_key FROM runs
			WHERE status = 'running' AND (
				(surface IN ('execute', 'export', 'subscription', 'app_fetch', 'app_realtime')
					AND started_at < ?)
				OR (surface = 'webhook' AND started_at < ?)
				OR (
					surface = 'job' AND (
						(idempotency_key LIKE 'scheduled-job:%' AND started_at < ?)
						OR (
							(idempotency_key IS NULL OR idempotency_key NOT LIKE 'scheduled-job:%')
							AND started_at < ?
						)
					)
				)
				OR (surface = 'workflow' AND started_at < ?)
			)
			ORDER BY started_at ASC
			LIMIT ?`,
			shortLivedCutoff,
			backgroundCutoff,
			scheduledJobCutoff,
			jobCutoff,
			longLivedCutoff,
			maxStaleRunningReconcilesPerPass,
		).toArray()
		let reconciled = 0
		for (const row of candidates) {
			if (
				!this.isStaleRunning({
					surface: row.surface,
					startedAt: row.started_at,
					nowMs,
					idempotencyKey: row.idempotency_key,
				})
			) {
				continue
			}
			this.markRunningInterrupted({
				id: row.id,
				surface: row.surface,
				idempotencyKey: row.idempotency_key,
				startedAt: row.started_at,
				finishedAt,
			})
			reconciled += 1
		}
		return reconciled
	}

	/**
	 * Heal one still-`running` row when a reader observes it past its surface
	 * TTL. Keeps Activity / keyed-execute recovery honest even when the DO
	 * alarm has not fired yet (unvisited objects, sticky armed alarms).
	 */
	private healStaleRunningRecord(run: RunRecord): RunRecord {
		if (run.status !== 'running') return run
		if (
			!this.isStaleRunning({
				surface: run.surface,
				startedAt: run.startedAt,
				idempotencyKey: run.idempotencyKey,
			})
		) {
			return run
		}
		this.markRunningInterrupted({
			id: run.id,
			surface: run.surface,
			idempotencyKey: run.idempotencyKey,
			startedAt: run.startedAt,
		})
		const healed = this.execSqlTracked<Record<string, SqlStorageValue>>(
			'healStaleRunning',
			`SELECT r.*
			FROM runs r
			WHERE r.id = ?
			LIMIT 1`,
			run.id,
		).toArray()[0]
		if (!healed) return run
		return mapRunRow(healed, Number(healed['log_count'] ?? 0) || 0)
	}

	private deleteOldestMatching(
		status: RunStatus,
		triage: 'triaged' | 'open' | null,
		limit: number,
	) {
		if (limit <= 0) return [] as Array<string>
		const triageClause =
			triage === 'triaged'
				? 'AND error_triage IS NOT NULL'
				: triage === 'open'
					? 'AND error_triage IS NULL'
					: ''
		return this.ctx.storage.sql
			.exec<{ id: string }>(
				`SELECT id FROM runs
				WHERE status = ? ${triageClause}
				ORDER BY started_at ASC
				LIMIT ?`,
				status,
				limit,
			)
			.toArray()
			.map((row) => row.id)
	}

	/**
	 * Arming rule (keep this comment accurate — reviewers rely on it):
	 *
	 * - Schedule at most one alarm for the soonest retention due-time:
	 *   over-cap with evictable terminal rows → now; over-cap with only
	 *   in-flight rows → oldest running + stale TTL; oldest finished →
	 *   started_at + retention. Empty DOs stay disarmed.
	 * - `retentionAlarmArmed` skips getAlarm/setAlarm on hot finishes once
	 *   scheduled (over-cap still forces a near-term resync).
	 * - `retentionIdleConfirmed` skips re-evaluation only while no new row
	 *   has been written; every startRun/finishRun write clears it so the
	 *   next ensure re-arms for that row's future due-time.
	 * - alarm() self-terminates only when nothing remains to ever prune;
	 *   otherwise it reschedules for the next due-time (not hourly forever).
	 * - An empty pass that is still over-cap or due immediately backs off
	 *   from 15s (doubling to 15 minutes) instead of waking every 1s.
	 * - An unvisited DO never runs (platform constraint). Cold start observes
	 *   any existing alarm; the first write re-converges via ensure.
	 */
	private nextRetentionDueAtMs(): number | null {
		if (
			this.getRunCount() > runRecordMaxRunsPerUser &&
			this.hasCapEvictableRun()
		) {
			return Date.now()
		}

		let next: number | null = null
		const consider = (at: number) => {
			if (!Number.isFinite(at)) return
			if (next == null || at < next) next = at
		}

		const oldestFinished = this.ctx.storage.sql
			.exec<{ started_at: string }>(
				`SELECT started_at FROM runs
				WHERE status != 'running'
				ORDER BY started_at ASC
				LIMIT 1`,
			)
			.toArray()[0]
		if (oldestFinished) {
			consider(Date.parse(oldestFinished.started_at) + retentionMs)
		}

		const oldestDayCount = this.ctx.storage.sql
			.exec<{ day: string }>(`SELECT MIN(day) AS day FROM run_day_counts`)
			.toArray()[0]
		if (oldestDayCount?.day) {
			// Prune deletes day < (now - retention).day, so day D first becomes
			// eligible at the start of D+1 plus retention (not D midnight).
			consider(
				Date.parse(`${oldestDayCount.day}T00:00:00.000Z`) +
					24 * 60 * 60 * 1000 +
					retentionMs,
			)
		}

		const oldestTerminalLedgerRow = this.ctx.storage.sql
			.exec<{ created_at: string }>(
				`SELECT created_at FROM package_invocation_ledger
				WHERE status != 'in_progress'
				ORDER BY created_at ASC
				LIMIT 1`,
			)
			.toArray()[0]
		if (oldestTerminalLedgerRow) {
			consider(
				Date.parse(oldestTerminalLedgerRow.created_at) + ledgerRetentionMs,
			)
		}

		const terminalPlaceholders = workflowProjectionTerminalStatuses
			.map(() => '?')
			.join(', ')
		const oldestTerminalWorkflowProjection = this.ctx.storage.sql
			.exec<{ due_at: string }>(
				`SELECT COALESCE(completed_at, updated_at) AS due_at
				FROM workflow_projections
				WHERE status IN (${terminalPlaceholders})
				ORDER BY COALESCE(completed_at, updated_at) ASC
				LIMIT 1`,
				...workflowProjectionTerminalStatuses,
			)
			.toArray()[0]
		if (oldestTerminalWorkflowProjection) {
			consider(
				Date.parse(oldestTerminalWorkflowProjection.due_at) +
					workflowProjectionRetentionMs,
			)
		}

		const oldestStaleCreatingProjection = this.ctx.storage.sql
			.exec<{ updated_at: string }>(
				`SELECT updated_at FROM workflow_projections
				WHERE COALESCE(status, '') = ?
				ORDER BY updated_at ASC
				LIMIT 1`,
				creatingWorkflowProjectionStatus,
			)
			.toArray()[0]
		if (oldestStaleCreatingProjection) {
			consider(
				Date.parse(oldestStaleCreatingProjection.updated_at) +
					workflowProjectionCreatingTtlMs,
			)
		}

		// Soonest stale due-time can belong to a newer short-lived surface
		// (execute) even when an older long-lived workflow/job row exists.
		// Only the earliest row per surface can produce that due-time.
		const oldestRunningPerSurface = this.ctx.storage.sql
			.exec<{ surface: string; started_at: string }>(
				`SELECT surface, MIN(started_at) AS started_at FROM runs
				WHERE status = 'running'
				GROUP BY surface`,
			)
			.toArray()
		for (const row of oldestRunningPerSurface) {
			const surface = isRunSurface(row.surface) ? row.surface : 'execute'
			consider(
				Date.parse(row.started_at) +
					runRecordStaleRunningTtlMsForSurface(surface),
			)
		}

		// Scheduled ticks heal on the execution-lease TTL, not the job-surface
		// TTL. Arm the RunLog alarm at that deadline so a hung tick is
		// interrupted and re-claimable without waiting six hours.
		const oldestScheduledJobRunning = this.ctx.storage.sql
			.exec<{ started_at: string }>(
				`SELECT MIN(started_at) AS started_at FROM runs
				WHERE status = 'running'
					AND surface = 'job'
					AND idempotency_key LIKE 'scheduled-job:%'`,
			)
			.toArray()[0]
		if (oldestScheduledJobRunning?.started_at) {
			consider(
				Date.parse(oldestScheduledJobRunning.started_at) +
					runRecordStaleRunningTtlMsScheduledJob,
			)
		}

		return next
	}

	private enforceRetention(): { runDeletes: number } {
		// Reconcile first so stranded `running` rows become terminal `error`
		// before the count cap runs — that is how a cap full of in-flight rows
		// still converges once they pass the stale TTL.
		this.reconcileStaleRunning()

		const cutoff = new Date(Date.now() - retentionMs).toISOString()
		const expired = this.execSqlTracked<{ id: string }>(
			'enforceRetention',
			`SELECT id FROM runs
			WHERE started_at < ? AND status != 'running'
			ORDER BY started_at ASC
			LIMIT ?`,
			cutoff,
			maxAgeDeletesPerFinish,
		)
			.toArray()
			.map((row) => row.id)
		this.deleteRunsByIds(expired)

		const total = this.getRunCount()
		const excess = total - runRecordMaxRunsPerUser
		let excessIds: Array<string> = []
		if (excess > 0) {
			const deleteCount = Math.min(excess, maxExcessDeletesPerFinish)
			// In-flight rows are never cap-evicted (same as age prune). Handled
			// errors go first, then successes, with open errors retained last.
			// This makes soft triage relieve saturation without sacrificing
			// useful successful history. Stale `running` becomes evictable only
			// after reconcile demotes it to an open `error` above.
			// Genuinely in-flight rows can therefore push the stored count
			// briefly above runRecordMaxRunsPerUser until they finish or go
			// stale — that is intentional, not a broken cap.
			excessIds.push(
				...this.deleteOldestMatching('error', 'triaged', deleteCount),
			)
			if (excessIds.length < deleteCount) {
				excessIds.push(
					...this.deleteOldestMatching(
						'success',
						null,
						deleteCount - excessIds.length,
					),
				)
			}
			if (excessIds.length < deleteCount) {
				excessIds.push(
					...this.deleteOldestMatching(
						'error',
						'open',
						deleteCount - excessIds.length,
					),
				)
			}
			this.deleteRunsByIds(excessIds)
		}

		this.pruneInvocationLedgerForRetention()
		this.pruneWorkflowProjectionsForRetention()
		this.pruneRunDayCountsForRetention()
		this.setFinishesSinceRetention(0)
		return { runDeletes: expired.length + excessIds.length }
	}

	/**
	 * Age-prune durable Overview day counts after the same horizon as runs.
	 * Cap eviction never touches this table.
	 */
	private pruneRunDayCountsForRetention() {
		const cutoffDay = new Date(Date.now() - retentionMs)
			.toISOString()
			.slice(0, 10)
		this.ctx.storage.sql.exec(
			`DELETE FROM run_day_counts WHERE day < ?`,
			cutoffDay,
		)
	}

	/**
	 * DO-local replacement for the D1 `package_invocations` retention sweep:
	 * terminal ledger rows keep their replay responses for 90 days;
	 * `in_progress` rows are never pruned so duplicate requests cannot bypass
	 * the in-flight guard. Batched so one retention pass stays bounded.
	 */
	private pruneInvocationLedgerForRetention() {
		const cutoff = new Date(Date.now() - ledgerRetentionMs).toISOString()
		this.ctx.storage.sql.exec(
			`DELETE FROM package_invocation_ledger
			WHERE id IN (
				SELECT id FROM package_invocation_ledger
				WHERE status != 'in_progress' AND created_at < ?
				ORDER BY created_at ASC
				LIMIT ?
			)`,
			cutoff,
			maxLedgerAgeDeletesPerPass,
		)
	}

	/**
	 * Age-prune terminal workflow projections after 90 days and drop stale
	 * `creating` reservations past their short TTL. Active/running rows are
	 * never removed. Success counts, milestones, and job observability are
	 * intentionally absent from this lane.
	 */
	private pruneWorkflowProjectionsForRetention() {
		this.pruneStaleCreatingWorkflowProjections()
		const cutoff = new Date(
			Date.now() - workflowProjectionRetentionMs,
		).toISOString()
		const placeholders = workflowProjectionTerminalStatuses
			.map(() => '?')
			.join(', ')
		this.ctx.storage.sql.exec(
			`DELETE FROM workflow_projections
			WHERE id IN (
				SELECT id FROM workflow_projections
				WHERE status IN (${placeholders})
					AND COALESCE(completed_at, updated_at) < ?
				ORDER BY COALESCE(completed_at, updated_at) ASC
				LIMIT ?
			)`,
			...workflowProjectionTerminalStatuses,
			cutoff,
			maxWorkflowProjectionAgeDeletesPerPass,
		)
	}

	/** Drop `creating` rows whose `updated_at` is older than the creating TTL. */
	private pruneStaleCreatingWorkflowProjections() {
		const cutoff = new Date(
			Date.now() - workflowProjectionCreatingTtlMs,
		).toISOString()
		this.ctx.storage.sql.exec(
			`DELETE FROM workflow_projections
			WHERE id IN (
				SELECT id FROM workflow_projections
				WHERE COALESCE(status, '') = ?
					AND updated_at < ?
				ORDER BY updated_at ASC
				LIMIT ?
			)`,
			creatingWorkflowProjectionStatus,
			cutoff,
			maxStaleCreatingDeletesPerPass,
		)
	}

	private maybeEnforceRetention() {
		const finishes = this.getFinishesSinceRetention() + 1
		this.setFinishesSinceRetention(finishes)
		if (finishes >= runRecordRetentionEveryNFinishes) {
			this.enforceRetention()
		}
	}

	private async ensureRetentionAlarm() {
		const overCap = this.getRunCount() > runRecordMaxRunsPerUser
		if (this.retentionAlarmArmed && !overCap) return
		if (!this.retentionAlarmArmed && this.retentionIdleConfirmed && !overCap) {
			return
		}

		const next = this.nextRetentionDueAtMs()
		if (next == null) {
			this.retentionIdleConfirmed = true
			this.retentionAlarmArmed = false
			return
		}

		this.retentionIdleConfirmed = false
		const alarmAt = Math.max(next, Date.now() + 1_000)
		const existing = await this.ctx.storage.getAlarm()
		// Keep a soon-enough existing wake only when it is not later than the
		// new due-time. A leftover empty-pass backoff (15s–15min) must not
		// delay over-cap eviction after a finish creates an evictable row.
		if (
			existing != null &&
			existing <= alarmAt + 1_000 &&
			Math.abs(existing - alarmAt) < runRecordRetentionAlarmMs
		) {
			this.retentionAlarmArmed = true
			return
		}
		await this.ctx.storage.setAlarm(alarmAt)
		this.retentionAlarmArmed = true
	}

	async alarm(): Promise<void> {
		const { runDeletes } = this.enforceRetention()
		const overCap = this.getRunCount() > runRecordMaxRunsPerUser
		const next = this.nextRetentionDueAtMs()
		if (next == null) {
			this.retentionAlarmArmed = false
			this.retentionIdleConfirmed = true
			this.resetRetentionEmptyBackoff()
			return
		}
		const dueImmediately = next <= Date.now() + 1_000
		if (runDeletes === 0 && (overCap || dueImmediately)) {
			const backoffMs = this.nextRetentionEmptyBackoffMs()
			await this.ctx.storage.setAlarm(Date.now() + backoffMs)
			this.retentionAlarmArmed = true
			this.retentionIdleConfirmed = false
			return
		}
		this.resetRetentionEmptyBackoff()
		await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1_000))
		this.retentionAlarmArmed = true
		this.retentionIdleConfirmed = false
	}

	async getRecoveryBookmark(input: {
		timestampMs: number
	}): Promise<{ bookmark: string }> {
		return await getRecoveryBookmark(this.ctx, input, {
			environment: this.env,
		})
	}

	async restoreToBookmark(input: {
		bookmark: string
	}): Promise<{ undoBookmark: string }> {
		return await restoreToBookmark(this.ctx, input, {
			objectKind: 'run-log',
			environment: this.env,
		})
	}

	async startRun(input: { run: RunLogRowInput }): Promise<{ ok: true }> {
		this.insertRunningRun(input.run)
		await this.ensureRetentionAlarm()
		return { ok: true }
	}

	/**
	 * Atomically claim an idempotency key (or return the existing owner). DO
	 * RPCs are serialized, so select-then-insert here is race-free without a
	 * separate lock. Callers that need keyed execute replay use this instead of
	 * fire-and-forget `startRun`.
	 */
	async claimRun(input: { run: RunLogRowInput }): Promise<{
		claimed: boolean
		run: RunRecord
	}> {
		const key = input.run.idempotencyKey?.trim() || null
		if (key) {
			const existing = this.findRunByIdempotencyKey({
				idempotencyKey: key,
				surface: input.run.surface,
			})
			if (existing) {
				if (
					existing.status === 'running' &&
					isScheduledJobIdempotencyKey(existing.idempotencyKey) &&
					this.isStaleRunning({
						surface: existing.surface,
						startedAt: existing.startedAt,
						idempotencyKey: existing.idempotencyKey,
					})
				) {
					// Release the stranded scheduled-tick key (interrupt + clear
					// idempotency) so this claim can still execute the occurrence
					// instead of soft-retrying or replaying a terminal interrupt.
					this.markRunningInterrupted({
						id: existing.id,
						surface: existing.surface,
						idempotencyKey: existing.idempotencyKey,
						startedAt: existing.startedAt,
					})
				} else {
					// Heal stranded `running` owners before refusing the claim so a
					// keyed retry after an isolate death is not stuck on inProgress
					// forever. Terminal rows (including reconciled platform
					// interrupts) still own the key for replay.
					return {
						claimed: false,
						run: this.healStaleRunningRecord(existing),
					}
				}
			}
		}
		this.insertRunningRun(input.run)
		await this.ensureRetentionAlarm()
		const inserted =
			(await this.getRun({ runId: input.run.id }))?.run ??
			mapRunRow(
				{
					id: input.run.id,
					surface: input.run.surface,
					status: input.run.status,
					name: input.run.name,
					package_id: input.run.packageId,
					package_kody_id: input.run.kodyId,
					source_id: input.run.sourceId,
					published_commit: input.run.publishedCommit,
					storage_id: input.run.storageId,
					job_id: input.run.jobId,
					workflow_id: input.run.workflowId,
					invocation_id: input.run.invocationId,
					session_id: input.run.sessionId,
					idempotency_key: input.run.idempotencyKey,
					parent_run_id: input.run.parentRunId,
					started_at: input.run.startedAt,
					finished_at: input.run.finishedAt,
					duration_ms: input.run.durationMs,
					error_name: input.run.errorName,
					error_message: input.run.errorMessage,
					metadata_json: input.run.metadataJson,
				},
				0,
			)
		return { claimed: true, run: inserted }
	}

	/**
	 * Replace a still-`running` row's metadata so keyed retries see details
	 * learned after the claim (for example the execute routing outcome).
	 */
	async updateRunningMetadata(input: {
		runId: string
		metadataJson: string
	}): Promise<{ updated: boolean }> {
		const cursor = this.ctx.storage.sql.exec(
			`UPDATE runs SET metadata_json = ?, updated_at = ?
			WHERE id = ? AND status = 'running'`,
			clampMetadataJson(input.metadataJson || '{}'),
			new Date().toISOString(),
			input.runId,
		)
		const updated = cursor.rowsWritten > 0
		if (updated) this.invalidateReadMemos()
		return { updated }
	}

	async getRunByIdempotencyKey(input: {
		idempotencyKey: string
		surface?: RunSurface | null
	}): Promise<RunRecord | null> {
		const key = input.idempotencyKey.trim()
		if (!key) return null
		const existing = this.findRunByIdempotencyKey({
			idempotencyKey: key,
			surface: input.surface ?? null,
		})
		if (!existing) return null
		return this.healStaleRunningRecord(existing)
	}

	/**
	 * Delete a still-`running` row (and its logs) so a failed setup path can
	 * release an idempotency key without poisoning later retries.
	 */
	async deleteRunIfRunning(input: {
		runId: string
	}): Promise<{ deleted: boolean }> {
		const row = this.ctx.storage.sql
			.exec<{
				status: string
				surface: string
				started_at: string
				parent_run_id: string | null
			}>(
				`SELECT status, surface, started_at, parent_run_id
				FROM runs WHERE id = ? LIMIT 1`,
				input.runId,
			)
			.toArray()[0]
		if (!row || row.status !== 'running') {
			return { deleted: false }
		}
		const surface = isRunSurface(row.surface) ? row.surface : 'execute'
		const parentRunId =
			row.parent_run_id == null ? null : String(row.parent_run_id)
		if (this.countsTowardDashboard({ surface, parentRunId })) {
			// Same clamp as applyRunDayCountTransition: abandon must decrement
			// the floor day when start was clamped up from a pre-migration day.
			this.adjustRunDayCount({
				day: this.runDayCountDayFromStartedAt(String(row.started_at)),
				surface,
				status: 'running',
				delta: -1,
			})
		}
		this.deleteRunsByIds([input.runId])
		this.retentionIdleConfirmed = false
		await this.ensureRetentionAlarm()
		return { deleted: true }
	}

	private getRunStatus(runId: string): RunStatus | null {
		const row = this.ctx.storage.sql
			.exec<{ status: string }>(
				`SELECT status FROM runs WHERE id = ? LIMIT 1`,
				runId,
			)
			.toArray()[0]
		if (!row) return null
		const status = String(row.status)
		if (status === 'running' || status === 'success' || status === 'error') {
			return status
		}
		return null
	}

	private hasActivationMilestone(milestone: ActivationMilestone): boolean {
		const row = this.ctx.storage.sql
			.exec<{ ok: number }>(
				`SELECT 1 AS ok FROM activation_milestones WHERE milestone = ? LIMIT 1`,
				milestone,
			)
			.toArray()[0]
		return row != null
	}

	/**
	 * Increment package success counts and write first-success / activated
	 * milestones. Transaction-neutral so callers can wrap it with run upsert +
	 * log replacement in one `transactionSync` (nested transactions are not
	 * supported).
	 *
	 * Legacy contract: once the global `package_activated` milestone exists,
	 * counters and milestones stop changing for every package (short-circuit
	 * before any write). This matches pre-cutover D1 activation semantics.
	 */
	private applySuccessfulPackageActivationIncrement(input: {
		packageId: string
		reachedAt: string
	}) {
		const packageId = input.packageId
		const updatedAt = input.reachedAt
		// Global activation latch: further package successes must not mutate
		// success_count rows or milestones after the user is already activated.
		if (this.hasActivationMilestone('package_activated')) return

		this.ctx.storage.sql.exec(
			`INSERT INTO package_run_successes (package_id, success_count, updated_at)
			VALUES (?, 1, ?)
			ON CONFLICT(package_id) DO UPDATE SET
				success_count = success_count + 1,
				updated_at = excluded.updated_at`,
			packageId,
			updatedAt,
		)
		this.ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO activation_milestones (milestone, reached_at, package_id)
			VALUES ('package_run_succeeded', ?, ?)`,
			updatedAt,
			packageId,
		)
		const countRow = this.ctx.storage.sql
			.exec<{ success_count: number }>(
				`SELECT success_count FROM package_run_successes
				WHERE package_id = ? LIMIT 1`,
				packageId,
			)
			.toArray()[0]
		const successCount = Number(countRow?.success_count ?? 0) || 0
		if (successCount < 2) return
		this.ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO activation_milestones (milestone, reached_at, package_id)
			VALUES ('package_activated', ?, ?)`,
			updatedAt,
			packageId,
		)
	}

	/**
	 * Increment package success counts / milestones for a genuine new terminal
	 * success. Throws on SQL failure so the finish transaction can roll back.
	 */
	private recordSuccessfulPackageActivation(input: {
		packageId: string | null
		surface: string
		reachedAt: string
	}) {
		const packageId = input.packageId?.trim() || null
		if (!packageId) return
		if (!countsTowardPackageActivation(input.surface)) return
		this.applySuccessfulPackageActivationIncrement({
			packageId,
			reachedAt: input.reachedAt,
		})
	}

	private maybeRecordActivationForTerminalRun(input: {
		previousStatus: RunStatus | null
		run: RunLogRowInput
	}) {
		if (input.run.status !== 'success') return
		// Replacement/replay of an already-terminal success must not re-count.
		if (input.previousStatus === 'success') return
		this.recordSuccessfulPackageActivation({
			packageId: input.run.packageId,
			surface: input.run.surface,
			reachedAt:
				input.run.finishedAt ?? input.run.updatedAt ?? new Date().toISOString(),
		})
	}

	/**
	 * Apply one terminal job outcome to `job_run_observability`. Shared by the
	 * public upsert RPC and the finish-path side effect.
	 */
	private writeJobRunObservabilityOutcome(
		input: JobRunObservabilityUpsertInput,
	): JobRunObservabilityRecord {
		const jobId = input.jobId.trim()
		const ranAt = input.ranAt
		const updatedAt = ranAt
		const durationMs =
			typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
				? Math.max(0, Math.trunc(input.durationMs))
				: null
		const error = input.status === 'error' ? input.error?.trim() || null : null
		const successDelta = input.status === 'success' ? 1 : 0
		const errorDelta = input.status === 'error' ? 1 : 0
		this.ctx.storage.sql.exec(
			`INSERT INTO job_run_observability (
				job_id, last_run_at, last_run_status, last_run_error, last_duration_ms,
				run_count, success_count, error_count, updated_at
			) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
			ON CONFLICT(job_id) DO UPDATE SET
				last_run_at = excluded.last_run_at,
				last_run_status = excluded.last_run_status,
				last_run_error = excluded.last_run_error,
				last_duration_ms = excluded.last_duration_ms,
				run_count = run_count + 1,
				success_count = success_count + excluded.success_count,
				error_count = error_count + excluded.error_count,
				updated_at = excluded.updated_at`,
			jobId,
			ranAt,
			input.status,
			error,
			durationMs,
			successDelta,
			errorDelta,
			updatedAt,
		)
		const row = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM job_run_observability WHERE job_id = ? LIMIT 1`,
				jobId,
			)
			.toArray()[0]
		if (!row) {
			throw new Error(
				`job_run_observability row missing after upsert: ${jobId}`,
			)
		}
		return mapJobRunObservabilityRow(row)
	}

	/**
	 * Upsert job last-run counters for a genuine new terminal finish with a
	 * `jobId`. Replay/replacement of an already-terminal run must not
	 * double-count. Throws on SQL failure so the finish transaction can roll
	 * back.
	 */
	private maybeRecordJobRunObservabilityForTerminalRun(input: {
		previousStatus: RunStatus | null
		run: RunLogRowInput
	}) {
		if (input.run.status !== 'success' && input.run.status !== 'error') {
			return
		}
		// Already-terminal → terminal replacement/replay: counters stay put.
		if (
			input.previousStatus === 'success' ||
			input.previousStatus === 'error'
		) {
			return
		}
		const jobId = input.run.jobId?.trim() || null
		if (!jobId) return
		const ranAt =
			input.run.finishedAt ?? input.run.updatedAt ?? new Date().toISOString()
		const error =
			input.run.status === 'error'
				? input.run.errorMessage?.trim() || input.run.errorName?.trim() || null
				: null
		this.writeJobRunObservabilityOutcome({
			jobId,
			status: input.run.status,
			ranAt,
			error,
			durationMs: input.run.durationMs,
		})
	}

	private recordTerminalRunSideEffects(input: {
		previousStatus: RunStatus | null
		run: RunLogRowInput
	}) {
		this.maybeRecordActivationForTerminalRun(input)
		this.maybeRecordJobRunObservabilityForTerminalRun(input)
		this.maybeAutoResolvePriorJobErrors(input)
	}

	/**
	 * A later successful attempt is strong evidence that earlier open failures
	 * of the same scheduled job are no longer active. Soft-resolve those rows
	 * without changing their execution status or error details. User-ignored
	 * and already-resolved rows are deliberately left untouched.
	 *
	 * Only job_id is used: other surfaces do not all have an equally strong,
	 * immutable identity, so name-based auto-triage would risk hiding unrelated
	 * failures. The per-user count cap bounds this single UPDATE to 2,000 rows.
	 */
	private maybeAutoResolvePriorJobErrors(input: {
		previousStatus: RunStatus | null
		run: RunLogRowInput
	}) {
		if (
			input.run.status !== 'success' ||
			input.previousStatus === 'success' ||
			input.run.surface !== 'job'
		) {
			return
		}
		const jobId = input.run.jobId?.trim()
		if (!jobId) return
		const triagedAt =
			input.run.finishedAt ?? input.run.updatedAt ?? new Date().toISOString()
		this.ctx.storage.sql.exec(
			`UPDATE runs
			SET error_triage = 'resolved',
				triage_note = 'auto-resolved: later success of the same job',
				triaged_at = ?,
				triaged_by = 'system:auto-resolve',
				updated_at = ?
			WHERE status = 'error'
				AND error_triage IS NULL
				AND surface = 'job'
				AND job_id = ?
				AND id != ?`,
			triagedAt,
			triagedAt,
			jobId,
			input.run.id,
		)
	}

	async finishRun(input: {
		run: RunLogRowInput
		logs: Array<RunLogEntryInput>
	}): Promise<{ ok: true; wrote: boolean }> {
		const previousStatus = this.getRunStatus(input.run.id)
		const existed = previousStatus != null
		// Scheduled ticks release their idempotency key on platform interrupt so
		// the occurrence can be claimed again. A late finish from the stranded
		// attempt must not restore that key or flip the visible interrupt to
		// success (non-scheduled surfaces still allow late finishes).
		if (
			isScheduledJobIdempotencyKey(input.run.idempotencyKey) &&
			previousStatus != null &&
			previousStatus !== 'running'
		) {
			return { ok: true, wrote: false }
		}
		// One transaction for run upsert + logs + job observability + activation
		// so a mid-unit SQL failure cannot leave a terminal run that suppresses
		// missing derived side effects. Alarm / async retention stay outside.
		this.transactionSyncWithMetaCache(() => {
			this.clearSystemPlatformInterruptTriageBeforeErrorFinish(input.run)
			this.upsertRun(input.run, 'replace')
			this.replaceLogs(input.run.id, input.logs)
			if (!existed) {
				this.adjustRunCount(1)
			}
			this.applyRunDayCountTransition({
				previousStatus,
				run: input.run,
			})
			this.recordTerminalRunSideEffects({
				previousStatus,
				run: input.run,
			})
		})
		// Any write invalidates idle. Keep `retentionAlarmArmed` so repeated
		// finishes inside an already-scheduled window stay off alarm storage;
		// terminal rows only push age deadlines later.
		this.retentionIdleConfirmed = false
		this.invalidateReadMemos()
		this.resetRetentionEmptyBackoff()
		this.maybeEnforceRetention()
		await this.ensureRetentionAlarm()
		return { ok: true, wrote: true }
	}

	private findInvocationLedgerRow(
		key: PackageInvocationLedgerKey,
	): PackageInvocationLedgerRecord | null {
		const row = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM package_invocation_ledger
				WHERE token_id = ?
					AND package_id = ?
					AND export_name = ?
					AND idempotency_key = ?
				LIMIT 1`,
				key.tokenId,
				key.packageId,
				key.exportName,
				key.idempotencyKey,
			)
			.toArray()[0]
		return row ? mapInvocationLedgerRow(row) : null
	}

	private getInvocationLedgerRowById(
		id: string,
	): PackageInvocationLedgerRecord | null {
		const row = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM package_invocation_ledger WHERE id = ? LIMIT 1`,
				id,
			)
			.toArray()[0]
		return row ? mapInvocationLedgerRow(row) : null
	}

	/**
	 * Claim a keyed package invocation and begin its run record in one on-path
	 * DO call. DO execution is serialized, so lookup-then-insert here is
	 * atomic — strictly better claim semantics than the racy D1
	 * `INSERT OR IGNORE` this replaces. A matching `in_progress` row is
	 * reclaimed in place when it is stale (`updated_at <= staleBefore`) or
	 * when the caller presents the same non-null `claimOwner` (same delivery
	 * lineage taking over a dead attempt). Everything else the key already
	 * owns is returned for replay / mismatch / in-progress resolution.
	 */
	async claimPackageInvocation(input: {
		invocation: PackageInvocationClaimInput
		/** ISO cutoff: matching `in_progress` rows at or before it are reclaimable. */
		staleBefore: string
		/**
		 * ISO cutoff for same-`claimOwner` reclaim of a fresh `in_progress` row.
		 * Owner equality alone is not enough — the claim must also be at least
		 * this old so a failed terminal persist is not immediately re-executed.
		 */
		sameOwnerStaleBefore?: string
		/** Eager `running` run row for this attempt; `null` when the caller owns the run record (workflow-sourced invokes). */
		run: RunLogRowInput | null
		/**
		 * Phase lines written with the running row. They survive an isolate
		 * kill that never reaches finish; finish replaces them with the
		 * attempt's terminal logs.
		 */
		initialLogs?: Array<RunLogEntryInput>
	}): Promise<PackageInvocationClaimResult> {
		const now = new Date().toISOString()
		const claimOwner = normalizeClaimOwner(input.invocation.claimOwner)
		const existing = this.findInvocationLedgerRow(input.invocation)
		if (existing) {
			const sameOwnerReclaim =
				claimOwner != null &&
				existing.claimOwner != null &&
				existing.claimOwner === claimOwner &&
				input.sameOwnerStaleBefore != null &&
				existing.updatedAt <= input.sameOwnerStaleBefore
			// A non-null `response_json` on an `in_progress` row means execute
			// already produced a durable outcome that is waiting on terminal
			// ledger promotion — never reclaim/re-run that work.
			const reclaimable =
				existing.status === 'in_progress' &&
				existing.responseJson == null &&
				existing.requestHash === input.invocation.requestHash &&
				(existing.updatedAt <= input.staleBefore || sameOwnerReclaim)
			if (!reclaimable) {
				return { outcome: 'existing', record: existing }
			}
			this.ctx.storage.sql.exec(
				`UPDATE package_invocation_ledger
				SET updated_at = ?, claim_owner = ?
				WHERE id = ?`,
				now,
				claimOwner,
				existing.id,
			)
			if (input.run) {
				this.insertRunningRun({ ...input.run, invocationId: existing.id })
				this.insertInitialLogs(input.run.id, input.initialLogs ?? [])
				await this.ensureRetentionAlarm()
			}
			return {
				outcome: 'claimed',
				invocationId: existing.id,
				claimUpdatedAt: now,
				reclaimed: true,
			}
		}
		this.ctx.storage.sql.exec(
			`INSERT INTO package_invocation_ledger (
				id, token_id, package_id, package_kody_id, export_name,
				idempotency_key, request_hash, source, topic, claim_owner, status,
				response_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', NULL, ?, ?)`,
			input.invocation.id,
			input.invocation.tokenId,
			input.invocation.packageId,
			input.invocation.packageKodyId,
			input.invocation.exportName,
			input.invocation.idempotencyKey,
			input.invocation.requestHash,
			input.invocation.source,
			input.invocation.topic,
			claimOwner,
			now,
			now,
		)
		if (input.run) {
			this.insertRunningRun({
				...input.run,
				invocationId: input.invocation.id,
			})
			this.insertInitialLogs(input.run.id, input.initialLogs ?? [])
			await this.ensureRetentionAlarm()
		}
		return {
			outcome: 'claimed',
			invocationId: input.invocation.id,
			claimUpdatedAt: now,
			reclaimed: false,
		}
	}

	async getPackageInvocation(
		input: PackageInvocationLedgerKey,
	): Promise<PackageInvocationLedgerRecord | null> {
		return this.findInvocationLedgerRow(input)
	}

	/**
	 * Store the terminal response and finish the attempt's run record in one
	 * on-path DO call. The ledger update is fenced on `claimUpdatedAt` so a
	 * competing stale reclaim cannot be overwritten; the run row is this
	 * attempt's alone, so it is finished even when the fence fails (the
	 * attempt still happened and must not stay `running` forever).
	 */
	async finishPackageInvocation(input: {
		invocationId: string
		claimUpdatedAt: string
		status: 'completed' | 'failed'
		responseJson: string | null
		run: RunLogRowInput | null
		logs: Array<RunLogEntryInput>
	}): Promise<{
		ledgerUpdated: boolean
		/** Current row when the fence failed, so the caller can resolve it. */
		record: PackageInvocationLedgerRecord | null
	}> {
		const now = new Date().toISOString()
		// Fence + run/log/derived side effects share one transaction so a SQL
		// failure cannot leave a terminal run without its ledger/side effects.
		// Alarm scheduling stays outside.
		let ledgerUpdated = false
		let current: PackageInvocationLedgerRecord | null = null
		this.transactionSyncWithMetaCache(() => {
			current = this.getInvocationLedgerRowById(input.invocationId)
			ledgerUpdated =
				current != null &&
				current.status === 'in_progress' &&
				current.updatedAt === input.claimUpdatedAt
			if (ledgerUpdated) {
				this.ctx.storage.sql.exec(
					`UPDATE package_invocation_ledger
					SET status = ?, response_json = ?, updated_at = ?
					WHERE id = ?`,
					input.status,
					input.responseJson,
					now,
					input.invocationId,
				)
			}
			if (input.run) {
				const previousStatus = this.getRunStatus(input.run.id)
				const existed = previousStatus != null
				this.clearSystemPlatformInterruptTriageBeforeErrorFinish(input.run)
				this.upsertRun(input.run, 'replace')
				this.replaceLogs(input.run.id, input.logs)
				if (!existed) {
					this.adjustRunCount(1)
				}
				this.applyRunDayCountTransition({
					previousStatus,
					run: input.run,
				})
				// Activation + job observability follow the run transition, not
				// the ledger fence: the attempt still happened and must count
				// once even when a competing reclaim owns the ledger row.
				this.recordTerminalRunSideEffects({
					previousStatus,
					run: input.run,
				})
			}
		})
		// A terminal ledger row creates future age-prune work even when no run
		// row was written, so a stale idle conclusion must be cleared.
		this.retentionIdleConfirmed = false
		if (input.run) {
			this.invalidateReadMemos()
			this.resetRetentionEmptyBackoff()
		}
		this.maybeEnforceRetention()
		await this.ensureRetentionAlarm()
		if (ledgerUpdated) {
			return { ledgerUpdated: true, record: null }
		}
		return { ledgerUpdated: false, record: current }
	}

	/**
	 * Persist a successful execute outcome onto an `in_progress` claim without
	 * promoting the ledger to `completed` yet. Used when the atomic terminal
	 * finish fails: the staged `response_json` is an execution fence so
	 * same-owner (and stale) reclaim cannot re-run side effects, while retries
	 * can promote the row to `completed` from the staged payload.
	 */
	async stagePackageInvocationResult(input: {
		invocationId: string
		claimUpdatedAt: string
		responseJson: string | null
		run: RunLogRowInput | null
		logs: Array<RunLogEntryInput>
	}): Promise<{
		staged: boolean
		claimUpdatedAt: string | null
		record: PackageInvocationLedgerRecord | null
	}> {
		const now = new Date().toISOString()
		const current = this.getInvocationLedgerRowById(input.invocationId)
		if (
			!current ||
			current.status !== 'in_progress' ||
			current.updatedAt !== input.claimUpdatedAt
		) {
			return {
				staged: false,
				claimUpdatedAt: null,
				record: current,
			}
		}
		this.transactionSyncWithMetaCache(() => {
			this.ctx.storage.sql.exec(
				`UPDATE package_invocation_ledger
				SET response_json = ?, updated_at = ?
				WHERE id = ?`,
				input.responseJson,
				now,
				input.invocationId,
			)
			if (input.run) {
				const previousStatus = this.getRunStatus(input.run.id)
				const existed = previousStatus != null
				this.clearSystemPlatformInterruptTriageBeforeErrorFinish(input.run)
				this.upsertRun(input.run, 'replace')
				this.replaceLogs(input.run.id, input.logs)
				if (!existed) {
					this.adjustRunCount(1)
				}
				this.applyRunDayCountTransition({
					previousStatus,
					run: input.run,
				})
				this.recordTerminalRunSideEffects({
					previousStatus,
					run: input.run,
				})
			}
		})
		if (input.run) {
			this.retentionIdleConfirmed = false
			this.invalidateReadMemos()
			this.resetRetentionEmptyBackoff()
			this.maybeEnforceRetention()
			await this.ensureRetentionAlarm()
		} else {
			this.retentionIdleConfirmed = false
		}
		return {
			staged: true,
			claimUpdatedAt: now,
			record: null,
		}
	}

	/**
	 * Bump `updated_at` on a live `in_progress` claim (fenced on
	 * `claimUpdatedAt`). Used after a successful execute whose terminal
	 * persist failed when staging the result is also unavailable, so
	 * same-owner reclaim grace restarts from now instead of from the
	 * original claim time.
	 */
	async touchPackageInvocation(input: {
		invocationId: string
		claimUpdatedAt: string
	}): Promise<{
		touched: boolean
		claimUpdatedAt: string | null
		record: PackageInvocationLedgerRecord | null
	}> {
		const now = new Date().toISOString()
		const current = this.getInvocationLedgerRowById(input.invocationId)
		if (
			!current ||
			current.status !== 'in_progress' ||
			current.updatedAt !== input.claimUpdatedAt
		) {
			return {
				touched: false,
				claimUpdatedAt: null,
				record: current,
			}
		}
		this.ctx.storage.sql.exec(
			`UPDATE package_invocation_ledger SET updated_at = ? WHERE id = ?`,
			now,
			input.invocationId,
		)
		return {
			touched: true,
			claimUpdatedAt: now,
			record: null,
		}
	}

	/**
	 * Release a claim whose execution never started so retries are not
	 * poisoned. Deletes the still-`in_progress` ledger row (fenced on
	 * `claimUpdatedAt`). The attempt's still-`running` run row is finished as
	 * an error with diagnostic logs (not deleted) so Activity keeps evidence
	 * of pre-execution failures.
	 */
	async releasePackageInvocation(input: {
		invocationId: string
		claimUpdatedAt: string
		runId: string | null
		run: RunLogRowInput | null
		logs: Array<RunLogEntryInput>
	}): Promise<{
		released: boolean
		/** Current row when the fence failed, so the caller can resolve it. */
		record: PackageInvocationLedgerRecord | null
		/** True when this RPC finished the attempt's run as an error. */
		runFinished: boolean
	}> {
		// Same explicit read-then-write fence as finishPackageInvocation: DO
		// execution is serialized, so this is atomic within the RPC.
		const current = this.getInvocationLedgerRowById(input.invocationId)
		const released =
			current != null &&
			current.status === 'in_progress' &&
			current.updatedAt === input.claimUpdatedAt
		if (released) {
			this.ctx.storage.sql.exec(
				`DELETE FROM package_invocation_ledger WHERE id = ?`,
				input.invocationId,
			)
		}
		// Finish this attempt's run even when the ledger fence failed — the
		// attempt still happened and must not stay `running` or vanish.
		let runFinished = false
		const releasedRun = input.run
		if (releasedRun) {
			const previousStatus = this.getRunStatus(releasedRun.id)
			if (previousStatus === 'running' || previousStatus == null) {
				const existed = previousStatus != null
				this.transactionSyncWithMetaCache(() => {
					this.clearSystemPlatformInterruptTriageBeforeErrorFinish(releasedRun)
					this.upsertRun(releasedRun, 'replace')
					this.replaceLogs(releasedRun.id, input.logs)
					if (!existed) {
						this.adjustRunCount(1)
					}
					this.applyRunDayCountTransition({
						previousStatus,
						run: releasedRun,
					})
					this.recordTerminalRunSideEffects({
						previousStatus,
						run: releasedRun,
					})
				})
				runFinished = true
				this.retentionIdleConfirmed = false
				this.invalidateReadMemos()
				this.resetRetentionEmptyBackoff()
				this.maybeEnforceRetention()
				await this.ensureRetentionAlarm()
			}
		} else if (input.runId) {
			// Callers without a built terminal row still must not leave a
			// running attempt (legacy / fence-only release).
			await this.deleteRunIfRunning({ runId: input.runId })
		}
		if (released) {
			return { released: true, record: null, runFinished }
		}
		return { released: false, record: current, runFinished }
	}

	/**
	 * Authoritative workflow projection write: monotonic by `updated_at`, plus
	 * terminal-stickiness (terminal statuses are not overwritten by stale
	 * active/running updates).
	 */
	private writeWorkflowProjectionRow(input: WorkflowProjectionUpsertInput) {
		const now = new Date().toISOString()
		const createdAt = input.createdAt?.trim() || now
		const updatedAt = input.updatedAt?.trim() || now
		const terminalPlaceholders = workflowProjectionTerminalStatuses
			.map(() => '?')
			.join(', ')
		this.ctx.storage.sql.exec(
			`INSERT INTO workflow_projections (
				id, binding_name, source_type, package_id, kody_id, source_id,
				workflow_name, export_name, idempotency_key, run_at, plan_date,
				status, created_at, updated_at, completed_at, last_error,
				enqueued_commit, source_revision
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				status = excluded.status,
				updated_at = excluded.updated_at,
				completed_at = COALESCE(excluded.completed_at, workflow_projections.completed_at),
				last_error = COALESCE(excluded.last_error, workflow_projections.last_error)
			WHERE excluded.updated_at >= workflow_projections.updated_at
				AND (
					COALESCE(workflow_projections.status, '') NOT IN (${terminalPlaceholders})
					OR COALESCE(excluded.status, '') IN (${terminalPlaceholders})
				)`,
			input.id,
			input.bindingName,
			input.sourceType,
			input.packageId ?? null,
			input.kodyId ?? null,
			input.sourceId ?? null,
			input.workflowName,
			input.exportName ?? null,
			input.idempotencyKey,
			input.runAt,
			input.planDate ?? null,
			input.status ?? null,
			createdAt,
			updatedAt,
			input.completedAt ?? null,
			input.lastError ?? null,
			input.enqueuedCommit ?? null,
			input.sourceRevision ?? null,
			...workflowProjectionTerminalStatuses,
			...workflowProjectionTerminalStatuses,
		)
	}

	async upsertWorkflowProjection(
		input: WorkflowProjectionUpsertInput,
	): Promise<{ ok: true }> {
		this.writeWorkflowProjectionRow(input)
		// Terminal projections create future age-prune work.
		this.retentionIdleConfirmed = false
		await this.ensureRetentionAlarm()
		return { ok: true }
	}

	/**
	 * Detach a dead terminal projection from its idempotency key so a later
	 * create with the same key can mint a new run. Active and `complete` rows
	 * must keep their keys for dedupe/replay; this only rewrites keys that are
	 * not already released.
	 */
	async releaseWorkflowProjectionIdempotencyKey(input: {
		id: string
	}): Promise<{ released: boolean; previousKey: string | null }> {
		const id = input.id.trim()
		if (!id) {
			return { released: false, previousKey: null }
		}
		const existing = await this.getWorkflowProjection({ id })
		if (!existing) {
			return { released: false, previousKey: null }
		}
		const previousKey = existing.idempotencyKey
		if (previousKey.startsWith('released:')) {
			return { released: false, previousKey }
		}
		const releasedKey = releasedWorkflowProjectionIdempotencyKey(id)
		const now = new Date().toISOString()
		this.ctx.storage.sql.exec(
			`UPDATE workflow_projections
			SET idempotency_key = ?, updated_at = ?
			WHERE id = ?`,
			releasedKey,
			now,
			id,
		)
		this.retentionIdleConfirmed = false
		await this.ensureRetentionAlarm()
		return { released: true, previousKey }
	}

	async getWorkflowProjection(input: {
		id: string
	}): Promise<WorkflowProjectionRecord | null> {
		const row = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM workflow_projections WHERE id = ? LIMIT 1`,
				input.id,
			)
			.toArray()[0]
		return row ? mapWorkflowProjectionRow(row) : null
	}

	async findWorkflowProjectionByIdempotencyKey(input: {
		idempotencyKey: string
		bindingName?: string | null
	}): Promise<WorkflowProjectionRecord | null> {
		const trimmedKey = input.idempotencyKey.trim()
		if (!trimmedKey) return null
		const bindingName = input.bindingName?.trim() || null
		const row = bindingName
			? this.ctx.storage.sql
					.exec<Record<string, SqlStorageValue>>(
						`SELECT *
						FROM workflow_projections
						WHERE idempotency_key = ?
							AND binding_name = ?
							AND COALESCE(status, '') != ?
						ORDER BY created_at ASC
						LIMIT 1`,
						trimmedKey,
						bindingName,
						creatingWorkflowProjectionStatus,
					)
					.toArray()[0]
			: this.ctx.storage.sql
					.exec<Record<string, SqlStorageValue>>(
						`SELECT *
						FROM workflow_projections
						WHERE idempotency_key = ?
							AND COALESCE(status, '') != ?
						ORDER BY created_at ASC
						LIMIT 1`,
						trimmedKey,
						creatingWorkflowProjectionStatus,
					)
					.toArray()[0]
		return row ? mapWorkflowProjectionRow(row) : null
	}

	/**
	 * Exact binding + idempotency lookup that includes `creating` rows. Prefer
	 * this over listing/scanning creating projections.
	 */
	async findWorkflowProjectionByBindingIdempotencyKey(input: {
		bindingName: string
		idempotencyKey: string
	}): Promise<WorkflowProjectionRecord | null> {
		const bindingName = input.bindingName.trim()
		const trimmedKey = input.idempotencyKey.trim()
		if (!bindingName || !trimmedKey) return null
		const row = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT *
				FROM workflow_projections
				WHERE binding_name = ?
					AND idempotency_key = ?
				ORDER BY created_at ASC
				LIMIT 1`,
				bindingName,
				trimmedKey,
			)
			.toArray()[0]
		return row ? mapWorkflowProjectionRow(row) : null
	}

	async listWorkflowProjections(input: WorkflowProjectionListInput): Promise<{
		projections: Array<WorkflowProjectionRecord>
		nextCursor: string | null
	}> {
		const limit = normalizePageSize(input.limit, runRecordDefaultPageSize)
		const clauses: Array<string> = ['1 = 1']
		const params: Array<SqlStorageValue> = []
		const id = input.id?.trim() || null
		if (id) {
			clauses.push('id = ?')
			params.push(id)
		}
		if (input.status) {
			clauses.push('status = ?')
			params.push(input.status)
		} else {
			const statuses = (input.statuses ?? [])
				.map((value) => value.trim())
				.filter(Boolean)
			if (statuses.length > 0) {
				clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`)
				params.push(...statuses)
			}
		}
		const bindingName = input.bindingName?.trim() || null
		if (bindingName) {
			clauses.push('binding_name = ?')
			params.push(bindingName)
		}
		const packageId = input.packageId?.trim() || null
		if (packageId) {
			clauses.push('package_id = ?')
			params.push(packageId)
		}
		const since = input.since?.trim() || null
		if (since) {
			clauses.push('created_at >= ?')
			params.push(since)
		}
		if (input.cursor) {
			const cursor = decodeCursor(input.cursor)
			if (cursor) {
				clauses.push('(created_at, id) < (?, ?)')
				params.push(cursor.startedAt, cursor.id)
			}
		}
		params.push(limit + 1)
		const rows = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM workflow_projections
				WHERE ${clauses.join(' AND ')}
				ORDER BY created_at DESC, id DESC
				LIMIT ?`,
				...params,
			)
			.toArray()
		const hasMore = rows.length > limit
		const pageRows = hasMore ? rows.slice(0, limit) : rows
		const projections = pageRows.map(mapWorkflowProjectionRow)
		const last = pageRows[pageRows.length - 1]
		const nextCursor =
			hasMore && last
				? encodeCursor({
						startedAt: String(last['created_at']),
						id: String(last['id']),
					})
				: null
		return { projections, nextCursor }
	}

	async countActiveWorkflowProjections(): Promise<{ count: number }> {
		const placeholders = workflowProjectionActiveStatuses
			.map(() => '?')
			.join(', ')
		const row = this.ctx.storage.sql
			.exec<{ count: number }>(
				`SELECT COUNT(*) AS count FROM workflow_projections
				WHERE status IN (${placeholders})`,
				...workflowProjectionActiveStatuses,
			)
			.one()
		return { count: Number(row.count ?? 0) || 0 }
	}

	/**
	 * Atomically prune stale creating rows, count entitlement-occupying
	 * projections (active + creating, excluding this id), and insert-only
	 * claim a `creating` reservation. Never overwrites queued/running/terminal
	 * state. Returns the count *before* this reservation for
	 * assertWithinEntitlement getCurrent.
	 */
	async reserveWorkflowProjectionSlot(
		input: WorkflowProjectionUpsertInput,
	): Promise<WorkflowProjectionReserveResult> {
		const now = new Date().toISOString()
		this.pruneStaleCreatingWorkflowProjections()

		const existing = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM workflow_projections WHERE id = ? LIMIT 1`,
				input.id,
			)
			.toArray()[0]
		const existingStatus =
			existing && typeof existing['status'] === 'string'
				? String(existing['status'])
				: null

		const reservationPlaceholders = workflowProjectionReservationStatuses
			.map(() => '?')
			.join(', ')
		const countRow = this.ctx.storage.sql
			.exec<{ count: number }>(
				`SELECT COUNT(*) AS count FROM workflow_projections
				WHERE status IN (${reservationPlaceholders})
					AND id != ?`,
				...workflowProjectionReservationStatuses,
				input.id,
			)
			.one()
		const countBeforeReservation = Number(countRow.count ?? 0) || 0

		// Insert-only / creating-refresh: never clobber queued/running/terminal.
		if (
			existing != null &&
			existingStatus != null &&
			existingStatus !== creatingWorkflowProjectionStatus
		) {
			return {
				countBeforeReservation,
				reserved: false,
				inserted: false,
				projection: mapWorkflowProjectionRow(existing),
			}
		}

		const createdAt =
			input.createdAt?.trim() ||
			(existing ? String(existing['created_at']) : now)
		const updatedAt = input.updatedAt?.trim() || now
		const inserted = existing == null
		this.ctx.storage.sql.exec(
			`INSERT INTO workflow_projections (
				id, binding_name, source_type, package_id, kody_id, source_id,
				workflow_name, export_name, idempotency_key, run_at, plan_date,
				status, created_at, updated_at, completed_at, last_error,
				enqueued_commit, source_revision
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				updated_at = excluded.updated_at
			WHERE COALESCE(workflow_projections.status, '') = ?`,
			input.id,
			input.bindingName,
			input.sourceType,
			input.packageId ?? null,
			input.kodyId ?? null,
			input.sourceId ?? null,
			input.workflowName,
			input.exportName ?? null,
			input.idempotencyKey,
			input.runAt,
			input.planDate ?? null,
			creatingWorkflowProjectionStatus,
			createdAt,
			updatedAt,
			input.enqueuedCommit ?? null,
			input.sourceRevision ?? null,
			creatingWorkflowProjectionStatus,
		)
		// Re-read: ON CONFLICT may no-op when status is not `creating` (e.g.
		// null), and for existing creating rows only `updated_at` changes —
		// so the persisted row is the source of truth, not `input`.
		const projection = await this.getWorkflowProjection({ id: input.id })
		if (!projection) {
			throw new Error(
				`Workflow projection "${input.id}" disappeared after reservation.`,
			)
		}
		this.retentionIdleConfirmed = false
		await this.ensureRetentionAlarm()
		return {
			countBeforeReservation,
			reserved: projection.status === creatingWorkflowProjectionStatus,
			inserted,
			projection,
		}
	}

	async deleteWorkflowProjectionIfCreating(input: {
		id: string
	}): Promise<{ deleted: boolean }> {
		const deleted = this.ctx.storage.sql.exec(
			`DELETE FROM workflow_projections
			WHERE id = ? AND COALESCE(status, '') = ?`,
			input.id,
			creatingWorkflowProjectionStatus,
		).rowsWritten
		return { deleted: deleted > 0 }
	}

	async upsertJobRunObservability(
		input: JobRunObservabilityUpsertInput,
	): Promise<JobRunObservabilityRecord> {
		return this.writeJobRunObservabilityOutcome(input)
	}

	/**
	 * Content-free admin-insights point-read. Workflow statuses, job outcome
	 * counts, and activation milestone timestamps/ids needed for aggregate
	 * reporting — never names, errors, logs, or user content.
	 */
	async getAdminInsightsSnapshot(): Promise<RunLogAdminInsightsSnapshot> {
		const workflowRows = this.ctx.storage.sql
			.exec<{ status: string; n: number }>(
				`SELECT COALESCE(NULLIF(TRIM(status), ''), 'unknown') AS status,
					COUNT(*) AS n
				FROM workflow_projections
				GROUP BY COALESCE(NULLIF(TRIM(status), ''), 'unknown')
				ORDER BY n DESC, status ASC`,
			)
			.toArray()
		const milestones = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM activation_milestones ORDER BY milestone ASC`,
			)
			.toArray()
			.map(mapActivationMilestoneRow)
		const jobRunCounts = this.ctx.storage.sql
			.exec<{ error: number; success: number }>(
				`SELECT
					COALESCE(SUM(success_count), 0) AS success,
					COALESCE(SUM(error_count), 0) AS error
				FROM job_run_observability`,
			)
			.one()
		return {
			workflowStatusCounts: workflowRows.map((row) => ({
				status: String(row.status),
				count: Number(row.n) || 0,
			})),
			activationMilestones: milestones.map((row) => ({
				milestone: row.milestone,
				reachedAt: row.reachedAt,
				packageId: row.packageId,
			})),
			jobRunCounts: {
				success: Number(jobRunCounts.success) || 0,
				error: Number(jobRunCounts.error) || 0,
			},
		}
	}

	/**
	 * Content-free failed-run counts per package in `[since, until)`:
	 * header-only placement refusals for every package, and all failed runs
	 * for `packageIds`. Classifies `error_message` here so no message leaves.
	 */
	async summarizePackageFailures(
		input: RunLogPackageFailureSummaryInput,
	): Promise<RunLogPackageFailureSummary> {
		type CountRow = {
			package_id: string | null
			n: number
			first_at: string | null
			last_at: string | null
		}
		const toCounts = (row: CountRow): RunLogFailureCounts => ({
			count: Number(row.n) || 0,
			firstAt: row.first_at,
			lastAt: row.last_at,
		})
		const refusalMatch = headerOnlyPlacementRefusalMarkers
			.map(() => 'instr(error_message, ?) > 0')
			.join(' OR ')
		const refusalRows = this.ctx.storage.sql
			.exec<CountRow>(
				`SELECT package_id, COUNT(*) AS n,
					MIN(started_at) AS first_at, MAX(started_at) AS last_at
				FROM runs
				WHERE status = 'error'
					AND started_at >= ? AND started_at < ?
					AND error_message IS NOT NULL
					AND (${refusalMatch})
				GROUP BY package_id`,
				input.since,
				input.until,
				...headerOnlyPlacementRefusalMarkers,
			)
			.toArray()
		const packageIds = [...new Set(input.packageIds)]
		const failedRows =
			packageIds.length === 0
				? []
				: this.ctx.storage.sql
						.exec<CountRow>(
							`SELECT package_id, COUNT(*) AS n,
								MIN(started_at) AS first_at, MAX(started_at) AS last_at
							FROM runs
							WHERE status = 'error'
								AND started_at >= ? AND started_at < ?
								AND package_id IN (${packageIds.map(() => '?').join(', ')})
							GROUP BY package_id`,
							input.since,
							input.until,
							...packageIds,
						)
						.toArray()
		const rows = new Map<string | null, RunLogPackageFailureSummaryRow>()
		const rowFor = (packageId: string | null) => {
			const existing = rows.get(packageId)
			if (existing) return existing
			const created: RunLogPackageFailureSummaryRow = {
				packageId,
				placementRefusals: { ...emptyRunLogFailureCounts },
				failedRuns:
					packageId != null && packageIds.includes(packageId)
						? { ...emptyRunLogFailureCounts }
						: null,
			}
			rows.set(packageId, created)
			return created
		}
		for (const row of refusalRows) {
			rowFor(row.package_id).placementRefusals = toCounts(row)
		}
		for (const row of failedRows) {
			rowFor(row.package_id).failedRuns = toCounts(row)
		}
		return { packages: [...rows.values()] }
	}

	/**
	 * RunLog-only SQLite billing counters (SqlStorageCursor.rowsRead /
	 * rowsWritten) for hot ops. Durable totals live in run_log_meta; the
	 * isolate map is a fast path for the current lifetime.
	 */
	async getSqlBillingStats(): Promise<RunLogSqlBillingStats> {
		const ops: Array<RunLogSqlBillingOpStats> = []
		let rowsReadTotal = 0
		let rowsWrittenTotal = 0
		for (const op of runLogSqlBillingOps) {
			const cached = this.sqlBillingByOp.get(op)
			const rowsRead =
				this.getMeta(sqlBillingMetaKey(op, 'rr')) ?? cached?.rowsRead ?? 0
			const rowsWritten =
				this.getMeta(sqlBillingMetaKey(op, 'rw')) ?? cached?.rowsWritten ?? 0
			const calls =
				this.getMeta(sqlBillingMetaKey(op, 'n')) ?? cached?.calls ?? 0
			if (rowsRead === 0 && rowsWritten === 0 && calls === 0) continue
			ops.push({ op, rowsRead, rowsWritten, calls })
			rowsReadTotal += rowsRead
			rowsWrittenTotal += rowsWritten
		}
		return {
			databaseSize: this.ctx.storage.sql.databaseSize,
			rowsReadTotal,
			rowsWrittenTotal,
			ops,
		}
	}

	/**
	 * Content-free schema + SQL-plan snapshot for cost diagnosis. Counts and
	 * planner text only — never run rows, logs, or other user-authored values.
	 * Uses raw `sql.exec` so these one-off scans do not increment billing ops.
	 * First RPC on a never-used account initializes the same empty schema as
	 * any other RunLog read.
	 */
	async inspectSqlBilling(): Promise<RunLogSqlBillingInspection> {
		const billing = await this.getSqlBillingStats()
		const runLogsIndexes = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(`PRAGMA index_list('run_logs')`)
			.toArray()
			.map(mapSqlIndexInfo)
		const runLogsColumns = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(`PRAGMA table_info('run_logs')`)
			.toArray()
			.map(mapSqlColumnInfo)
		const tableCounts = {
			runs: this.countTableRows('runs'),
			runLogs: this.countTableRows('run_logs'),
			packageInvocationLedger: this.countTableRows('package_invocation_ledger'),
			workflowProjections: this.countTableRows('workflow_projections'),
			runDayCounts: this.countTableRows('run_day_counts'),
		}
		const runCountMeta = this.getMeta(metaRunCountKey)
		const runCountActual = tableCounts.runs
		return {
			schemaVersion: this.getMeta(metaSchemaVersionKey),
			billing,
			runLogsIndexes,
			runLogsColumns,
			tableCounts,
			runCount: {
				meta: runCountMeta,
				actual: runCountActual,
				matches: runCountMeta != null && runCountMeta === runCountActual,
			},
			explainRunLogsDeleteByRunId: this.explainQueryPlan(
				`DELETE FROM run_logs WHERE run_id = ?`,
				sqlBillingExplainProbeRunId,
			),
			explainRunLogsSelectByRunId: this.explainQueryPlan(
				`SELECT * FROM run_logs WHERE run_id = ? ORDER BY sequence ASC`,
				sqlBillingExplainProbeRunId,
			),
		}
	}

	private countTableRows(
		table: keyof typeof sqlBillingCountableTables,
	): number {
		const name = sqlBillingCountableTables[table]
		const row = this.ctx.storage.sql
			.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`)
			.one()
		return Number(row.n ?? 0) || 0
	}

	private explainQueryPlan(
		query: string,
		...bindings: Array<SqlStorageValue>
	): Array<RunLogSqlExplainStep> {
		return this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`EXPLAIN QUERY PLAN ${query}`,
				...bindings,
			)
			.toArray()
			.map(mapSqlExplainStep)
	}

	private getJobRunObservabilitySync(
		jobId: string,
	): JobRunObservabilityRecord | null {
		const row = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM job_run_observability WHERE job_id = ? LIMIT 1`,
				jobId,
			)
			.toArray()[0]
		return row ? mapJobRunObservabilityRow(row) : null
	}

	async getJobRunObservability(input: {
		jobId: string
	}): Promise<JobRunObservabilityRecord | null> {
		return this.getJobRunObservabilitySync(input.jobId)
	}

	async getJobRunObservabilityBatch(input: {
		jobIds: Array<string>
	}): Promise<Array<JobRunObservabilityRecord>> {
		const ids = [
			...new Set(
				input.jobIds.map((id) => id.trim()).filter((id) => id.length > 0),
			),
		]
		if (ids.length === 0) return []
		const placeholders = ids.map(() => '?').join(', ')
		return this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM job_run_observability
				WHERE job_id IN (${placeholders})
				ORDER BY job_id ASC`,
				...ids,
			)
			.toArray()
			.map(mapJobRunObservabilityRow)
	}

	async listPackageRunSuccesses(): Promise<Array<PackageRunSuccessRecord>> {
		return this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM package_run_successes ORDER BY package_id ASC`,
			)
			.toArray()
			.map(mapPackageRunSuccessRow)
	}

	async listActivationMilestones(): Promise<Array<ActivationMilestoneRecord>> {
		return this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM activation_milestones ORDER BY milestone ASC`,
			)
			.toArray()
			.map(mapActivationMilestoneRow)
	}

	async listRuns(input: ListRunsInput): Promise<RunRecordPage> {
		const limit = normalizePageSize(input.limit, runRecordDefaultPageSize)
		const clauses: Array<string> = ['1 = 1']
		const params: Array<SqlStorageValue> = []
		if (input.surface) {
			clauses.push('r.surface = ?')
			params.push(input.surface)
		}
		if (input.status) {
			clauses.push('r.status = ?')
			params.push(input.status)
		}
		if (input.packageId) {
			clauses.push('r.package_id = ?')
			params.push(input.packageId)
		}
		if (input.jobId) {
			clauses.push('r.job_id = ?')
			params.push(input.jobId)
		}
		if (input.workflowId) {
			clauses.push('r.workflow_id = ?')
			params.push(input.workflowId)
		}
		if (input.name) {
			clauses.push('r.name = ?')
			params.push(input.name)
		}
		if (input.startedByUserId) {
			clauses.push('r.started_by_user_id = ?')
			params.push(input.startedByUserId)
		}
		if (input.executionContextId) {
			clauses.push("json_extract(r.metadata_json, '$.executionContext.id') = ?")
			params.push(input.executionContextId)
		}
		if (input.since) {
			clauses.push('r.started_at >= ?')
			params.push(input.since)
		}
		if (input.until) {
			clauses.push('r.started_at < ?')
			params.push(input.until)
		}
		const errorTriage = input.errorTriage ?? null
		if (errorTriage === 'open') {
			// Hide ignored/resolved noise; successes and running rows have NULL
			// triage and remain visible.
			clauses.push('r.error_triage IS NULL')
		} else if (errorTriage === 'ignored') {
			clauses.push(`r.error_triage = 'ignored'`)
		} else if (errorTriage === 'resolved') {
			clauses.push(`r.error_triage = 'resolved'`)
		} else if (errorTriage === 'all' || errorTriage == null) {
			// No triage filter.
		} else {
			const exhaustive: never = errorTriage
			throw new Error(`Unhandled error triage filter: ${String(exhaustive)}`)
		}
		if (input.cursor) {
			const cursor = decodeCursor(input.cursor)
			if (cursor) {
				clauses.push('(r.started_at, r.id) < (?, ?)')
				params.push(cursor.startedAt, cursor.id)
			}
		}
		params.push(limit + 1)
		const rows = this.execSqlTracked<Record<string, SqlStorageValue>>(
			'listRuns',
			`SELECT r.*
			FROM runs r
			WHERE ${clauses.join(' AND ')}
			ORDER BY r.started_at DESC, r.id DESC
			LIMIT ?`,
			...params,
		).toArray()
		const hasMore = rows.length > limit
		const pageRows = hasMore ? rows.slice(0, limit) : rows
		const runs = pageRows
			.map((row) =>
				this.healStaleRunningRecord(
					mapRunRow(row, Number(row['log_count'] ?? 0) || 0),
				),
			)
			.filter((run) => this.runMatchesListFilters(run, input))
		const last = pageRows[pageRows.length - 1]
		const nextCursor =
			hasMore && last
				? encodeCursor({
						startedAt: String(last['started_at']),
						id: String(last['id']),
					})
				: null
		return { runs, nextCursor }
	}

	async getRun(input: {
		runId: string
	}): Promise<{ run: RunRecord; logs: Array<RunRecordLog> } | null> {
		const row = this.execSqlTracked<Record<string, SqlStorageValue>>(
			'getRun',
			`SELECT r.*
			FROM runs r
			WHERE r.id = ?
			LIMIT 1`,
			input.runId,
		).toArray()[0]
		if (!row) return null
		const run = this.healStaleRunningRecord(
			mapRunRow(row, Number(row['log_count'] ?? 0) || 0),
		)
		const logs = this.execSqlTracked<Record<string, SqlStorageValue>>(
			'getRun',
			`SELECT * FROM run_logs WHERE run_id = ? ORDER BY sequence ASC`,
			input.runId,
		)
			.toArray()
			.map(mapLogRow)
		return {
			run,
			logs,
		}
	}

	async dashboardBuckets(input: { since: string; until: string }): Promise<{
		buckets: Array<WorkspaceRunBucket>
		countsSince: string | null
	}> {
		const sinceDay = input.since.slice(0, 10)
		const untilDay = input.until.slice(0, 10)
		// Warm migration floor only (null for fresh DOs). Not MIN(day): a legacy
		// running finish must not pull the displayed boundary before no-backfill.
		const countsSince = this.runDayCountsCoverageSince()
		const lowerDay =
			countsSince != null && countsSince > sinceDay ? countsSince : sinceDay
		const buckets = this.execSqlTracked<WorkspaceRunBucket>(
			'summarize',
			`SELECT day, surface, status, count
			FROM run_day_counts
			WHERE day >= ? AND day <= ?
			ORDER BY day, surface, status`,
			lowerDay,
			untilDay,
		)
			.toArray()
			.map((row) => ({
				day: String(row.day),
				surface: (isRunSurface(String(row.surface))
					? String(row.surface)
					: 'execute') as WorkspaceRunBucket['surface'],
				status: (row.status === 'success' ||
				row.status === 'error' ||
				row.status === 'running'
					? row.status
					: 'error') as WorkspaceRunBucket['status'],
				count: Number(row.count ?? 0) || 0,
			}))
		return { buckets, countsSince }
	}

	async summarize(input: { since: string }): Promise<RunRecordSummary> {
		const since = input.since
		const cacheKey = this.summarizeCacheKey(since)
		if (this.summarizeMemo?.cacheKey === cacheKey) {
			return { ...this.summarizeMemo.summary, since }
		}
		const bySurfaceRows = this.execSqlTracked<{
			surface: string
			total: number
			errors: number
			ignored: number
			resolved: number
			running: number
		}>(
			'summarize',
			`SELECT
				surface,
				COUNT(*) AS total,
				SUM(CASE
					WHEN status = 'error' AND error_triage IS NULL THEN 1
					ELSE 0
				END) AS errors,
				SUM(CASE WHEN error_triage = 'ignored' THEN 1 ELSE 0 END) AS ignored,
				SUM(CASE WHEN error_triage = 'resolved' THEN 1 ELSE 0 END) AS resolved,
				SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
			FROM runs
			WHERE started_at >= ?
			GROUP BY surface
			ORDER BY surface ASC`,
			since,
		).toArray()
		let total = 0
		let errors = 0
		let ignored = 0
		let resolved = 0
		let running = 0
		const bySurface = bySurfaceRows.map((row) => {
			const surfaceTotal = Number(row.total ?? 0) || 0
			const surfaceErrors = Number(row.errors ?? 0) || 0
			total += surfaceTotal
			errors += surfaceErrors
			ignored += Number(row.ignored ?? 0) || 0
			resolved += Number(row.resolved ?? 0) || 0
			running += Number(row.running ?? 0) || 0
			return {
				surface: (isRunSurface(row.surface)
					? row.surface
					: 'execute') as RunSurface,
				total: surfaceTotal,
				errors: surfaceErrors,
			}
		})
		const summary: RunRecordSummary = {
			since,
			total,
			errors,
			ignored,
			resolved,
			running,
			bySurface,
		}
		this.summarizeMemo = { cacheKey, summary }
		return summary
	}

	/**
	 * Soft-triage a retained error run. Does not delete or rewrite error
	 * details. Only `status = 'error'` rows accept ignored/resolved; reopen
	 * (`errorTriage: null`) clears triage on any retained row that has it.
	 * Returns a result object instead of throwing so RPC callers can map
	 * caller errors without uncaught DO promise rejections.
	 */
	async updateRunErrorTriage(
		input: UpdateRunErrorTriageInput,
	): Promise<UpdateRunErrorTriageResult> {
		const existing = this.execSqlTracked<Record<string, SqlStorageValue>>(
			'updateRunErrorTriage',
			`SELECT r.*
			FROM runs r
			WHERE r.id = ?
			LIMIT 1`,
			input.runId,
		).toArray()[0]
		if (!existing) return { ok: false, reason: 'not_found' }

		const current = mapRunRow(existing, Number(existing['log_count'] ?? 0) || 0)
		const nextTriage = input.errorTriage
		if (nextTriage != null && current.status !== 'error') {
			return {
				ok: false,
				reason: 'not_error',
				status: current.status,
				runId: input.runId,
			}
		}

		const now = new Date().toISOString()
		let triageNote: string | null
		let triagedAt: string | null
		let triagedBy: string | null
		if (nextTriage == null) {
			triageNote = null
			triagedAt = null
			triagedBy = null
		} else {
			if (input.preserveTriageNote) {
				triageNote = current.triageNote
			} else if (input.triageNote == null) {
				triageNote = null
			} else {
				const trimmed = input.triageNote.trim()
				triageNote =
					trimmed.length === 0
						? null
						: trimmed.slice(0, runErrorTriageMaxNoteLength)
			}
			triagedAt = now
			triagedBy = input.triagedBy.trim() || null
		}

		this.ctx.storage.sql.exec(
			`UPDATE runs
			SET error_triage = ?,
				triage_note = ?,
				triaged_at = ?,
				triaged_by = ?,
				updated_at = ?
			WHERE id = ?`,
			nextTriage,
			triageNote,
			triagedAt,
			triagedBy,
			now,
			input.runId,
		)
		this.invalidateReadMemos()

		const updated = this.execSqlTracked<Record<string, SqlStorageValue>>(
			'updateRunErrorTriage',
			`SELECT r.*
			FROM runs r
			WHERE r.id = ?
			LIMIT 1`,
			input.runId,
		).toArray()[0]
		if (!updated) return { ok: false, reason: 'not_found' }
		return {
			ok: true,
			run: mapRunRow(updated, Number(updated['log_count'] ?? 0) || 0),
		}
	}

	/**
	 * Bounded soft triage for explicit run ids or an exact-match filter. The
	 * caller validates that one selector is present; this layer still forces
	 * status=error so successes can never be triaged accidentally.
	 */
	async bulkUpdateRunErrorTriage(
		input: BulkUpdateRunErrorTriageInput,
	): Promise<BulkUpdateRunErrorTriageResult> {
		const limit = normalizePageSize(input.limit, runRecordMaxPageSize)
		const clauses = [`status = 'error'`]
		const params: Array<SqlStorageValue> = []
		// Reopening already-open rows is a no-op and must not inflate matched or
		// updated counts, regardless of selector type.
		if (input.errorTriage == null) {
			clauses.push('error_triage IS NOT NULL')
		}
		const runIds = (input.runIds ?? [])
			.map((id) => id.trim())
			.filter(Boolean)
			.slice(0, runRecordMaxPageSize)
		if (runIds.length > 0) {
			clauses.push(`id IN (${runIds.map(() => '?').join(', ')})`)
			params.push(...runIds)
		} else {
			const filter = input.filter
			if (!filter) {
				return { matchedRunIds: [], updatedCount: 0, hasMore: false }
			}
			if (filter.surface) {
				clauses.push('surface = ?')
				params.push(filter.surface)
			}
			if (filter.packageId) {
				clauses.push('package_id = ?')
				params.push(filter.packageId)
			}
			if (filter.jobId) {
				clauses.push('job_id = ?')
				params.push(filter.jobId)
			}
			if (filter.name) {
				clauses.push('name = ?')
				params.push(filter.name)
			}
			if (filter.errorName) {
				clauses.push('error_name = ?')
				params.push(filter.errorName)
			}
			if (filter.errorMessage) {
				clauses.push('error_message = ?')
				params.push(filter.errorMessage)
			}
			const filterTriage =
				filter.errorTriage ??
				(input.errorTriage == null ? null : ('open' as const))
			if (filterTriage === 'open') {
				clauses.push('error_triage IS NULL')
			} else if (filterTriage === 'ignored') {
				clauses.push(`error_triage = 'ignored'`)
			} else if (filterTriage === 'resolved') {
				clauses.push(`error_triage = 'resolved'`)
			} else if (filterTriage === 'all' || filterTriage == null) {
				// No triage filter.
			} else {
				const exhaustive: never = filterTriage
				throw new Error(
					`Unhandled bulk error triage filter: ${String(exhaustive)}`,
				)
			}
		}

		const rows = this.ctx.storage.sql
			.exec<{ id: string }>(
				`SELECT id FROM runs
				WHERE ${clauses.join(' AND ')}
				ORDER BY started_at DESC, id DESC
				LIMIT ${limit + 1}`,
				...params,
			)
			.toArray()
		const hasMore = rows.length > limit
		const matchedRunIds = rows.slice(0, limit).map((row) => row.id)
		if (input.dryRun || matchedRunIds.length === 0) {
			return { matchedRunIds, updatedCount: 0, hasMore }
		}

		const now = new Date().toISOString()
		this.ctx.storage.transactionSync(() => {
			if (input.errorTriage == null) {
				for (const runIdChunk of chunkArray(
					matchedRunIds,
					maxD1BoundParameters - 1,
				)) {
					const placeholders = runIdChunk.map(() => '?').join(', ')
					this.ctx.storage.sql.exec(
						`UPDATE runs
						SET error_triage = NULL,
							triage_note = NULL,
							triaged_at = NULL,
							triaged_by = NULL,
							updated_at = ?
						WHERE id IN (${placeholders}) AND status = 'error'`,
						now,
						...runIdChunk,
					)
				}
			} else {
				const triageNote =
					input.triageNote == null
						? null
						: input.triageNote.trim().slice(0, runErrorTriageMaxNoteLength) ||
							null
				for (const runIdChunk of chunkArray(
					matchedRunIds,
					maxD1BoundParameters - 6,
				)) {
					const placeholders = runIdChunk.map(() => '?').join(', ')
					this.ctx.storage.sql.exec(
						`UPDATE runs
						SET error_triage = ?,
							triage_note = CASE WHEN ? = 1 THEN triage_note ELSE ? END,
							triaged_at = ?,
							triaged_by = ?,
							updated_at = ?
						WHERE id IN (${placeholders}) AND status = 'error'`,
						input.errorTriage,
						input.preserveTriageNote ? 1 : 0,
						triageNote,
						now,
						input.triagedBy.trim() || null,
						now,
						...runIdChunk,
					)
				}
			}
		})
		this.invalidateReadMemos()
		return {
			matchedRunIds,
			updatedCount: matchedRunIds.length,
			hasMore,
		}
	}

	async listStorageIds(): Promise<Array<string>> {
		return this.ctx.storage.sql
			.exec<{ storage_id: string }>(
				`SELECT DISTINCT storage_id AS storage_id
				FROM runs
				WHERE storage_id IS NOT NULL
				ORDER BY storage_id ASC`,
			)
			.toArray()
			.map((row) => row.storage_id)
	}

	/**
	 * Paged export across dedicated DO state in fixed phases:
	 * 1. runs (raw run-id cursors — compatible with pre-ledger exports)
	 * 2. invocation-ledger (`invocation-ledger:`)
	 * 3. workflow-projections (`workflow-projections:`)
	 * 4. job-run-observability (`job-run-observability:`)
	 * 5. package-run-successes (`package-run-successes:`)
	 * 6. activation-milestones (`activation-milestones:`)
	 * 7. skill-reads (`skill-reads:`)
	 *
	 * Each phase fills the remainder of the page into the next so exports stay
	 * one-cursor. Old run-id and ledger cursors remain valid.
	 */
	async exportRuns(input: ExportRunsInput): Promise<ExportRunsResult> {
		const pageSize = normalizePageSize(input.pageSize, runRecordDefaultPageSize)
		const startAfterRaw = input.startAfter?.trim() || null
		const empty: ExportRunsResult = {
			runs: [],
			logs: [],
			packageInvocations: [],
			workflowProjections: [],
			jobRunObservability: [],
			packageRunSuccesses: [],
			activationMilestones: [],
			skillReads: [],
			nextStartAfter: null,
			truncated: false,
		}

		type ExportPhase =
			| 'runs'
			| 'invocation-ledger'
			| 'workflow-projections'
			| 'job-run-observability'
			| 'package-run-successes'
			| 'activation-milestones'
			| 'skill-reads'

		const phaseOrder: Array<ExportPhase> = [
			'runs',
			'invocation-ledger',
			'workflow-projections',
			'job-run-observability',
			'package-run-successes',
			'activation-milestones',
			'skill-reads',
		]

		const parsePhase = (
			cursor: string | null,
		): { phase: ExportPhase; startAfterId: string } => {
			if (!cursor) return { phase: 'runs', startAfterId: '' }
			if (cursor.startsWith(exportSkillReadsCursorPrefix))
				return {
					phase: 'skill-reads',
					startAfterId: cursor.slice(exportSkillReadsCursorPrefix.length),
				}
			if (cursor.startsWith(exportLedgerCursorPrefix)) {
				return {
					phase: 'invocation-ledger',
					startAfterId: cursor.slice(exportLedgerCursorPrefix.length),
				}
			}
			if (cursor.startsWith(exportWorkflowProjectionsCursorPrefix)) {
				return {
					phase: 'workflow-projections',
					startAfterId: cursor.slice(
						exportWorkflowProjectionsCursorPrefix.length,
					),
				}
			}
			if (cursor.startsWith(exportJobRunObservabilityCursorPrefix)) {
				return {
					phase: 'job-run-observability',
					startAfterId: cursor.slice(
						exportJobRunObservabilityCursorPrefix.length,
					),
				}
			}
			if (cursor.startsWith(exportPackageRunSuccessesCursorPrefix)) {
				return {
					phase: 'package-run-successes',
					startAfterId: cursor.slice(
						exportPackageRunSuccessesCursorPrefix.length,
					),
				}
			}
			if (cursor.startsWith(exportActivationMilestonesCursorPrefix)) {
				return {
					phase: 'activation-milestones',
					startAfterId: cursor.slice(
						exportActivationMilestonesCursorPrefix.length,
					),
				}
			}
			return { phase: 'runs', startAfterId: cursor }
		}

		const cursorPrefixForPhase = (phase: ExportPhase): string | null => {
			switch (phase) {
				case 'runs':
					return null
				case 'invocation-ledger':
					return exportLedgerCursorPrefix
				case 'workflow-projections':
					return exportWorkflowProjectionsCursorPrefix
				case 'job-run-observability':
					return exportJobRunObservabilityCursorPrefix
				case 'package-run-successes':
					return exportPackageRunSuccessesCursorPrefix
				case 'skill-reads':
					return exportSkillReadsCursorPrefix
				case 'activation-milestones':
					return exportActivationMilestonesCursorPrefix
				default: {
					const exhaustive: never = phase
					throw new Error(`Unhandled export phase: ${String(exhaustive)}`)
				}
			}
		}

		const result: ExportRunsResult = { ...empty }
		let { phase, startAfterId } = parsePhase(startAfterRaw)
		let remaining = pageSize
		let phaseIndex = phaseOrder.indexOf(phase)
		// Hard cap: each iteration either emits rows, advances phase, or
		// returns. Bound by phase count so a stuck cursor cannot spin.
		const maxIterations = phaseOrder.length + 1
		let iterations = 0

		while (phaseIndex < phaseOrder.length) {
			iterations += 1
			if (iterations > maxIterations) {
				throw new Error('exportRuns exceeded phase iteration budget')
			}
			// Never query a phase with a zero limit — that used to return
			// truncated:true with the same cursor and could infinite-loop
			// clients that retry while truncated.
			if (remaining <= 0) {
				const nextPhase = phaseOrder[phaseIndex]!
				const prefix = cursorPrefixForPhase(nextPhase)
				const handoff = prefix ? `${prefix}` : null
				if (handoff != null && handoff === startAfterRaw) {
					phaseIndex += 1
					startAfterId = ''
					continue
				}
				result.nextStartAfter = handoff
				result.truncated = handoff != null
				return result
			}

			const currentPhase = phaseOrder[phaseIndex]!
			const page = this.exportPhasePage({
				phase: currentPhase,
				startAfterId,
				limit: remaining,
			})
			switch (currentPhase) {
				case 'runs': {
					result.runs.push(...page.runs)
					result.logs.push(...page.logs)
					break
				}
				case 'invocation-ledger': {
					result.packageInvocations.push(...page.packageInvocations)
					break
				}
				case 'workflow-projections': {
					result.workflowProjections.push(...page.workflowProjections)
					break
				}
				case 'job-run-observability': {
					result.jobRunObservability.push(...page.jobRunObservability)
					break
				}
				case 'package-run-successes': {
					result.packageRunSuccesses.push(...page.packageRunSuccesses)
					break
				}
				case 'skill-reads': {
					result.skillReads.push(...page.skillReads)
					break
				}
				case 'activation-milestones': {
					result.activationMilestones.push(...page.activationMilestones)
					break
				}
				default: {
					const exhaustive: never = currentPhase
					throw new Error(`Unhandled export phase: ${String(exhaustive)}`)
				}
			}
			remaining -= page.taken

			if (page.truncated) {
				// Zero-row "truncation" cannot make progress; treat as exhausted.
				if (page.taken <= 0) {
					phaseIndex += 1
					startAfterId = ''
					continue
				}
				const prefix = cursorPrefixForPhase(currentPhase)
				const nextStartAfter = prefix ? `${prefix}${page.nextId}` : page.nextId
				// Refuse to emit the inbound cursor again (would spin clients).
				if (nextStartAfter === startAfterRaw) {
					phaseIndex += 1
					startAfterId = ''
					continue
				}
				result.nextStartAfter = nextStartAfter
				result.truncated = true
				return result
			}

			// Phase exhausted. If the page budget is spent, hand off to the
			// next phase prefix so the following call starts there (legacy
			// ledger handoff contract).
			phaseIndex += 1
			startAfterId = ''
			if (remaining <= 0 && phaseIndex < phaseOrder.length) {
				const nextPhase = phaseOrder[phaseIndex]!
				const prefix = cursorPrefixForPhase(nextPhase)
				const handoff = prefix ? `${prefix}` : null
				if (handoff != null && handoff === startAfterRaw) {
					continue
				}
				result.nextStartAfter = handoff
				result.truncated = handoff != null
				return result
			}
		}
		return result
	}

	private exportPhasePage(input: {
		phase:
			| 'runs'
			| 'invocation-ledger'
			| 'workflow-projections'
			| 'job-run-observability'
			| 'package-run-successes'
			| 'activation-milestones'
			| 'skill-reads'
		startAfterId: string
		limit: number
	}): {
		runs: Array<RunRecord>
		logs: Array<RunRecordLog>
		packageInvocations: Array<PackageInvocationLedgerRecord>
		workflowProjections: Array<WorkflowProjectionRecord>
		jobRunObservability: Array<JobRunObservabilityRecord>
		packageRunSuccesses: Array<PackageRunSuccessRecord>
		activationMilestones: Array<ActivationMilestoneRecord>
		skillReads: Array<SkillReadEvent>
		taken: number
		truncated: boolean
		nextId: string
	} {
		const empty = {
			runs: [] as Array<RunRecord>,
			logs: [] as Array<RunRecordLog>,
			packageInvocations: [] as Array<PackageInvocationLedgerRecord>,
			workflowProjections: [] as Array<WorkflowProjectionRecord>,
			jobRunObservability: [] as Array<JobRunObservabilityRecord>,
			packageRunSuccesses: [] as Array<PackageRunSuccessRecord>,
			activationMilestones: [] as Array<ActivationMilestoneRecord>,
			skillReads: [] as Array<SkillReadEvent>,
			taken: 0,
			truncated: false,
			nextId: input.startAfterId,
		}
		// Callers must not request a zero-limit page; treat as exhausted so
		// the export loop advances instead of re-emitting the same cursor.
		if (input.limit <= 0) {
			return empty
		}
		const limit = Math.trunc(input.limit)

		switch (input.phase) {
			case 'runs': {
				const rows = (
					input.startAfterId
						? this.execSqlTracked<Record<string, SqlStorageValue>>(
								'exportRuns',
								`SELECT r.*
								FROM runs r
								WHERE r.id > ?
								ORDER BY r.id ASC
								LIMIT ?`,
								input.startAfterId,
								limit + 1,
							)
						: this.execSqlTracked<Record<string, SqlStorageValue>>(
								'exportRuns',
								`SELECT r.*
								FROM runs r
								ORDER BY r.id ASC
								LIMIT ?`,
								limit + 1,
							)
				).toArray()
				const truncated = rows.length > limit
				const pageRows = truncated ? rows.slice(0, limit) : rows
				const runs = pageRows.map((row) =>
					mapRunRow(row, Number(row['log_count'] ?? 0) || 0),
				)
				const logs: Array<RunRecordLog> = []
				for (const run of runs) {
					const runLogs = this.execSqlTracked<Record<string, SqlStorageValue>>(
						'exportRuns',
						`SELECT * FROM run_logs WHERE run_id = ? ORDER BY sequence ASC`,
						run.id,
					)
						.toArray()
						.map(mapLogRow)
					logs.push(...runLogs)
				}
				const last = pageRows[pageRows.length - 1]
				return {
					...empty,
					runs,
					logs,
					taken: runs.length,
					truncated,
					nextId: last ? String(last['id']) : input.startAfterId,
				}
			}
			case 'invocation-ledger': {
				const rows = this.ctx.storage.sql
					.exec<Record<string, SqlStorageValue>>(
						`SELECT * FROM package_invocation_ledger
						WHERE id > ?
						ORDER BY id ASC
						LIMIT ?`,
						input.startAfterId,
						limit + 1,
					)
					.toArray()
				const truncated = rows.length > limit
				const pageRows = truncated ? rows.slice(0, limit) : rows
				const last = pageRows[pageRows.length - 1]
				return {
					...empty,
					packageInvocations: pageRows.map(mapInvocationLedgerRow),
					taken: pageRows.length,
					truncated,
					nextId: last ? String(last['id']) : input.startAfterId,
				}
			}
			case 'workflow-projections': {
				const rows = this.ctx.storage.sql
					.exec<Record<string, SqlStorageValue>>(
						`SELECT * FROM workflow_projections
						WHERE id > ?
						ORDER BY id ASC
						LIMIT ?`,
						input.startAfterId,
						limit + 1,
					)
					.toArray()
				const truncated = rows.length > limit
				const pageRows = truncated ? rows.slice(0, limit) : rows
				const last = pageRows[pageRows.length - 1]
				return {
					...empty,
					workflowProjections: pageRows.map(mapWorkflowProjectionRow),
					taken: pageRows.length,
					truncated,
					nextId: last ? String(last['id']) : input.startAfterId,
				}
			}
			case 'job-run-observability': {
				const rows = this.ctx.storage.sql
					.exec<Record<string, SqlStorageValue>>(
						`SELECT * FROM job_run_observability
						WHERE job_id > ?
						ORDER BY job_id ASC
						LIMIT ?`,
						input.startAfterId,
						limit + 1,
					)
					.toArray()
				const truncated = rows.length > limit
				const pageRows = truncated ? rows.slice(0, limit) : rows
				const last = pageRows[pageRows.length - 1]
				return {
					...empty,
					jobRunObservability: pageRows.map(mapJobRunObservabilityRow),
					taken: pageRows.length,
					truncated,
					nextId: last ? String(last['job_id']) : input.startAfterId,
				}
			}
			case 'package-run-successes': {
				const rows = this.ctx.storage.sql
					.exec<Record<string, SqlStorageValue>>(
						`SELECT * FROM package_run_successes
						WHERE package_id > ?
						ORDER BY package_id ASC
						LIMIT ?`,
						input.startAfterId,
						limit + 1,
					)
					.toArray()
				const truncated = rows.length > limit
				const pageRows = truncated ? rows.slice(0, limit) : rows
				const last = pageRows[pageRows.length - 1]
				return {
					...empty,
					packageRunSuccesses: pageRows.map(mapPackageRunSuccessRow),
					taken: pageRows.length,
					truncated,
					nextId: last ? String(last['package_id']) : input.startAfterId,
				}
			}
			case 'skill-reads': {
				const page = exportSkillReads(
					this.ctx.storage.sql,
					input.startAfterId,
					limit,
				)
				return {
					...empty,
					skillReads: page.events,
					taken: page.events.length,
					truncated: page.truncated,
					nextId: page.nextId,
				}
			}
			case 'activation-milestones': {
				const rows = this.ctx.storage.sql
					.exec<Record<string, SqlStorageValue>>(
						`SELECT * FROM activation_milestones
						WHERE milestone > ?
						ORDER BY milestone ASC
						LIMIT ?`,
						input.startAfterId,
						limit + 1,
					)
					.toArray()
				const truncated = rows.length > limit
				const pageRows = truncated ? rows.slice(0, limit) : rows
				const last = pageRows[pageRows.length - 1]
				return {
					...empty,
					activationMilestones: pageRows.map(mapActivationMilestoneRow),
					taken: pageRows.length,
					truncated,
					nextId: last ? String(last['milestone']) : input.startAfterId,
				}
			}
			default: {
				const exhaustive: never = input.phase
				throw new Error(`Unhandled export phase: ${String(exhaustive)}`)
			}
		}
	}

	async clearAll(): Promise<{ ok: true }> {
		await this.ctx.storage.deleteAlarm().catch(() => {
			// Best effort: deleteAll below still clears persisted alarm state.
		})
		await this.ctx.storage.deleteAll()
		this.retentionAlarmArmed = false
		this.retentionIdleConfirmed = true
		this.runCountCache = null
		this.finishesSinceRetentionCache = null
		this.summarizeMemo = null
		this.sqlBillingByOp.clear()
		this.initializeSchema()
		this.setMeta(metaRunCountKey, 0)
		this.setMeta(metaFinishesSinceRetentionKey, 0)
		return { ok: true }
	}
}

export const RunLog = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	RunLogBase,
)
export type RunLog = InstanceType<typeof RunLog>

export type RunLogRpc = DurableObjectPitrRpc & {
	recordSkillRead: (event: SkillReadEvent) => Promise<void>
	skillReadSummary: (input: {
		since: string
		packageIds: Array<string>
	}) => Promise<SkillReadSummary>
	startRun: (input: { run: RunLogRowInput }) => Promise<{ ok: true }>
	claimRun: (input: { run: RunLogRowInput }) => Promise<{
		claimed: boolean
		run: RunRecord
	}>
	finishRun: (input: {
		run: RunLogRowInput
		logs: Array<RunLogEntryInput>
	}) => Promise<{ ok: true; wrote: boolean }>
	listRuns: (input: ListRunsInput) => Promise<RunRecordPage>
	updateRunErrorTriage: (
		input: UpdateRunErrorTriageInput,
	) => Promise<UpdateRunErrorTriageResult>
	bulkUpdateRunErrorTriage: (
		input: BulkUpdateRunErrorTriageInput,
	) => Promise<BulkUpdateRunErrorTriageResult>
	getRun: (input: {
		runId: string
	}) => Promise<{ run: RunRecord; logs: Array<RunRecordLog> } | null>
	getRunByIdempotencyKey: (input: {
		idempotencyKey: string
		surface?: RunSurface | null
	}) => Promise<RunRecord | null>
	deleteRunIfRunning: (input: {
		runId: string
	}) => Promise<{ deleted: boolean }>
	updateRunningMetadata: (input: {
		runId: string
		metadataJson: string
	}) => Promise<{ updated: boolean }>
	claimPackageInvocation: (input: {
		invocation: PackageInvocationClaimInput
		staleBefore: string
		sameOwnerStaleBefore?: string
		run: RunLogRowInput | null
		initialLogs?: Array<RunLogEntryInput>
	}) => Promise<PackageInvocationClaimResult>
	getPackageInvocation: (
		input: PackageInvocationLedgerKey,
	) => Promise<PackageInvocationLedgerRecord | null>
	finishPackageInvocation: (input: {
		invocationId: string
		claimUpdatedAt: string
		status: 'completed' | 'failed'
		responseJson: string | null
		run: RunLogRowInput | null
		logs: Array<RunLogEntryInput>
	}) => Promise<{
		ledgerUpdated: boolean
		record: PackageInvocationLedgerRecord | null
	}>
	stagePackageInvocationResult: (input: {
		invocationId: string
		claimUpdatedAt: string
		responseJson: string | null
		run: RunLogRowInput | null
		logs: Array<RunLogEntryInput>
	}) => Promise<{
		staged: boolean
		claimUpdatedAt: string | null
		record: PackageInvocationLedgerRecord | null
	}>
	touchPackageInvocation: (input: {
		invocationId: string
		claimUpdatedAt: string
	}) => Promise<{
		touched: boolean
		claimUpdatedAt: string | null
		record: PackageInvocationLedgerRecord | null
	}>
	releasePackageInvocation: (input: {
		invocationId: string
		claimUpdatedAt: string
		runId: string | null
		run: RunLogRowInput | null
		logs: Array<RunLogEntryInput>
	}) => Promise<{
		released: boolean
		record: PackageInvocationLedgerRecord | null
		runFinished: boolean
	}>
	upsertWorkflowProjection: (
		input: WorkflowProjectionUpsertInput,
	) => Promise<{ ok: true }>
	releaseWorkflowProjectionIdempotencyKey: (input: {
		id: string
	}) => Promise<{ released: boolean; previousKey: string | null }>
	getWorkflowProjection: (input: {
		id: string
	}) => Promise<WorkflowProjectionRecord | null>
	findWorkflowProjectionByIdempotencyKey: (input: {
		idempotencyKey: string
		bindingName?: string | null
	}) => Promise<WorkflowProjectionRecord | null>
	findWorkflowProjectionByBindingIdempotencyKey: (input: {
		bindingName: string
		idempotencyKey: string
	}) => Promise<WorkflowProjectionRecord | null>
	listWorkflowProjections: (input: WorkflowProjectionListInput) => Promise<{
		projections: Array<WorkflowProjectionRecord>
		nextCursor: string | null
	}>
	countActiveWorkflowProjections: () => Promise<{ count: number }>
	reserveWorkflowProjectionSlot: (
		input: WorkflowProjectionUpsertInput,
	) => Promise<WorkflowProjectionReserveResult>
	deleteWorkflowProjectionIfCreating: (input: {
		id: string
	}) => Promise<{ deleted: boolean }>
	upsertJobRunObservability: (
		input: JobRunObservabilityUpsertInput,
	) => Promise<JobRunObservabilityRecord>
	getJobRunObservability: (input: {
		jobId: string
	}) => Promise<JobRunObservabilityRecord | null>
	getJobRunObservabilityBatch: (input: {
		jobIds: Array<string>
	}) => Promise<Array<JobRunObservabilityRecord>>
	getAdminInsightsSnapshot: () => Promise<RunLogAdminInsightsSnapshot>
	summarizePackageFailures: (
		input: RunLogPackageFailureSummaryInput,
	) => Promise<RunLogPackageFailureSummary>
	getSqlBillingStats: () => Promise<RunLogSqlBillingStats>
	inspectSqlBilling: () => Promise<RunLogSqlBillingInspection>
	listPackageRunSuccesses: () => Promise<Array<PackageRunSuccessRecord>>
	listActivationMilestones: () => Promise<Array<ActivationMilestoneRecord>>
	dashboardBuckets: (input: { since: string; until: string }) => Promise<{
		buckets: Array<WorkspaceRunBucket>
		countsSince: string | null
	}>
	summarize: (input: { since: string }) => Promise<RunRecordSummary>
	listStorageIds: () => Promise<Array<string>>
	exportRuns: (input: ExportRunsInput) => Promise<ExportRunsResult>
	clearAll: () => Promise<{ ok: true }>
}
