import { type SkillReadEvent } from '#universal/skill-metrics.ts'
import {
	buildWorkspaceRunCharts,
	workspaceChartWindow,
} from '#universal/workspace-charts.ts'
import { toJsonSafeValue } from '@kody-internal/shared/json-safe-value.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { packageInvocationStartedLog } from '#worker/caller-disconnect.ts'
import { runLogDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { type RunLogAdminInsightsSnapshot } from './admin-insights-snapshot.ts'
import {
	type RunLogPackageFailureSummary,
	type RunLogPackageFailureSummaryInput,
} from './package-failure-summary.ts'
import {
	type ActivationMilestoneRecord,
	type PackageRunSuccessRecord,
} from './package-activation-state.ts'
import {
	type JobRunObservabilityRecord,
	type JobRunObservabilityUpsertInput,
} from './job-run-observability.ts'
import {
	type BulkUpdateRunErrorTriageFilter,
	type BulkUpdateRunErrorTriageResult,
	type PackageInvocationClaimInput,
	type PackageInvocationLedgerKey,
	type PackageInvocationLedgerRecord,
	type RunLogEntryInput,
	type RunLogRowInput,
	type RunLogRpc,
	type RunLogSqlBillingInspection,
	type RunLogSqlBillingStats,
	runLogSqlBillingOps,
} from './run-log-do.ts'
import {
	type WorkflowProjectionRecord,
	type WorkflowProjectionReserveResult,
	type WorkflowProjectionUpsertInput,
} from './workflow-projection.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	type RunErrorTriage,
	type RunRecord,
	type RunRecordContext,
	type RunRecordFilter,
	type RunRecordHandle,
	type RunLogLevel,
	type RunRecordLog,
	type RunRecordLogInput,
	type RunRecordPage,
	type RunRecordSummary,
	type RunStatus,
	type RunTerminalStatus,
	runLogLevelValues,
	runPersistenceForContext,
	runRecordDefaultPageSize,
	runRecordMaxJsonBytes,
	runRecordMaxLogEntriesPerRun,
	runRecordMaxPageSize,
	runRecordMaxResultSnapshotBytes,
	runRecordMaxTextBytes,
} from './types.ts'
import {
	normalizeRunStartedBy,
	runStartedByFromRequest,
} from './run-started-by.ts'

export { runLogSqlBillingOps }
export type { RunLogSqlBillingInspection, RunLogSqlBillingStats }

const textEncoder = new TextEncoder()

/**
 * RunLog names are the owner id bytes. `begin` / `claim` / `record` already
 * trim before naming the object; an `OwnerId` from `request.org.id` is
 * already trimmed, so this keeps those bytes. A stored id with surrounding
 * spaces keeps the trimmed name these entry points have always used.
 */
function runLogOwnerId(ownerId: OwnerId | null | undefined): OwnerId | null {
	const trimmed = ownerId?.trim() ?? ''
	if (!trimmed) return null
	return trimmed === ownerId ? ownerId : (trimmed as OwnerId)
}

function normalizeOptionalString(value: string | null | undefined) {
	const trimmed = value?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : null
}

/**
 * Lexical `started_at` compares need canonical UTC ISO strings (with
 * milliseconds). Offset forms and second-precision stamps sort wrong against
 * stored `toISOString()` values.
 */
