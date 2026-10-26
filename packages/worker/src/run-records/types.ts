/**
 * Run records: the per-user execution history primitive.
 *
 * Every runtime surface (execute, jobs, workflows, package exports, apps,
 * subscriptions, inbound webhooks) reports what it ran and
 * how it ended through one contract. Records live in a per-user `RunLog`
 * Durable Object, not in the shared D1 writer — see
 * `docs/contributing/architecture/run-records.md`.
 *
 * Two invariants shape this module:
 *
 * - `state-vs-history`: entity rows own current state, run records own
 *   history. Never derive live state by querying run records.
 * - `no-per-event-shared-writes`: per-event writes go to Analytics Engine or
 *   a per-user Durable Object, never `APP_DB`.
 */

import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RunStartedBy } from './run-started-by.ts'

export type { RunStartedBy, RunStartedByClient } from './run-started-by.ts'
export {
	isRunStartedByClient,
	normalizeRunStartedBy,
	runStartedByClientFromCredentialKind,
	runStartedByClientValues,
	runStartedByFromRequest,
} from './run-started-by.ts'

export const runSurfaceValues = [
	'execute',
	'export',
	'subscription',
	'app_fetch',
	'app_realtime',
	'job',
	'workflow',
	'webhook',
] as const

export type RunSurface = (typeof runSurfaceValues)[number]

export const runStatusValues = ['running', 'success', 'error'] as const

export type RunStatus = (typeof runStatusValues)[number]

export type RunTerminalStatus = Exclude<RunStatus, 'running'>

/**
 * Soft triage for retained **error** runs. Separate from {@link RunStatus}
 * (execution outcome). `null` means open / not triaged. Ignored and resolved
 * runs keep their original error fields; triage only changes Activity noise.
 */
export const runErrorTriageValues = ['ignored', 'resolved'] as const

export type RunErrorTriage = (typeof runErrorTriageValues)[number]

/**
 * List/summary filter over {@link RunErrorTriage}. `open` = not ignored or
 * resolved (default for `runList` and Activity's Open errors view).
 */
export const runErrorTriageFilterValues = [
	'open',
	'ignored',
	'resolved',
	'all',
] as const

export type RunErrorTriageFilter = (typeof runErrorTriageFilterValues)[number]

/** Max length for optional triage notes set via `runUpdate`. */
export const runErrorTriageMaxNoteLength = 2000

/**
 * Stable machine-readable name for stale `running` rows reconciled after their
 * surface TTL. Consumers should treat this as platform weather, not a
 * user-authored package failure.
 */
export const runRecordPlatformInterruptedErrorName = 'platform_interrupted'

export const runRecordPlatformInterruptedErrorMessage =
	'The platform interrupted this run before completion; outcome unknown.'

/**
 * Idempotent unattended deliveries are retried by their owning scheduler,
 * queue, or webhook delivery, so retain their interrupted attempt as ignored
 * history instead of an open user-facing failure. Interactive and
 * non-idempotent attempts stay open.
 *
 * Scheduled job ticks (`scheduled-job:…`) are the exception: a stranded
 * `running` row that becomes terminal must stay owner-visible. Soft-ignoring
 * those rows hid missed slots while the scheduler advanced `next_run_at`.
 */
export function runErrorTriageForPlatformInterrupt(
	context: Pick<RunRecordContext, 'surface' | 'idempotencyKey'>,
): RunErrorTriage | null {
	const idempotencyKey = context.idempotencyKey?.trim()
	switch (context.surface) {
		case 'job':
			return null
		case 'subscription':
		case 'export':
			return idempotencyKey ? 'ignored' : null
		case 'execute':
		case 'app_fetch':
		case 'app_realtime':
		case 'workflow':
		case 'webhook':
			return null
		default: {
			const exhaustive: never = context.surface
			throw new Error(`Unhandled run surface: ${String(exhaustive)}`)
		}
	}
}

export const runLogLevelValues = [
	'debug',
	'info',
	'log',
	'warn',
	'error',
] as const

export type RunLogLevel = (typeof runLogLevelValues)[number]

/**
 * When a surface's `running` row is written.
 *
 * - `eager`: a `running` row is written at begin so an evicted or hung run is
 *   still visible, and both success and error persist.
 *   {@link runPersistenceForSurface} returns this for every surface, including
 *   `export`. Successful ad-hoc execute runs therefore show up in Activity the
 *   same way jobs and webhooks do.
 * - `on-failure`: nothing is persisted unless the run ends in `error`.
 *   {@link runPersistenceForContext} selects this only for key-less `export`
 *   (the lean host export path). That caller already holds the result
 *   inline, and the user-visible history is the parent execute, job, webhook,
 *   or app run. An execute `idempotencyKey` claims the row for replay; it does
 *   not decide whether a success is stored.
 */
export type RunPersistence = 'eager' | 'on-failure'