function normalizeOptionalIsoTimestamp(value: string | null | undefined) {
	const trimmed = normalizeOptionalString(value)
	if (!trimmed) return null
	const ms = Date.parse(trimmed)
	if (!Number.isFinite(ms)) {
		throw new Error(`Invalid ISO timestamp filter: "${trimmed}"`)
	}
	return new Date(ms).toISOString()
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

/**
 * Bound a JSON-serializable handler result for `metadata.result`. Oversized
 * values become `{ __truncated__: true, preview }` so `runGet` stays useful
 * without blowing per-user DO storage.
 */
export function snapshotRunRecordResult(
	value: unknown,
	maxBytes = runRecordMaxResultSnapshotBytes,
): unknown {
	const safe = toJsonSafeValue(value)
	const json = JSON.stringify(safe)
	if (textEncoder.encode(json).length <= maxBytes) return safe
	let preview = truncateUtf8(json, Math.max(0, maxBytes - 64))
	let wrapped: { __truncated__: true; preview: string } = {
		__truncated__: true,
		preview,
	}
	while (
		textEncoder.encode(JSON.stringify(wrapped)).length > maxBytes &&
		preview.length > 0
	) {
		preview = preview.slice(0, Math.floor(preview.length * 0.8))
		wrapped = { __truncated__: true, preview }
	}
	return wrapped
}

function getErrorFields(error: unknown) {
	if (!error) return { errorName: null, errorMessage: null }
	if (error instanceof Error) {
		return {
			errorName: error.name,
			errorMessage: truncateUtf8(error.message, runRecordMaxTextBytes),
		}
	}
	if (typeof error === 'object' && error !== null) {
		const record = error as Record<string, unknown>
		const message = record['message']
		if (typeof message === 'string') {
			const name = record['name']
			return {
				errorName: typeof name === 'string' ? name : 'Error',
				errorMessage: truncateUtf8(message, runRecordMaxTextBytes),
			}
		}
	}
	return {
		errorName: 'Unknown',
		errorMessage: truncateUtf8(String(error), runRecordMaxTextBytes),
	}
}

/**
 * The sandbox executor flattens console output to strings and encodes the
 * level as a leading `[warn] ` / `[error] ` marker. Recover the structured
 * level so readers can filter and colour by it instead of pattern-matching
 * message text.
 */
function splitLeveledLogMessage(message: string): {
	level: RunLogLevel
	message: string
} {
	for (const level of runLogLevelValues) {
		const marker = `[${level}] `
		if (message.startsWith(marker)) {
			return { level, message: message.slice(marker.length) }
		}
	}
	return { level: 'log', message }
}

function normalizeLogs(
	logs: Array<RunRecordLogInput> | undefined,
): Array<RunLogEntryInput> {
	return (logs ?? [])
		.slice(-runRecordMaxLogEntriesPerRun)
		.map((entry, index) => {
			if (typeof entry === 'string') {
				const split = splitLeveledLogMessage(String(entry))
				return {
					sequence: index,
					level: split.level,
					message: truncateUtf8(split.message, runRecordMaxTextBytes),
					fieldsJson: null,
				}
			}
			return {
				sequence: index,
				level: entry.level ?? 'log',
				message: truncateUtf8(String(entry.message), runRecordMaxTextBytes),
				fieldsJson: entry.fields == null ? null : serializeJson(entry.fields),
			}
		})
}

/**
 * Stamp started_by onto a run context when the caller passes a request and
 * the context does not already set it. Call sites can also set `startedBy`
 * explicitly (for example after resolving a token name label).
 */
export function withRunStartedBy(
	context: RunRecordContext,
	request?: RequestContext | null,
	label?: string | null,
): RunRecordContext {
	if (context.startedBy) {
		return {
			...context,
			startedBy: normalizeRunStartedBy(context.startedBy),
		}
	}
	const startedBy = runStartedByFromRequest(request, { label })
	if (!startedBy) return context
	return { ...context, startedBy }
}

function buildRunRow(input: {
	handle: RunRecordHandle
	status: RunStatus
	finishedAt: string | null
	durationMs: number | null
	errorName: string | null
	errorMessage: string | null
	updatedAt: string
}): RunLogRowInput {
	const context = input.handle.context
	return {
		id: input.handle.id,
		surface: context.surface,
		status: input.status,
		name: normalizeOptionalString(context.name),
		packageId: normalizeOptionalString(context.packageId),
		kodyId: normalizeOptionalString(context.kodyId),
		sourceId: normalizeOptionalString(context.sourceId),
		publishedCommit: normalizeOptionalString(context.publishedCommit),
		storageId: normalizeOptionalString(context.storageId),
		jobId: normalizeOptionalString(context.jobId),
		workflowId: normalizeOptionalString(context.workflowId),
		invocationId: normalizeOptionalString(context.invocationId),
		sessionId: normalizeOptionalString(context.sessionId),
		idempotencyKey: normalizeOptionalString(context.idempotencyKey),
		parentRunId: normalizeOptionalString(context.parentRunId),
		startedAt: input.handle.startedAt,
		finishedAt: input.finishedAt,
		durationMs: input.durationMs,
		errorName: input.errorName,
		errorMessage: input.errorMessage,
		startedBy: normalizeRunStartedBy(context.startedBy),
		metadataJson: serializeJson(context.metadata ?? {}),
		createdAt: input.handle.startedAt,
		updatedAt: input.updatedAt,
	}
}

function runLogBinding(env: Env) {
	return (env as Partial<Env>).RUN_LOG ?? null
}

export function runLogRpc(input: { env: Env; userId: OwnerId }): RunLogRpc {
	const namespace = runLogBinding(input.env)
	if (!namespace) {
		throw new Error('RUN_LOG Durable Object binding is not configured.')
	}
	return namespace.get(
		namespace.idFromName(runLogDurableObjectName(input.userId)),
	) as unknown as RunLogRpc
}

/**
 * Never throws: a run record is observability, so a broken record must not
 * fail the run it observes. Callers treat a `null` handle as "not recording"
 * and keep going. Same contract as `recordUsage`.
 */
export function beginRunRecord(input: {
	env: Env
	userId?: OwnerId | null
	context?: RunRecordContext | null
	/** Live request used to stamp started_by when context omits it. */
	request?: RequestContext | null
	/** Optional display label (API token name); never a secret. */
	startedByLabel?: string | null
	waitUntil?: (promise: Promise<unknown>) => void
}): RunRecordHandle | null {
	const namespace = runLogBinding(input.env)
	const userId = runLogOwnerId(input.userId)
	const context = input.context
		? withRunStartedBy(input.context, input.request, input.startedByLabel)
		: null
	if (!namespace || !userId || !context) return null

	try {
		const id = crypto.randomUUID()
		const startedAt = new Date().toISOString()
		const persistence = runPersistenceForContext(context)
		const handle: RunRecordHandle = {
			id,
			userId,
			startedAt,
			persistence,
			context,
		}

		if (persistence === 'eager') {
			const run = buildRunRow({
				handle,
				status: 'running',
				finishedAt: null,
				durationMs: null,
				errorName: null,
				errorMessage: null,
				updatedAt: startedAt,
			})
			// A dropped startRun is deliberately harmless: finishRun upserts the
			// complete row. That is why begin can stay off the request critical path.
			// Keyed execute must use {@link claimRunRecord} instead so the running
			// row is visible before work starts (replay / in-progress lookups).
			const startPromise = runLogRpc({ env: input.env, userId })
				.startRun({ run })
				.catch((error: unknown) => {
					console.warn('run-record-start-failed', error)
				})
			if (input.waitUntil) {
				input.waitUntil(startPromise)
			} else {
				void startPromise
			}
		}

		return handle
	} catch (error) {
		console.warn('run-record-begin-failed', error)
		return null
	}
}

/**
 * Await a running-row insert for a handle {@link beginRunRecord} already
 * minted. `startRun` is INSERT OR IGNORE, so a finish that landed first is
 * left alone. Never throws.
 *
 * Hosted execute calls this before handing a run id back at the transport
 * budget. The fire-and-forget begin stays off the fast path; the follow
 * response waits until `runGet` can see the row.
 */
export async function ensureRunRecordStarted(input: {
	env: Env
	handle: RunRecordHandle | null
}): Promise<boolean> {
	const handle = input.handle
	if (!handle || handle.persistence !== 'eager') return false
	if (!runLogBinding(input.env)) return false
	try {
		const run = buildRunRow({
			handle,
			status: 'running',
			finishedAt: null,
			durationMs: null,
			errorName: null,
			errorMessage: null,
			updatedAt: handle.startedAt,
		})
		await runLogRpc({ env: input.env, userId: handle.userId }).startRun({
			run,
		})
		return true
	} catch (error) {
		console.warn('run-record-ensure-start-failed', error)
		return false
	}
}

/**
 * Awaited claim for keyed runs (execute with `idempotencyKey`). Returns the
 * existing owner when the key is already taken so callers can replay or report
 * in-progress without starting a duplicate sandbox.
 *
 * Never throws: same observability contract as {@link beginRunRecord}.
 */
export async function claimRunRecord(input: {
	env: Env
	userId?: OwnerId | null
	context?: RunRecordContext | null
	request?: RequestContext | null
	startedByLabel?: string | null
}): Promise<
	| { claimed: true; handle: RunRecordHandle }
	| { claimed: false; run: RunRecord }
	| null
> {
	const namespace = runLogBinding(input.env)
	const userId = runLogOwnerId(input.userId)
	const stamped = input.context
		? withRunStartedBy(input.context, input.request, input.startedByLabel)
		: null
	if (!namespace || !userId || !stamped) return null
	const idempotencyKey = normalizeOptionalString(stamped.idempotencyKey)
	if (!idempotencyKey) return null

	try {
		const startedAt = new Date().toISOString()
		const context = {
			...stamped,
			idempotencyKey,
		}
		const handle: RunRecordHandle = {
			id: crypto.randomUUID(),
			userId,
			startedAt,
			persistence: runPersistenceForContext(context),
			context,
		}
		const run = buildRunRow({
			handle,
			status: 'running',
			finishedAt: null,
			durationMs: null,
			errorName: null,
			errorMessage: null,
			updatedAt: startedAt,
		})
		const claimed = await runLogRpc({ env: input.env, userId }).claimRun({
			run,
		})
		if (!claimed.claimed) {
			return { claimed: false, run: claimed.run }
		}
		return { claimed: true, handle }
	} catch (error) {
		console.warn('run-record-claim-failed', error)
		return null
	}
}

/**
 * Never throws: a broken run record must not fail the observed run. Terminal
 * job counters and activation state update inside the DO finish from zero /
 * existing dedicated rows — no D1 seed pass.
 */
export async function finishRunRecord(input: {
	env: Env
	handle: RunRecordHandle | null
	status: RunTerminalStatus
	logs?: Array<RunRecordLogInput>
	error?: unknown
	/**
	 * Optional JSON-serializable handler result retained under
	 * `metadata.result` (bounded; see {@link snapshotRunRecordResult}).
	 */
	result?: unknown
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<boolean> {
	const handle = input.handle
	if (!handle) return false
	if (handle.persistence === 'on-failure' && input.status === 'success') {
		return true
	}

	let persistedRun: RunLogRowInput | null = null
	try {
		if (runLogBinding(input.env)) {
			const finishedAt = new Date().toISOString()
			const durationMs = Math.max(
				0,
				Date.parse(finishedAt) - Date.parse(handle.startedAt),
			)
			const { errorName, errorMessage } = getErrorFields(input.error)
			const metadata =
				input.result === undefined
					? handle.context.metadata
					: {
							...handle.context.metadata,
							result: snapshotRunRecordResult(input.result),
						}
			const run = buildRunRow({
				handle: {
					...handle,
					context: {
						...handle.context,
						metadata,
					},
				},
				status: input.status,
				finishedAt,
				durationMs,
				errorName,
				errorMessage,
				updatedAt: finishedAt,
			})
			const finishResult = await runLogRpc({
				env: input.env,
				userId: handle.userId,
			}).finishRun({
				run,
				logs: normalizeLogs(input.logs),
			})
			// Scheduled late finishes may be fenced (`wrote: false`); do not
			// treat them as persisted or dispatch run.error for a no-op write.
			if (finishResult.wrote) {
				persistedRun = run
			}
		}
	} catch (error) {
		console.warn('run-record-finish-failed', error)
	}

	if (!persistedRun) return false
	const sideEffects = dispatchTerminalRunRecordSideEffects({
		env: input.env,
		handle,
		persistedRun,
		status: input.status,
		waitUntil: input.waitUntil,
	})
	if (input.waitUntil) {
		input.waitUntil(sideEffects)
	} else {
		await sideEffects
	}
	return true
}

/**
 * One-RPC terminal write for callers that have no work between begin and
 * finish. Equivalent to minting a handle and calling `finishRunRecord` without
 * `beginRunRecord` (finish already upserts a complete row). Prefer this over a
 * no-op begin when the surface is known to be terminal-only.
 */
export async function recordRunRecord(input: {
	env: Env
	userId?: OwnerId | null
	context?: RunRecordContext | null
	request?: RequestContext | null
	startedByLabel?: string | null
	status: RunTerminalStatus
	logs?: Array<RunRecordLogInput>
	error?: unknown
	result?: unknown
	startedAt?: string | null
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<RunRecordHandle | null> {
	const namespace = runLogBinding(input.env)
	const userId = runLogOwnerId(input.userId)
	const context = input.context
		? withRunStartedBy(input.context, input.request, input.startedByLabel)
		: null
	if (!namespace || !userId || !context) return null

	let handle: RunRecordHandle
	try {
		handle = {
			id: crypto.randomUUID(),
			userId,
			startedAt:
				normalizeOptionalString(input.startedAt) ?? new Date().toISOString(),
			persistence: runPersistenceForContext(context),
			context,
		}
	} catch (error) {
		console.warn('run-record-begin-failed', error)
		return null
	}
	const persisted = await finishRunRecord({
		env: input.env,
		handle,
		status: input.status,
		logs: input.logs,
		error: input.error,
		result: input.result,
		waitUntil: input.waitUntil,
	})
	return persisted ? handle : null
}

export async function listRunRecords(input: {
	env: Env
	userId: OwnerId
	filter?: RunRecordFilter | null
	limit?: number | null
	cursor?: string | null
}): Promise<RunRecordPage> {
	if (!runLogBinding(input.env)) {
		return { runs: [], nextCursor: null }
	}
	const limit = Math.min(
		Math.max(input.limit ?? runRecordDefaultPageSize, 1),
		runRecordMaxPageSize,
	)
	return await runLogRpc({ env: input.env, userId: input.userId }).listRuns({
		surface: input.filter?.surface ?? null,
		status: input.filter?.status ?? null,
		packageId: normalizeOptionalString(input.filter?.packageId),
		jobId: normalizeOptionalString(input.filter?.jobId),
		workflowId: normalizeOptionalString(input.filter?.workflowId),
		name: normalizeOptionalString(input.filter?.name),
		since: normalizeOptionalIsoTimestamp(input.filter?.since),
		until: normalizeOptionalIsoTimestamp(input.filter?.until),
		errorTriage: input.filter?.errorTriage ?? null,
		startedByUserId: normalizeOptionalString(input.filter?.startedByUserId),
		executionContextId: normalizeOptionalString(
			input.filter?.executionContextId,
		),
		limit,
		cursor: input.cursor ?? null,
	})
}

export type UpdateRunErrorTriageOutcome =
	| { ok: true; run: RunRecord }
	| { ok: false; reason: 'not_found' }
	| { ok: false; reason: 'not_error'; status: RunStatus; runId: string }
	| { ok: false; reason: 'unavailable' }

/**
 * Soft-triage a retained error run (`ignored` / `resolved`) or clear triage
 * (`errorTriage: null`). Non-destructive: error details stay on the record.
 */
export async function updateRunErrorTriage(input: {
	env: Env
	userId: OwnerId
	runId: string
	errorTriage: RunErrorTriage | null
	triageNote?: string | null
}): Promise<UpdateRunErrorTriageOutcome> {
	if (!runLogBinding(input.env)) return { ok: false, reason: 'unavailable' }
	// Treat omitted / undefined note as preserve. Pass an explicit boolean over
	// DO RPC so we do not depend on `undefined` surviving structured clone.
	const preserveTriageNote = input.triageNote === undefined
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).updateRunErrorTriage({
		runId: input.runId,
		errorTriage: input.errorTriage,
		preserveTriageNote,
		triageNote: preserveTriageNote ? null : (input.triageNote ?? null),
		triagedBy: input.userId,
	})
}

export type BulkUpdateRunErrorTriageOutcome =
	| BulkUpdateRunErrorTriageResult
	| { reason: 'unavailable' }

/**
 * Soft-triage a bounded set of retained errors selected by ids or exact-match
 * filters. Execution outcomes and error details are never rewritten.
 */
export async function bulkUpdateRunErrorTriage(input: {
	env: Env
	userId: OwnerId
	runIds?: Array<string> | null
	filter?: BulkUpdateRunErrorTriageFilter | null
	errorTriage: RunErrorTriage | null
	triageNote?: string | null
	limit?: number | null
	dryRun?: boolean
}): Promise<BulkUpdateRunErrorTriageOutcome> {
	if (!runLogBinding(input.env)) return { reason: 'unavailable' }
	const preserveTriageNote = input.triageNote === undefined
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).bulkUpdateRunErrorTriage({
		runIds: input.runIds ?? null,
		filter: input.filter ?? null,
		errorTriage: input.errorTriage,
		preserveTriageNote,
		triageNote: preserveTriageNote ? null : (input.triageNote ?? null),
		triagedBy: input.userId,
		limit: Math.min(
			Math.max(input.limit ?? runRecordMaxPageSize, 1),
			runRecordMaxPageSize,
		),
		dryRun: input.dryRun ?? false,
	})
}

export async function getRunRecord(input: {
	env: Env
	userId: OwnerId
	runId: string
}): Promise<{ run: RunRecord; logs: Array<RunRecordLog> } | null> {
	if (!runLogBinding(input.env)) return null
	return await runLogRpc({ env: input.env, userId: input.userId }).getRun({
		runId: input.runId,
	})
}

export async function getRunRecordByIdempotencyKey(input: {
	env: Env
	userId: OwnerId
	idempotencyKey: string
	surface?: RunRecordContext['surface'] | null
}): Promise<RunRecord | null> {
	const key = normalizeOptionalString(input.idempotencyKey)
	if (!runLogBinding(input.env) || !key) return null
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).getRunByIdempotencyKey({
		idempotencyKey: key,
		surface: input.surface ?? null,
	})
}

/**
 * Release a claimed `running` row after setup failure (before sandbox work).
 * Never throws. Terminal rows are left alone so legitimate finishes stay put.
 */
export async function abandonRunRecord(input: {
	env: Env
	handle: RunRecordHandle | null
}): Promise<void> {
	const handle = input.handle
	if (!handle || !runLogBinding(input.env)) return
	try {
		await runLogRpc({
			env: input.env,
			userId: handle.userId,
		}).deleteRunIfRunning({ runId: handle.id })
	} catch (error) {
		console.warn('run-record-abandon-failed', error)
	}
}

/**
 * Claim a keyed package invocation: idempotency-ledger claim plus eager
 * run-record begin in ONE awaited on-path DO RPC. Unlike {@link beginRunRecord}
 * this is correctness, not observability — a failed claim must fail the
 * invocation — so errors propagate to the caller instead of being swallowed.
 */
export async function claimPackageInvocationRecord(input: {
	env: Env
	userId: OwnerId
	/** `null` when the caller owns the run record (workflow-sourced invokes). */
	context: RunRecordContext | null
	request?: RequestContext | null
	startedByLabel?: string | null
	invocation: PackageInvocationClaimInput
	/** ISO cutoff for in-place stale `in_progress` reclaims. */
	staleBefore: string
	/**
	 * ISO cutoff for same-`claimOwner` reclaims of a fresh `in_progress` row.
	 * Omit to disable same-owner reclaim (only the global stale window applies).
	 */
	sameOwnerStaleBefore?: string
}): Promise<
	| {
			outcome: 'claimed'
			invocationId: string
			claimUpdatedAt: string
			reclaimed: boolean
			handle: RunRecordHandle | null
	  }
	| { outcome: 'existing'; record: PackageInvocationLedgerRecord }
> {
	let handle: RunRecordHandle | null = null
	let run: RunLogRowInput | null = null
	if (input.context) {
		const context = withRunStartedBy(
			input.context,
			input.request,
			input.startedByLabel,
		)
		const startedAt = new Date().toISOString()
		handle = {
			id: crypto.randomUUID(),
			userId: input.userId,
			startedAt,
			persistence: runPersistenceForContext(context),
			context,
		}
		run = buildRunRow({
			handle,
			status: 'running',
			finishedAt: null,
			durationMs: null,
			errorName: null,
			errorMessage: null,
			updatedAt: startedAt,
		})
	}
	const claimed = await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).claimPackageInvocation({
		invocation: input.invocation,
		staleBefore: input.staleBefore,
		...(input.sameOwnerStaleBefore
			? { sameOwnerStaleBefore: input.sameOwnerStaleBefore }
			: {}),
		run,
		// Same RPC as the running row: an isolate killed before finish still
		// has a diagnostic line for Activity and runGet.
		initialLogs: run
			? [
					{
						sequence: 0,
						level: 'info',
						message: packageInvocationStartedLog(
							input.context?.name ?? input.invocation.exportName,
						),
						fieldsJson: null,
					},
				]
			: undefined,
	})
	if (claimed.outcome === 'existing') {
		return claimed
	}
	if (handle) {
		// Stale reclaims keep the original ledger row id; the run record must
		// reference the invocation id that actually owns the claim.
		handle.context = { ...handle.context, invocationId: claimed.invocationId }
	}
	return { ...claimed, handle }
}

export async function getPackageInvocationRecord(input: {
	env: Env
	userId: OwnerId
	key: PackageInvocationLedgerKey
}): Promise<PackageInvocationLedgerRecord | null> {
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).getPackageInvocation(input.key)
}

/**
 * Terminal ledger response and run-record finish in ONE awaited on-path DO
 * RPC — the counterpart to {@link claimPackageInvocationRecord}. RPC failures
 * propagate (the caller decides whether a lost terminal write may poison the
 * key); run-error subscription side effects shared with
 * {@link finishRunRecord} never throw and are scheduled on `waitUntil` when
 * provided.
 */
export async function finishPackageInvocationRecord(input: {
	env: Env
	userId: OwnerId
	handle: RunRecordHandle | null
	invocationId: string
	claimUpdatedAt: string
	ledgerStatus: 'completed' | 'failed'
	/** Bounded replay cache JSON; `null` drops the replay (oversized). */
	responseJson: string | null
	status: RunTerminalStatus
	logs?: Array<RunRecordLogInput>
	error?: unknown
	result?: unknown
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<{
	ledgerUpdated: boolean
	record: PackageInvocationLedgerRecord | null
}> {
	const handle = input.handle
	let run: RunLogRowInput | null = null
	if (handle) {
		const finishedAt = new Date().toISOString()
		const durationMs = Math.max(
			0,
			Date.parse(finishedAt) - Date.parse(handle.startedAt),
		)
		const { errorName, errorMessage } = getErrorFields(input.error)
		const metadata =
			input.result === undefined
				? handle.context.metadata
				: {
						...handle.context.metadata,
						result: snapshotRunRecordResult(input.result),
					}
		run = buildRunRow({
			handle: {
				...handle,
				context: {
					...handle.context,
					metadata,
				},
			},
			status: input.status,
			finishedAt,
			durationMs,
			errorName,
			errorMessage,
			updatedAt: finishedAt,
		})
	}
	const finished = await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).finishPackageInvocation({
		invocationId: input.invocationId,
		claimUpdatedAt: input.claimUpdatedAt,
		status: input.ledgerStatus,
		responseJson: input.responseJson,
		run,
		logs: run ? normalizeLogs(input.logs) : [],
	})
	if (handle && run) {
		const sideEffects = dispatchTerminalRunRecordSideEffects({
			env: input.env,
			handle,
			persistedRun: run,
			status: input.status,
			waitUntil: input.waitUntil,
		})
		if (input.waitUntil) {
			input.waitUntil(sideEffects)
		} else {
			await sideEffects
		}
	}
	return finished
}

/**
 * Release a claim whose execution never started. Deletes the still-`in_progress`
 * ledger row so retries are not poisoned, and finishes the attempt's `running`
 * run as an error with diagnostic logs (so Activity keeps pre-execution
 * evidence instead of a vanished zero-log attempt).
 */
/**
 * Persist a successful execute outcome onto an `in_progress` claim (and its
 * run row) when the atomic terminal finish fails. The staged `response_json`
 * fences reclaim so retries promote the ledger without re-executing.
 */
export async function stagePackageInvocationResultRecord(input: {
	env: Env
	userId: OwnerId
	handle: RunRecordHandle | null
	invocationId: string
	claimUpdatedAt: string
	responseJson: string | null
	status: RunTerminalStatus
	logs?: Array<RunRecordLogInput>
	error?: unknown
	result?: unknown
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<{
	staged: boolean
	claimUpdatedAt: string | null
	record: PackageInvocationLedgerRecord | null
}> {
	const handle = input.handle
	let run: RunLogRowInput | null = null
	if (handle) {
		const finishedAt = new Date().toISOString()
		const durationMs = Math.max(
			0,
			Date.parse(finishedAt) - Date.parse(handle.startedAt),
		)
		const { errorName, errorMessage } = getErrorFields(input.error)
		const metadata =
			input.result === undefined
				? handle.context.metadata
				: {
						...handle.context.metadata,
						result: snapshotRunRecordResult(input.result),
					}
		run = buildRunRow({
			handle: {
				...handle,
				context: {
					...handle.context,
					metadata,
				},
			},
			status: input.status,
			finishedAt,
			durationMs,
			errorName,
			errorMessage,
			updatedAt: finishedAt,
		})
	}
	const staged = await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).stagePackageInvocationResult({
		invocationId: input.invocationId,
		claimUpdatedAt: input.claimUpdatedAt,
		responseJson: input.responseJson,
		run,
		logs: run ? normalizeLogs(input.logs) : [],
	})
	if (staged.staged && handle && run) {
		const sideEffects = dispatchTerminalRunRecordSideEffects({
			env: input.env,
			handle,
			persistedRun: run,
			status: input.status,
			waitUntil: input.waitUntil,
		})
		if (input.waitUntil) {
			input.waitUntil(sideEffects)
		} else {
			await sideEffects
		}
	}
	return staged
}

/**
 * Refresh `updated_at` on a live claim after a successful execute whose
 * terminal persist failed when staging is also unavailable, so same-owner
 * reclaim grace does not treat the original claim timestamp as already expired.
 */
export async function touchPackageInvocationRecord(input: {
	env: Env
	userId: OwnerId
	invocationId: string
	claimUpdatedAt: string
}): Promise<{
	touched: boolean
	claimUpdatedAt: string | null
	record: PackageInvocationLedgerRecord | null
}> {
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).touchPackageInvocation({
		invocationId: input.invocationId,
		claimUpdatedAt: input.claimUpdatedAt,
	})
}

export async function releasePackageInvocationRecord(input: {
	env: Env
	userId: OwnerId
	invocationId: string
	claimUpdatedAt: string
	handle: RunRecordHandle | null
	logs?: Array<RunRecordLogInput>
	error?: unknown
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<{
	released: boolean
	record: PackageInvocationLedgerRecord | null
}> {
	const handle = input.handle
	let run: RunLogRowInput | null = null
	if (handle) {
		const finishedAt = new Date().toISOString()
		const durationMs = Math.max(
			0,
			Date.parse(finishedAt) - Date.parse(handle.startedAt),
		)
		const { errorName, errorMessage } = getErrorFields(input.error)
		run = buildRunRow({
			handle,
			status: 'error',
			finishedAt,
			durationMs,
			errorName,
			errorMessage,
			updatedAt: finishedAt,
		})
	}
	const released = await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).releasePackageInvocation({
		invocationId: input.invocationId,
		claimUpdatedAt: input.claimUpdatedAt,
		runId: handle?.id ?? null,
		run,
		logs: run ? normalizeLogs(input.logs) : [],
	})
	if (handle && run && released.runFinished) {
		const sideEffects = dispatchTerminalRunRecordSideEffects({
			env: input.env,
			handle,
			persistedRun: run,
			status: 'error',
			waitUntil: input.waitUntil,
		})
		if (input.waitUntil) {
			input.waitUntil(sideEffects)
		} else {
			await sideEffects
		}
	}
	return {
		released: released.released,
		record: released.record,
	}
}

/**
 * Post-terminal-write observers shared by {@link finishRunRecord} and
 * {@link finishPackageInvocationRecord}: best-effort `run.error.recorded`
 * dispatch on error. Never throws.
 */
async function dispatchTerminalRunRecordSideEffects(input: {
	env: Env
	handle: RunRecordHandle
	persistedRun: RunLogRowInput
	status: RunTerminalStatus
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<void> {
	if (input.status !== 'error') return
	if (input.handle.context.surface === 'subscription') return
	try {
		// Dynamic import: a static edge to package-subscriptions pulls
		// package-invocations and deepens the account-export cycle (see the
		// matching note in finishRunRecord).
		const { dispatchRunErrorSubscriptionEvents } =
			await import('./package-subscriptions.ts')
		await dispatchRunErrorSubscriptionEvents({
			env: input.env,
			userId: input.handle.userId,
			run: input.persistedRun,
			waitUntil: input.waitUntil,
		})
	} catch (error) {
		console.warn('run-error-subscription-dispatch-failed', error)
	}
}

export async function summarizeRunRecords(input: {
	env: Env
	userId: OwnerId
	since?: string | null
}): Promise<RunRecordSummary> {
	const since =
		normalizeOptionalString(input.since) ?? new Date(0).toISOString()
	if (!runLogBinding(input.env)) {
		return {
			since,
			total: 0,
			errors: 0,
			ignored: 0,
			resolved: 0,
			running: 0,
			bySurface: [],
		}
	}
	return await runLogRpc({ env: input.env, userId: input.userId }).summarize({
		since,
	})
}

export async function listRunRecordStorageIds(input: {
	env: Env
	userId: OwnerId
}): Promise<Array<string>> {
	if (!runLogBinding(input.env)) return []
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).listStorageIds()
}

export async function exportRunRecords(input: {
	env: Env
	userId: OwnerId
	pageSize?: number
	startAfter?: string | null
}): Promise<{
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
}> {
	if (!runLogBinding(input.env)) {
		return {
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
	}
	const page = await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).exportRuns({
		pageSize: input.pageSize ?? runRecordDefaultPageSize,
		startAfter: input.startAfter ?? null,
	})
	return {
		...page,
		packageInvocations: page.packageInvocations ?? [],
		workflowProjections: page.workflowProjections ?? [],
		jobRunObservability: page.jobRunObservability ?? [],
		packageRunSuccesses: page.packageRunSuccesses ?? [],
		activationMilestones: page.activationMilestones ?? [],
		skillReads: page.skillReads ?? [],
	}
}

export async function clearRunRecords(input: {
	env: Env
	userId: OwnerId
}): Promise<void> {
	if (!runLogBinding(input.env)) return
	await runLogRpc({ env: input.env, userId: input.userId }).clearAll()
}

/**
 * Workflow projection writes/reads are correctness (idempotency + concurrent
 * workflow entitlements). Errors propagate to the caller.
 */
export async function upsertWorkflowProjection(input: {
	env: Env
	userId: OwnerId
	projection: WorkflowProjectionUpsertInput
}): Promise<{ ok: true }> {
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).upsertWorkflowProjection(input.projection)
}

export async function releaseWorkflowProjectionIdempotencyKey(input: {
	env: Env
	userId: OwnerId
	id: string
}): Promise<{ released: boolean; previousKey: string | null }> {
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).releaseWorkflowProjectionIdempotencyKey({ id: input.id })
}

export async function getWorkflowProjection(input: {
	env: Env
	userId: OwnerId
	id: string
}): Promise<WorkflowProjectionRecord | null> {
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).getWorkflowProjection({ id: input.id })
}