export function runPersistenceForSurface(surface: RunSurface): RunPersistence {
	switch (surface) {
		case 'execute':
		case 'export':
		case 'subscription':
		case 'app_fetch':
		case 'app_realtime':
		case 'job':
		case 'workflow':
		case 'webhook':
			return 'eager'
		default: {
			const exhaustive: never = surface
			throw new Error(`Unhandled run surface: ${String(exhaustive)}`)
		}
	}
}

/**
 * Everything a caller knows about a run when it starts. `packageId`/`kodyId`
 * are optional because ad-hoc execute and inline workflows have no owning
 * package — that optionality is why run records are
 * user-scoped rather than package-shaped.
 */
export type RunRecordContext = {
	surface: RunSurface
	name?: string | null
	packageId?: string | null
	kodyId?: string | null
	sourceId?: string | null
	publishedCommit?: string | null
	storageId?: string | null
	jobId?: string | null
	workflowId?: string | null
	invocationId?: string | null
	sessionId?: string | null
	idempotencyKey?: string | null
	parentRunId?: string | null
	/**
	 * Who started this run (person + client). Omitted on legacy rows and when
	 * the caller had no request context. Prefer
	 * {@link runStartedByFromRequest} at begin/claim sites.
	 */
	startedBy?: RunStartedBy | null
	metadata?: Record<string, unknown> | null
}

/**
 * Persistence for one begin/finish pair. Same as
 * {@link runPersistenceForSurface} except key-less `export` (the lean host
 * export path, which has no ledger row and returns its result inline)
 * downgrades to `on-failure`.
 */
export function runPersistenceForContext(
	context: Pick<RunRecordContext, 'surface' | 'idempotencyKey'>,
): RunPersistence {
	const key = context.idempotencyKey?.trim()
	if (context.surface === 'export' && !key) {
		return 'on-failure'
	}
	return runPersistenceForSurface(context.surface)
}

/**
 * Returned by `beginRunRecord`. The id is minted client-side and the full
 * context travels with the handle so `finishRunRecord` can upsert a complete
 * row in one RPC even when the fire-and-forget `running` insert never landed.
 * That is what keeps run recording off the request critical path.
 */
export type RunRecordHandle = {
	id: string
	userId: OwnerId
	startedAt: string
	persistence: RunPersistence
	context: RunRecordContext
}

export type RunRecord = {
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
	/**
	 * Soft triage for error runs (`ignored` / `resolved`). `null` when open or
	 * when the run is not an error.
	 */
	errorTriage: RunErrorTriage | null
	triageNote: string | null
	triagedAt: string | null
	/** User id of whoever last set triage (account owner or agent acting for them). */
	triagedBy: string | null
	/**
	 * Who started this run. `null` for legacy rows recorded before started_by
	 * existed, or when begin had no request context.
	 */
	startedBy: RunStartedBy | null
	metadata: Record<string, unknown>
	logCount: number
}

export type RunRecordLog = {
	runId: string
	sequence: number
	level: RunLogLevel
	message: string
	fields: Record<string, unknown> | null
}

/**
 * Log input accepted by `finishRunRecord`. Plain strings keep the sandbox
 * executor's existing `logs: Array<string>` shape working unchanged; the
 * object form lets surfaces that know the level record it instead of
 * flattening everything to `log`.
 */
export type RunRecordLogInput =
	| string
	| {
			level?: RunLogLevel
			message: string
			fields?: Record<string, unknown> | null
	  }

export type RunRecordFilter = {
	surface?: RunSurface | null
	status?: RunStatus | null
	packageId?: string | null
	jobId?: string | null
	/** Workflow run id (`dynwf-…` / `pkgwf-…`) from `workflows.create`. */
	workflowId?: string | null
	/** Exact match on the run's display `name` (e.g. webhook or job name). */
	name?: string | null
	/** ISO 8601 lower bound on `startedAt`, inclusive. */
	since?: string | null
	/** ISO 8601 upper bound on `startedAt`, exclusive. */
	until?: string | null
	/**
	 * Soft error-triage filter. Omit / `null` means no triage filter (all runs).
	 * User-facing `runList` and Activity pass `open` by default.
	 */
	errorTriage?: RunErrorTriageFilter | null
	/**
	 * Exact match on started-by person id (the actor who started or owns the
	 * enablement). Omit / `null` means no started-by filter.
	 */
	startedByUserId?: string | null
}

export type RunRecordPage = {
	runs: Array<RunRecord>
	/** Opaque cursor for the next page; `null` when the page is the last. */
	nextCursor: string | null
}

export type RunRecordSurfaceSummary = {
	surface: RunSurface
	total: number
	/** Open (not ignored/resolved) error count for this surface. */
	errors: number
}

export type RunRecordSummary = {
	since: string
	total: number
	/** Open (not ignored/resolved) error count — “is anything broken?”. */
	errors: number
	/** Error runs marked ignored. */
	ignored: number
	/** Error runs marked resolved. */
	resolved: number
	running: number
	bySurface: Array<RunRecordSurfaceSummary>
}