export async function findWorkflowProjectionByIdempotencyKey(input: {
	env: Env
	userId: OwnerId
	idempotencyKey: string
	bindingName?: string | null
}): Promise<WorkflowProjectionRecord | null> {
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).findWorkflowProjectionByIdempotencyKey({
		idempotencyKey: input.idempotencyKey,
		bindingName: input.bindingName ?? null,
	})
}

/**
 * Exact binding + idempotency lookup that includes `creating` rows. Use this
 * instead of listing/scanning creating projections.
 */
export async function findWorkflowProjectionByBindingIdempotencyKey(input: {
	env: Env
	userId: OwnerId
	bindingName: string
	idempotencyKey: string
}): Promise<WorkflowProjectionRecord | null> {
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).findWorkflowProjectionByBindingIdempotencyKey({
		bindingName: input.bindingName,
		idempotencyKey: input.idempotencyKey,
	})
}

export async function listWorkflowProjections(input: {
	env: Env
	userId: OwnerId
	limit?: number | null
	cursor?: string | null
	status?: string | null
	statuses?: ReadonlyArray<string> | null
	bindingName?: string | null
	id?: string | null
	packageId?: string | null
	since?: string | null
}): Promise<{
	projections: Array<WorkflowProjectionRecord>
	nextCursor: string | null
}> {
	const limit = Math.min(
		Math.max(input.limit ?? runRecordDefaultPageSize, 1),
		runRecordMaxPageSize,
	)
	const statuses =
		input.statuses
			?.map((value) => normalizeOptionalString(value))
			.filter((value): value is string => value != null) ?? null
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).listWorkflowProjections({
		limit,
		cursor: input.cursor ?? null,
		status: input.status ?? null,
		statuses,
		bindingName: input.bindingName ?? null,
		id: normalizeOptionalString(input.id),
		packageId: normalizeOptionalString(input.packageId),
		since: normalizeOptionalIsoTimestamp(input.since),
	})
}

export async function countActiveWorkflowProjections(input: {
	env: Env
	userId: OwnerId
}): Promise<number> {
	const result = await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).countActiveWorkflowProjections()
	return result.count
}

export async function reserveWorkflowProjectionSlot(input: {
	env: Env
	userId: OwnerId
	projection: WorkflowProjectionUpsertInput
}): Promise<WorkflowProjectionReserveResult> {
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).reserveWorkflowProjectionSlot(input.projection)
}

export async function deleteWorkflowProjectionIfCreating(input: {
	env: Env
	userId: OwnerId
	id: string
}): Promise<{ deleted: boolean }> {
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).deleteWorkflowProjectionIfCreating({ id: input.id })
}

/**
 * Job-run observability is best-effort instrumentation. Never throws.
 */
export async function upsertJobRunObservability(input: {
	env: Env
	userId: OwnerId
	outcome: JobRunObservabilityUpsertInput
}): Promise<JobRunObservabilityRecord | null> {
	if (!runLogBinding(input.env)) return null
	try {
		return await runLogRpc({
			env: input.env,
			userId: input.userId,
		}).upsertJobRunObservability(input.outcome)
	} catch (error) {
		console.warn('job-run-observability-upsert-failed', error)
		return null
	}
}

export async function getJobRunObservability(input: {
	env: Env
	userId: OwnerId
	jobId: string
}): Promise<JobRunObservabilityRecord | null> {
	if (!runLogBinding(input.env)) return null
	try {
		return await runLogRpc({
			env: input.env,
			userId: input.userId,
		}).getJobRunObservability({ jobId: input.jobId })
	} catch (error) {
		console.warn('job-run-observability-get-failed', error)
		return null
	}
}