/** Persistence caps enforced inside the Durable Object, not by a global cron. */
export const runRecordRetentionDays = 30
export const runRecordMaxRunsPerUser = 2_000
export const runRecordMaxLogEntriesPerRun = 200
export const runRecordMaxTextBytes = 16 * 1024
export const runRecordMaxJsonBytes = 32 * 1024
/**
 * Bound for `metadata.result` snapshots retained on finish. Kept small so
 * per-user DO storage and the existing retention policy stay healthy; oversized
 * values are replaced with `{ __truncated__: true, preview }`.
 */
export const runRecordMaxResultSnapshotBytes = 4 * 1024
/** Max length for caller-supplied execute `idempotencyKey` values. */
export const runRecordMaxIdempotencyKeyLength = 256
export const runRecordDefaultPageSize = 25
export const runRecordMaxPageSize = 100

/**
 * Age/excess retention and stale-`running` reconciliation run every Nth
 * `finishRun` (and on the DO alarm), not on every finish.
 */
export const runRecordRetentionEveryNFinishes = 32

/**
 * Default / longest stale-`running` TTL (workflow). Prefer
 * {@link runRecordStaleRunningTtlMsForSurface} so short-lived surfaces heal
 * in minutes instead of a day.
 */
export const runRecordStaleRunningTtlMs = 24 * 60 * 60 * 1000

/**
 * Execute / export / similar sandbox surfaces default to a 90s host timeout.
 * Keep this TTL a small multiple of that budget so stranded `running` rows
 * (isolate reset, lost `waitUntil` finish, hung evaluate) self-heal soon
 * enough for Activity and keyed-execute recovery, without waiting 24h.
 */
export const runRecordStaleRunningTtlMsShortLived = 3 * 60 * 1000

/**
 * Webhook runs: ack-queue deliveries get the 5-minute background sandbox
 * budget, so a legitimate run must not be reconciled before it can finish.
 */
export const runRecordStaleRunningTtlMsBackground = 10 * 60 * 1000

/** Jobs can run longer than a single sandbox invoke; still bound the history row. */
export const runRecordStaleRunningTtlMsJob = 6 * 60 * 60 * 1000

/**
 * Scheduled-tick idempotency keys (`scheduled-job:…`) release stranded
 * `running` rows after the D1 job execution lease (10 minutes). Waiting for
 * {@link runRecordStaleRunningTtlMsJob} left occurrences soft-retrying for
 * hours, then a terminal interrupt consumed the key and dropped the slot.
 * Keep this aligned with `jobExecutionLeaseMs` in shared jobs repo.
 */
export const runRecordStaleRunningTtlMsScheduledJob = 10 * 60 * 1_000

export function isScheduledJobIdempotencyKey(
	idempotencyKey: string | null | undefined,
): boolean {
	return Boolean(idempotencyKey?.trim().startsWith('scheduled-job:'))
}

/**
 * Surface-aware stale-`running` TTL. Workflows keep the long default;
 * sandbox-backed surfaces heal after a few minutes. History only — live job
 * state lives on entity rows, not here.
 */
export function runRecordStaleRunningTtlMsForSurface(
	surface: RunSurface,
): number {
	switch (surface) {
		case 'execute':
		case 'export':
		case 'subscription':
		case 'app_fetch':
		case 'app_realtime':
			return runRecordStaleRunningTtlMsShortLived
		case 'webhook':
			return runRecordStaleRunningTtlMsBackground
		case 'job':
			return runRecordStaleRunningTtlMsJob
		case 'workflow':
			return runRecordStaleRunningTtlMs
		default: {
			const exhaustive: never = surface
			throw new Error(`Unhandled run surface: ${String(exhaustive)}`)
		}
	}
}

/** How often the DO alarm re-runs retention when the object is otherwise idle. */
export const runRecordRetentionAlarmMs = 60 * 60 * 1000

/**
 * First empty retention pass (over-cap with nothing evictable, or a due-now
 * pass that deleted no run rows) waits this long instead of 1s.
 */
export const runRecordRetentionEmptyBackoffMinMs = 15_000

/** Cap for empty-pass alarm backoff. Doubles from the min on each empty pass. */
export const runRecordRetentionEmptyBackoffMaxMs = 15 * 60 * 1000

/**
 * Keyed package-invocation idempotency ledger rows live in the same per-user
 * `RunLog` Durable Object as run records (they moved off the shared D1 writer;
 * see `docs/contributing/architecture/run-records.md`). Terminal rows keep
 * their replay responses for 90 days — the same window the legacy D1
 * `package_invocations` sweep used — and are pruned by the DO's own retention
 * passes. `in_progress` rows are never pruned so duplicate requests cannot
 * bypass the in-flight guard.
 */
export const packageInvocationLedgerRetentionDays = 90

/**
 * Terminal workflow projections keep entitlement/idempotency history for 90
 * days inside the RunLog DO (matches the legacy D1/idempotency window; separate
 * from run-list caps). Active / running rows are never age-pruned. Stale
 * `creating` reservations use a short TTL
 * ({@link workflowProjectionCreatingTtlMs} in `workflow-projection.ts`).
 */
export const workflowProjectionRetentionDays = 90