/**
 * Content-free per-user RunLog snapshot for post-D1 admin insights readers.
 * Propagates binding/RPC errors. Never returns user-authored content.
 */
export async function getAdminInsightsSnapshot(input: {
	env: Env
	userId: OwnerId
}): Promise<RunLogAdminInsightsSnapshot> {
	if (!runLogBinding(input.env)) {
		throw new Error('RUN_LOG Durable Object binding is not configured.')
	}
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).getAdminInsightsSnapshot()
}

/**
 * Content-free per-owner failed-run counts for one window. Propagates
 * binding/RPC errors. Never returns error messages or other user content.
 */
export async function summarizePackageFailures(input: {
	env: Env
	userId: OwnerId
	window: RunLogPackageFailureSummaryInput
}): Promise<RunLogPackageFailureSummary> {
	if (!runLogBinding(input.env)) {
		throw new Error('RUN_LOG Durable Object binding is not configured.')
	}
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).summarizePackageFailures(input.window)
}

/**
 * RunLog-only SQLite rowsRead/rowsWritten counters for cost diagnosis.
 * Propagates binding/RPC errors. Never returns user content.
 */
export async function getSqlBillingStats(input: {
	env: Env
	userId: OwnerId
}): Promise<RunLogSqlBillingStats> {
	if (!runLogBinding(input.env)) {
		throw new Error('RUN_LOG Durable Object binding is not configured.')
	}
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).getSqlBillingStats()
}

/**
 * Content-free RunLog schema + SQL-plan snapshot for cost diagnosis.
 * Propagates binding/RPC errors. Never returns user content.
 */
export async function inspectRunLogSqlBilling(input: {
	env: Env
	userId: OwnerId
}): Promise<RunLogSqlBillingInspection> {
	if (!runLogBinding(input.env)) {
		throw new Error('RUN_LOG Durable Object binding is not configured.')
	}
	return await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).inspectSqlBilling()
}

export async function getJobRunObservabilityBatch(input: {
	env: Env
	userId: OwnerId
	jobIds: Array<string>
}): Promise<Array<JobRunObservabilityRecord>> {
	if (!runLogBinding(input.env)) return []
	try {
		return await runLogRpc({
			env: input.env,
			userId: input.userId,
		}).getJobRunObservabilityBatch({ jobIds: input.jobIds })
	} catch (error) {
		console.warn('job-run-observability-batch-failed', error)
		return []
	}
}

/**
 * Activation reads are observability. Never throws. Writes happen atomically
 * inside terminal `finishRun` / `finishPackageInvocation`.
 */
export async function listPackageRunSuccesses(input: {
	env: Env
	userId: OwnerId
}): Promise<Array<PackageRunSuccessRecord>> {
	if (!runLogBinding(input.env)) return []
	try {
		return await runLogRpc({
			env: input.env,
			userId: input.userId,
		}).listPackageRunSuccesses()
	} catch (error) {
		console.warn('package-run-successes-list-failed', error)
		return []
	}
}

export async function listActivationMilestones(input: {
	env: Env
	userId: OwnerId
}): Promise<Array<ActivationMilestoneRecord>> {
	if (!runLogBinding(input.env)) return []
	try {
		return await runLogRpc({
			env: input.env,
			userId: input.userId,
		}).listActivationMilestones()
	} catch (error) {
		console.warn('activation-milestones-list-failed', error)
		return []
	}
}

export type { RunLogRpc }
export type {
	PackageInvocationClaimInput,
	PackageInvocationLedgerKey,
	PackageInvocationLedgerRecord,
	PackageInvocationLedgerStatus,
} from './run-log-do.ts'
export type {
	RunLogAdminInsightsActivationMilestone,
	RunLogAdminInsightsSnapshot,
	RunLogAdminInsightsWorkflowStatusCount,
} from './admin-insights-snapshot.ts'
export type {
	ActivationMilestone,
	ActivationMilestoneRecord,
	PackageRunSuccessRecord,
} from './package-activation-state.ts'
export type {
	JobRunObservabilityRecord,
	JobRunObservabilityStatus,
	JobRunObservabilityUpsertInput,
} from './job-run-observability.ts'
export type {
	WorkflowBindingName,
	WorkflowProjectionRecord,
	WorkflowProjectionReserveResult,
	WorkflowProjectionSourceType,
	WorkflowProjectionUpsertInput,
} from './workflow-projection.ts'
export {
	creatingWorkflowProjectionStatus,
	isWorkflowBindingName,
	workflowBindingNames,
	workflowProjectionActiveStatuses,
	workflowProjectionCreatingTtlMs,
	workflowProjectionReservationStatuses,
} from './workflow-projection.ts'

export async function loadWorkspaceRunCharts(input: {
	env: Env
	userId: OwnerId
	now?: Date
}) {
	const window = workspaceChartWindow(input.now)
	if (!runLogBinding(input.env)) {
		return buildWorkspaceRunCharts(window, [], null)
	}
	const { buckets, countsSince } = await runLogRpc({
		env: input.env,
		userId: input.userId,
	}).dashboardBuckets(window)
	return buildWorkspaceRunCharts(window, buckets, countsSince)
}
