import * as Sentry from '@sentry/cloudflare'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { BudgetLimitError, type BudgetLimitErrorDetails } from './errors.ts'
import { DurableObject } from 'cloudflare:workers'
import {
	type DurableObjectPitrRpc,
	getRecoveryBookmark,
	restoreToBookmark,
} from '#worker/dr/do-pitr.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import {
	admitExecuteCallInWindows,
	ExecuteRepeatWindow,
	type ExecuteAdmissionResult,
	type ExecuteCallMinuteWindow,
	type ExecuteRepeatInput,
} from './execute-admission-windows.ts'
import {
	isDailyEntitlementResource,
	type DailyEntitlementResource,
} from '#universal/plans.ts'

/**
 * Retention window for UserMeter daily rows (`daily_counters`,
 * `inbound_delivery_claims`, and `dynamic_worker_days`). Enforcement needs
 * today and, for execute/outbound, the current UTC week (Monday–Sunday).
 * Fourteen days covers that week plus a second week of recent history.
 */
export const userMeterDailyCounterRetentionDays = 14

const metaSchemaVersionKey = 'schema_version'
/** Bump when initializeSchema DDL changes; warm objects skip DDL. */
const userMeterSchemaVersion = 15
// How long a completed release is remembered for reset-retry idempotency.
const writeLeaseReleaseMemoryMs = 60 * 60 * 1000
/** Singleton row id for monthly org budget spend (schema v13). */
const budgetSpendStateRowId = 1
const utcMonthKeyPattern = /^\d{4}-\d{2}$/
/** Singleton row id for authoritative storage-byte state (schema v4). */
const storageBytesStateRowId = 1
/** Singleton row id for deletion fence / write leases (schema v6+). */
const deletionStateRowId = 1
const defaultExportPageSize = 100
const maxExportPageSize = 500
const maxInboundDeliveryIdLength = 256
const maxDynamicWorkerIdLength = 128
const maxInboundMcpClientIdLength = 1024
/** Keep in sync with inbound-mcp-connection-last-used.ts. */
const inboundMcpConnectionLastUsedMinIntervalMs = 5 * 60 * 1000
const maxWriteLeaseTokenLength = 64
const maxWriteLeaseHolderLength = 256
const maxWriteLeaseRepairIdLength = 64
const maxDeletionTimestampLength = 64
const inboundReceiveResource =
	'email_receives_per_day' satisfies DailyEntitlementResource
const utcDayKeyPattern = /^\d{4}-\d{2}-\d{2}$/
/**
 * D1 enumeration-inventory `updated_at` token. Lexicographic order matches
 * revision order, and `r/` sorts after ISO timestamps.
 */
export function userMeterMirrorUpdatedAtToken(revision: number): string {
	const safeRevision =
		Number.isSafeInteger(revision) && revision > 0 ? revision : 0
	return `r/${String(safeRevision).padStart(20, '0')}`
}

export type UserMeterCounterRow = {
	resource: DailyEntitlementResource
	day: string
	count: number
	revision: number
	updatedAt: string
	mirrorUpdatedAt: string
}

export type UserMeterReadyState = {
	outcome: 'ready'
	count: number
	revision: number
	mirrorUpdatedAt: string
}

export type UserMeterBootstrapState = {
	outcome: 'needs_bootstrap'
}

export type UserMeterDeniedWindow = 'day' | 'week'

export type UserMeterConsumeResult =
	| UserMeterBootstrapState
	| (UserMeterReadyState & {
			consumed: boolean
			deniedWindow?: UserMeterDeniedWindow
			weekCount?: number
	  })

/**
 * Result of {@link UserMeterRpc.claimDynamicWorkerDayWithinLimit}. `created`
 * means this call loads a new worker for the day and spent one unit; a
 * repeat of an already-claimed id returns `created: false` without spending.
 * A denial (`consumed: false` with `deniedWindow`) leaves the id unclaimed.
 */
export type UserMeterWorkerDayConsumeResult =
	| UserMeterBootstrapState
	| (UserMeterReadyState & {
			created: boolean
			consumed: boolean
			deniedWindow?: UserMeterDeniedWindow
			weekCount?: number
	  })

export type UserMeterExecuteAdmissionResult = ExecuteAdmissionResult

export type UserMeterReadResult = UserMeterBootstrapState | UserMeterReadyState

/** One daily counter entry from {@link UserMeterRpc.readUsageSnapshot}. */
export type UserMeterUsageSnapshotDailyEntry = {
	resource: DailyEntitlementResource
} & UserMeterReadResult

/** One weekly window sum from {@link UserMeterRpc.readUsageSnapshot}. */
export type UserMeterUsageSnapshotWeeklyEntry = {
	resource: DailyEntitlementResource
	outcome: 'ready'
	count: number
}

/**
 * Combined meter read for entitlement usage snapshots: daily counters for
 * `day`, weekly sums from `weekStart` through `day`, and optional storage
 * bytes. Missing daily keys and a missing storage singleton still report
 * `needs_bootstrap` so callers can cold-init the same way as point reads.
 */
export type UserMeterUsageSnapshotResult = {
	daily: Array<UserMeterUsageSnapshotDailyEntry>
	weekly: Array<UserMeterUsageSnapshotWeeklyEntry>
	storageBytes: UserMeterStorageBytesReadResult | null
}

/**
 * One remaining daily_counters row inside the retention window. Missing days
 * are omitted (callers treat absence as zero).
 */
export type UserMeterDailyTrendCounterRow = {
	resource: DailyEntitlementResource
	day: string
	count: number
}

/** Per-UTC-day unique Dynamic Worker claim count (first-claim rows). */
export type UserMeterDailyTrendUniqueWorkerDayRow = {
	day: string
	count: number
}

/**
 * Compact retention-window read for customer usage charts: remaining
 * daily_counters rows plus unique-worker-day claim counts grouped by day.
 * Does not bootstrap missing keys — absence means zero.
 */
export type UserMeterBudgetSpendState = {
	month: string
	users: Record<string, number>
	automationMicroUsd: number
}

export type UserMeterDailyTrendResult = {
	retentionDays: number
	startDay: string
	endDay: string
	counters: Array<UserMeterDailyTrendCounterRow>
	uniqueWorkerDays: Array<UserMeterDailyTrendUniqueWorkerDayRow>
	/** Admitted hosted execute calls per UTC day, repeats included. */
	executeCalls: Array<UserMeterDailyTrendUniqueWorkerDayRow>
}

export type UserMeterRefundResult = UserMeterReadyState

export type UserMeterInitializeResult = UserMeterReadyState & {
	created: boolean
}

export type UserMeterStorageBytesState = {
	bytes: number
	revision: number
	updatedAt: string
	mirrorUpdatedAt: string
}

export type UserMeterStorageBytesReadyState = {
	outcome: 'ready'
	bytes: number
	revision: number
	mirrorUpdatedAt: string
}

export type UserMeterStorageBytesReadResult =
	| UserMeterBootstrapState
	| UserMeterStorageBytesReadyState

export type UserMeterStorageBytesReserveResult =
	| UserMeterBootstrapState
	| (UserMeterStorageBytesReadyState & { reserved: boolean })

export type UserMeterStorageBytesInitializeResult =
	UserMeterStorageBytesReadyState & {
		created: boolean
	}

export type UserMeterStorageBytesSetResult = UserMeterStorageBytesReadyState & {
	created: boolean
}

/**
 * Result of a revision-guarded absolute reconciliation CAS.
 * `needs_bootstrap` when the singleton is absent; `applied` distinguishes a
 * successful overwrite from a CAS miss caused by a concurrent reserve.
 */
export type UserMeterStorageBytesReconcileResult =
	| UserMeterBootstrapState
	| (UserMeterStorageBytesReadyState & { applied: boolean })

/** Paged write-lease entry returned by {@link UserMeterRpc.listWriteLeases}. */
export type UserMeterWriteLeaseEntry = {
	token: string
	holder: string
	acquiredAt: string
}

/**
 * Account-export deletion inventory. Omits raw lease token and holder; retains
 * only deleting tombstone presence, active lease count, and acquired_at.
 */
export type UserMeterDeletionStateExport = {
	deletingAt: string | null
	activeWriteLeaseCount: number
	writeLeases: Array<{ acquiredAt: string }>
}

export type UserMeterMarkDeletingResult = {
	deletingAt: string
	created: boolean
	/** Count of active write leases (DO-authority rows) at the time of marking. */
	leaseCount: number
}

export type UserMeterClearDeletingResult = {
	cleared: boolean
}

export type UserMeterAcquireWriteLeaseResult = {
	acquired: boolean
}

export type UserMeterReleaseWriteLeaseResult = {
	released: boolean
}

export type UserMeterAssertWriteLeaseHeldResult = {
	held: boolean
}

export type UserMeterPrepareWriteLeaseRepairResult =
	| {
			prepared: true
			repairId: string
			token: string
			holder: string
			acquiredAt: string
	  }
	| { prepared: false }

export type UserMeterFinalizeWriteLeaseRepairResult = {
	finalized: boolean
}

export type UserMeterWriteLeaseListResult = {
	leases: Array<UserMeterWriteLeaseEntry>
	nextStartAfter: string | null
	truncated: boolean
}

export type UserMeterWriteLeaseCountResult = {
	count: number
}

export type UserMeterInboundConnectionLastUsedRow = {
	clientId: string
	lastUsedAt: string
}

export type UserMeterExportResult = {
	counters: Array<UserMeterCounterRow>
	/**
	 * Authoritative storage-byte state. Emitted only on the first export page
	 * (`startAfter` absent); subsequent pages return `null` so paged consumers
	 * never double-count it.
	 */
	storageBytesState: UserMeterStorageBytesState | null
	/**
	 * Sanitized deletion-fence / write-lease inventory. Emitted only on the
	 * first export page (`startAfter` absent); subsequent pages return `null`
	 * so paged consumers never double-count. Excludes raw lease token and
	 * holder (see {@link UserMeterDeletionStateExport}).
	 */
	deletionState: UserMeterDeletionStateExport | null
	/**
	 * Inbound MCP OAuth `clientId` last-heard times. Emitted only on the first
	 * export page (`startAfter` absent); subsequent pages return `null`.
	 */
	inboundConnectionLastUsed: Array<UserMeterInboundConnectionLastUsedRow> | null
	nextStartAfter: string | null
	truncated: boolean
}

/**
 * Inbound delivery claim + receive consume. Retries set `replayed` without
 * incrementing; `day`/`resource` come from the original claim on cross-day
 * retries.
 */
export type UserMeterInboundDeliveryConsumeResult =
	| UserMeterBootstrapState
	| (UserMeterReadyState & {
			consumed: boolean
			replayed: boolean
			day: string
			resource: typeof inboundReceiveResource
	  })

type ExportCursor = {
	day: string
	resource: string
}

type WriteLeaseExportCursor = {
	acquiredAt: string
	token: string
}

type WriteLeaseSqlRow = {
	token: string
	holder: string
	acquired_at: string
	pending_repair_id: string | null
}

function assertDailyResource(resource: string): DailyEntitlementResource {
	if (!isDailyEntitlementResource(resource)) {
		throw new Error(
			`UserMeter resource must be a daily entitlement resource; got ${JSON.stringify(resource)}.`,
		)
	}
	return resource
}

function assertInboundReceiveResource(
	resource: string,
): typeof inboundReceiveResource {
	const daily = assertDailyResource(resource)
	if (daily !== inboundReceiveResource) {
		throw new Error(
			`UserMeter inbound delivery consume requires ${inboundReceiveResource}; got ${JSON.stringify(resource)}.`,
		)
	}
	return daily
}

function assertUtcDayKey(day: string): string {
	if (!utcDayKeyPattern.test(day)) {
		throw new Error(
			`UserMeter day must be a UTC YYYY-MM-DD key; got ${JSON.stringify(day)}.`,
		)
	}
	return day
}

function assertUtcMonthKey(month: string): string {
	if (!utcMonthKeyPattern.test(month)) {
		throw new Error(
			`UserMeter month must be a UTC YYYY-MM key; got ${JSON.stringify(month)}.`,
		)
	}
	return month
}

function throwBudgetLimit(details: Omit<BudgetLimitErrorDetails, 'code'>) {
	throw new BudgetLimitError(details)
}

function assertInboundDeliveryId(deliveryId: string): string {
	if (
		typeof deliveryId !== 'string' ||
		deliveryId.length === 0 ||
		deliveryId.length > maxInboundDeliveryIdLength
	) {
		throw new Error(
			`UserMeter inbound deliveryId must be a non-empty string up to ${maxInboundDeliveryIdLength} characters.`,
		)
	}
	return deliveryId
}

function assertDynamicWorkerId(workerId: string): string {
	if (
		typeof workerId !== 'string' ||
		workerId.length === 0 ||
		workerId.length > maxDynamicWorkerIdLength
	) {
		throw new Error(
			`UserMeter dynamic worker id must be a non-empty string up to ${maxDynamicWorkerIdLength} characters.`,
		)
	}
	return workerId
}

function assertInboundMcpClientId(clientId: string): string {
	if (
		typeof clientId !== 'string' ||
		clientId.length === 0 ||
		clientId.length > maxInboundMcpClientIdLength
	) {
		throw new Error(
			`UserMeter inbound MCP client id must be a non-empty string up to ${maxInboundMcpClientIdLength} characters.`,
		)
	}
	return clientId
}

function assertInboundMcpLastUsedAt(lastUsedAt: string): string {
	if (
		typeof lastUsedAt !== 'string' ||
		lastUsedAt.length === 0 ||
		lastUsedAt.length > maxDeletionTimestampLength ||
		!Number.isFinite(Date.parse(lastUsedAt))
	) {
		throw new Error(
			`UserMeter inbound MCP last-used timestamp must be an ISO datetime; got ${JSON.stringify(lastUsedAt)}.`,
		)
	}
	return lastUsedAt
}

function assertDeletionTimestamp(label: string, value: string): string {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > maxDeletionTimestampLength
	) {
		throw new Error(
			`UserMeter ${label} must be a non-empty string up to ${maxDeletionTimestampLength} characters.`,
		)
	}
	return value
}

function assertWriteLeaseToken(token: string): string {
	if (
		typeof token !== 'string' ||
		token.length === 0 ||
		token.length > maxWriteLeaseTokenLength
	) {
		throw new Error(
			`UserMeter write lease token must be a non-empty string up to ${maxWriteLeaseTokenLength} characters.`,
		)
	}
	return token
}

function assertWriteLeaseHolder(holder: string): string {
	if (
		typeof holder !== 'string' ||
		holder.length === 0 ||
		holder.length > maxWriteLeaseHolderLength
	) {
		throw new Error(
			`UserMeter write lease holder must be a non-empty string up to ${maxWriteLeaseHolderLength} characters.`,
		)
	}
	return holder
}

function assertWriteLeaseRepairId(repairId: string): string {
	if (
		typeof repairId !== 'string' ||
		repairId.length === 0 ||
		repairId.length > maxWriteLeaseRepairIdLength
	) {
		throw new Error(
			`UserMeter write lease repairId must be a non-empty string up to ${maxWriteLeaseRepairIdLength} characters.`,
		)
	}
	return repairId
}

function retentionCutoffDay(now: Date): string {
	const cutoff = new Date(now)
	cutoff.setUTCDate(
		cutoff.getUTCDate() - (userMeterDailyCounterRetentionDays - 1),
	)
	return utcDayKey(cutoff)
}

function encodeExportCursor(cursor: ExportCursor) {
	return JSON.stringify([cursor.day, cursor.resource])
}

function decodeExportCursor(startAfter: string): ExportCursor | null {
	try {
		const parsed = JSON.parse(startAfter) as unknown
		if (!Array.isArray(parsed) || parsed.length !== 2) return null
		const [day, resource] = parsed
		if (typeof day !== 'string' || typeof resource !== 'string') return null
		return { day, resource }
	} catch {
		return null
	}
}

function encodeWriteLeaseCursor(cursor: WriteLeaseExportCursor) {
	return JSON.stringify([cursor.acquiredAt, cursor.token])
}

function decodeWriteLeaseCursor(
	startAfter: string,
): WriteLeaseExportCursor | null {
	try {
		const parsed = JSON.parse(startAfter) as unknown
		if (!Array.isArray(parsed) || parsed.length !== 2) return null
		const [acquiredAt, token] = parsed
		if (typeof acquiredAt !== 'string' || typeof token !== 'string') {
			return null
		}
		return { acquiredAt, token }
	} catch {
		return null
	}
}

function normalizePageSize(pageSize: number | undefined) {
	const requested =
		typeof pageSize === 'number' && Number.isFinite(pageSize)
			? Math.trunc(pageSize)
			: defaultExportPageSize
	return Math.min(Math.max(requested, 1), maxExportPageSize)
}

function readyState(count: number, revision: number): UserMeterReadyState {
	const safeCount = Math.max(0, count)
	const safeRevision = Math.max(0, revision)
	return {
		outcome: 'ready',
		count: safeCount,
		revision: safeRevision,
		mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(safeRevision),
	}
}

class UserMeterBase extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.ctx.blockConcurrencyWhile(async () => {
			this.initializeSchema()
		})
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
			objectKind: 'user-meter',
			environment: this.env,
		})
	}

	private initializeSchema() {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS user_meter_meta (
				key TEXT PRIMARY KEY NOT NULL,
				value INTEGER NOT NULL
			)
		`)
		const versionRow = this.ctx.storage.sql
			.exec<{
				value: number
			}>(
				`SELECT value FROM user_meter_meta WHERE key = ? LIMIT 1`,
				metaSchemaVersionKey,
			)
			.toArray()[0]
		const version = versionRow == null ? null : Number(versionRow.value) || 0
		if (version === userMeterSchemaVersion) return

		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS daily_counters (
				resource TEXT NOT NULL,
				day TEXT NOT NULL,
				count INTEGER NOT NULL,
				revision INTEGER NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (resource, day)
			)
		`)
		if (version === 1) {
			try {
				this.ctx.storage.sql.exec(
					`ALTER TABLE daily_counters ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`,
				)
			} catch {
				// Column already present on a partially migrated object.
			}
		}
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_daily_counters_day
			ON daily_counters (day)`,
		)
		// Per-user delivery-id ledger (PK is delivery_id alone); same retention
		// window as daily counters so Email Routing retries cannot double-charge.
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS inbound_delivery_claims (
				delivery_id TEXT PRIMARY KEY NOT NULL,
				resource TEXT NOT NULL,
				day TEXT NOT NULL,
				count_after INTEGER NOT NULL,
				revision INTEGER NOT NULL,
				claimed_at TEXT NOT NULL
			)
		`)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_inbound_delivery_claims_day
			ON inbound_delivery_claims (day)`,
		)
		// Authoritative storage-byte state (schema v4).
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS storage_bytes_state (
				id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
				bytes INTEGER NOT NULL,
				revision INTEGER NOT NULL,
				updated_at TEXT NOT NULL
			)
		`)
		if (version != null && version < 10) {
			this.ctx.storage.sql.exec(
				`DROP INDEX IF EXISTS idx_package_service_states_status_source`,
			)
			this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS package_service_states`)
		}
		// Deletion fence / write leases (schema v6+; pending_repair_id added at v7).
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS deletion_state (
				id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
				deleting_at TEXT NOT NULL
			)
		`)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS account_write_leases (
				token TEXT PRIMARY KEY NOT NULL,
				holder TEXT NOT NULL,
				acquired_at TEXT NOT NULL,
				pending_repair_id TEXT
			)
		`)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS account_write_lease_releases (
				token TEXT PRIMARY KEY NOT NULL,
				released_at TEXT NOT NULL
			)
		`)
		if (version != null && version < 7) {
			try {
				this.ctx.storage.sql.exec(
					`ALTER TABLE account_write_leases
					ADD COLUMN pending_repair_id TEXT`,
				)
			} catch {
				// Column already present on a partially migrated object.
			}
		}
		if (version === 7) {
			// Some warm v7 objects retain an ignored `authority` column and
			// index. Rebuild the table so both v7 physical variants converge on
			// the final four-column lease schema without losing active leases.
			this.ctx.storage.transactionSync(() => {
				this.ctx.storage.sql.exec(
					`DROP INDEX IF EXISTS idx_account_write_leases_authority_acquired_token`,
				)
				this.ctx.storage.sql.exec(
					`CREATE TABLE account_write_leases_v8 (
						token TEXT PRIMARY KEY NOT NULL,
						holder TEXT NOT NULL,
						acquired_at TEXT NOT NULL,
						pending_repair_id TEXT
					)`,
				)
				this.ctx.storage.sql.exec(
					`INSERT INTO account_write_leases_v8 (
						token, holder, acquired_at, pending_repair_id
					)
					SELECT token, holder, acquired_at, pending_repair_id
					FROM account_write_leases`,
				)
				this.ctx.storage.sql.exec(`DROP TABLE account_write_leases`)
				this.ctx.storage.sql.exec(
					`ALTER TABLE account_write_leases_v8
					RENAME TO account_write_leases`,
				)
			})
		}
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_account_write_leases_acquired_token
			ON account_write_leases (acquired_at, token)`,
		)
		// Unique Dynamic Worker ids per UTC day (schema v11). Used to emit
		// one `dynamic_worker_day` usage event per (user, worker, day) so
		// Cloudflare unique-worker billing can be attributed without
		// exporting the hashed worker ids.
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS dynamic_worker_days (
				worker_id TEXT NOT NULL,
				day TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (day, worker_id)
			)
		`)
		// Last successful MCP bearer validation per inbound OAuth clientId
		// (schema v12). Account → Connections reads this as last-used.
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS inbound_mcp_connection_last_used (
				client_id TEXT PRIMARY KEY NOT NULL,
				last_used_at TEXT NOT NULL
			)
		`)
		// Monthly org budget spend counters (schema v13).
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS budget_spend_state (
				id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
				month TEXT NOT NULL,
				automation_micro_usd INTEGER NOT NULL DEFAULT 0
			)
		`)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS budget_spend_users (
				user_id TEXT PRIMARY KEY NOT NULL,
				micro_usd INTEGER NOT NULL
			)
		`)
		// Admitted hosted execute calls per UTC day (schema v14). The plan cap
		// counts unique workers; this keeps the per-call usage trend.
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS execute_call_days (
				day TEXT PRIMARY KEY NOT NULL,
				count INTEGER NOT NULL
			)
		`)
		this.ctx.storage.sql.exec(
			`INSERT INTO user_meter_meta (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			metaSchemaVersionKey,
			userMeterSchemaVersion,
		)
	}

	private storageReadyState(
		bytes: number,
		revision: number,
	): UserMeterStorageBytesReadyState {
		const safeBytes = Math.max(0, bytes)
		const safeRevision = Math.max(0, revision)
		return {
			outcome: 'ready',
			bytes: safeBytes,
			revision: safeRevision,
			mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(safeRevision),
		}
	}

	private readStorageRow(): {
		bytes: number
		revision: number
		updatedAt: string
	} | null {
		const row = this.ctx.storage.sql
			.exec<{ bytes: number; revision: number; updated_at: string }>(
				`SELECT bytes, revision, updated_at
				FROM storage_bytes_state
				WHERE id = ?`,
				storageBytesStateRowId,
			)
			.toArray()[0]
		if (!row) return null
		return {
			bytes: Math.max(0, Number(row.bytes ?? 0)),
			revision: Math.max(0, Number(row.revision ?? 0)),
			updatedAt: String(row.updated_at ?? ''),
		}
	}

	private deleteStaleCounters(now: Date) {
		const cutoffDay = retentionCutoffDay(now)
		this.ctx.storage.sql.exec(
			`DELETE FROM daily_counters WHERE day < ?`,
			cutoffDay,
		)
		this.ctx.storage.sql.exec(
			`DELETE FROM inbound_delivery_claims WHERE day < ?`,
			cutoffDay,
		)
		this.ctx.storage.sql.exec(
			`DELETE FROM dynamic_worker_days WHERE day < ?`,
			cutoffDay,
		)
		this.ctx.storage.sql.exec(
			`DELETE FROM execute_call_days WHERE day < ?`,
			cutoffDay,
		)
	}

	private readInboundDeliveryClaim(deliveryId: string): {
		resource: string
		day: string
		countAfter: number
		revision: number
		claimedAt: string
	} | null {
		const row = this.ctx.storage.sql
			.exec<{
				resource: string
				day: string
				count_after: number
				revision: number
				claimed_at: string
			}>(
				`SELECT resource, day, count_after, revision, claimed_at
				FROM inbound_delivery_claims
				WHERE delivery_id = ?`,
				deliveryId,
			)
			.toArray()[0]
		if (!row) return null
		return {
			resource: String(row.resource),
			day: String(row.day),
			countAfter: Math.max(0, Number(row.count_after ?? 0)),
			revision: Math.max(0, Number(row.revision ?? 0)),
			claimedAt: String(row.claimed_at ?? ''),
		}
	}

	private readRow(
		resource: DailyEntitlementResource,
		day: string,
	): { count: number; revision: number; updatedAt: string } | null {
		const row = this.ctx.storage.sql
			.exec<{ count: number; revision: number; updated_at: string }>(
				`SELECT count, revision, updated_at
				FROM daily_counters
				WHERE resource = ? AND day = ?`,
				resource,
				day,
			)
			.toArray()[0]
		if (!row) return null
		return {
			count: Math.max(0, Number(row.count ?? 0)),
			revision: Math.max(0, Number(row.revision ?? 0)),
			updatedAt: String(row.updated_at ?? ''),
		}
	}

	private sumRange(
		resource: DailyEntitlementResource,
		startDay: string,
		endDay: string,
	): number {
		const row = this.ctx.storage.sql
			.exec<{ total: number }>(
				`SELECT COALESCE(SUM(count), 0) AS total
				FROM daily_counters
				WHERE resource = ? AND day >= ? AND day <= ?`,
				resource,
				startDay,
				endDay,
			)
			.toArray()[0]
		return Math.max(0, Number(row?.total ?? 0))
	}

	/** Cold-key seed at zero; INSERT OR IGNORE is concurrency-safe. */
	async initialize(input: {
		resource: string
		day: string
		count: number
		updatedAt: string
	}): Promise<UserMeterInitializeResult> {
		const resource = assertDailyResource(input.resource)
		const day = assertUtcDayKey(input.day)
		const now = new Date(input.updatedAt)
		this.deleteStaleCounters(Number.isNaN(now.valueOf()) ? new Date() : now)
		const count = Math.max(0, Math.trunc(Number(input.count) || 0))
		const cursor = this.ctx.storage.sql.exec(
			`INSERT INTO daily_counters (resource, day, count, revision, updated_at)
			VALUES (?, ?, ?, 1, ?)
			ON CONFLICT(resource, day) DO NOTHING`,
			resource,
			day,
			count,
			input.updatedAt,
		)
		const created = cursor.rowsWritten > 0
		const row = this.readRow(resource, day)
		if (!row) {
			throw new Error(
				'UserMeter initialize failed to materialize a counter row.',
			)
		}
		return { ...readyState(row.count, row.revision), created }
	}

	/** Check-and-increment one unit; missing keys return `needs_bootstrap`. */
	async consume(input: {
		resource: string
		day: string
		limit: number
		updatedAt: string
		weekStart?: string
		weekLimit?: number | null
	}): Promise<UserMeterConsumeResult> {
		const resource = assertDailyResource(input.resource)
		const day = assertUtcDayKey(input.day)
		const now = new Date(input.updatedAt)
		this.deleteStaleCounters(Number.isNaN(now.valueOf()) ? new Date() : now)

		const existing = this.readRow(resource, day)
		if (!existing) {
			return { outcome: 'needs_bootstrap' }
		}

		const window = this.checkDailyWindows({ ...input, resource, day, existing })
		if (window.deniedWindow) {
			return {
				...readyState(existing.count, existing.revision),
				consumed: false,
				deniedWindow: window.deniedWindow,
				weekCount: window.weekCount,
			}
		}

		const nextCount = existing.count + 1
		const nextRevision = existing.revision + 1
		this.incrementCounterRow({
			resource,
			day,
			existing,
			updatedAt: input.updatedAt,
		})
		const row = this.readRow(resource, day)
		if (!row) {
			throw new Error('UserMeter consume lost the counter row.')
		}
		return {
			...readyState(row.count, row.revision),
			consumed: row.count === nextCount && row.revision === nextRevision,
			weekCount:
				window.weekCount === undefined ? undefined : window.weekCount + 1,
		}
	}

	/**
	 * Claim `workerId` for `day` and spend one `resource` unit only when the
	 * claim is new. A repeat of an id already claimed today (by any surface)
	 * is free; a new id over the daily or weekly limit is denied and stays
	 * unclaimed, so a later retry after the window resets still counts. The
	 * counter increment and the claim insert commit together.
	 */
	async claimDynamicWorkerDayWithinLimit(input: {
		workerId: string
		resource: string
		day: string
		limit: number
		createdAt: string
		weekStart?: string
		weekLimit?: number | null
	}): Promise<UserMeterWorkerDayConsumeResult> {
		const workerId = assertDynamicWorkerId(input.workerId)
		const resource = assertDailyResource(input.resource)
		const day = assertUtcDayKey(input.day)
		const now = new Date(input.createdAt)
		this.deleteStaleCounters(Number.isNaN(now.valueOf()) ? new Date() : now)

		const existing = this.readRow(resource, day)
		const alreadyClaimed =
			this.ctx.storage.sql
				.exec(
					`SELECT 1 FROM dynamic_worker_days WHERE day = ? AND worker_id = ?`,
					day,
					workerId,
				)
				.toArray().length > 0
		if (alreadyClaimed) {
			const weekStart = input.weekStart
				? assertUtcDayKey(input.weekStart)
				: null
			return {
				...readyState(existing?.count ?? 0, existing?.revision ?? 0),
				created: false,
				consumed: false,
				weekCount: weekStart
					? this.sumRange(resource, weekStart, day)
					: undefined,
			}
		}
		if (!existing) {
			return { outcome: 'needs_bootstrap' }
		}

		const window = this.checkDailyWindows({
			...input,
			resource,
			day,
			existing,
		})
		if (window.deniedWindow) {
			return {
				...readyState(existing.count, existing.revision),
				created: false,
				consumed: false,
				deniedWindow: window.deniedWindow,
				weekCount: window.weekCount,
			}
		}

		this.ctx.storage.transactionSync(() => {
			const counted = this.incrementCounterRow({
				resource,
				day,
				existing,
				updatedAt: input.createdAt,
			})
			// Throwing rolls back the claim so a worker is never free-loaded.
			if (counted < 1) {
				throw new Error('UserMeter worker-day consume lost the revision race.')
			}
			this.ctx.storage.sql.exec(
				`INSERT INTO dynamic_worker_days (worker_id, day, created_at)
				VALUES (?, ?, ?)`,
				workerId,
				day,
				input.createdAt,
			)
		})
		const row = this.readRow(resource, day)
		if (!row) {
			throw new Error('UserMeter worker-day consume lost the counter row.')
		}
		return {
			...readyState(row.count, row.revision),
			created: true,
			consumed: true,
			weekCount:
				window.weekCount === undefined ? undefined : window.weekCount + 1,
		}
	}

	/**
	 * Per-minute runaway brake and identical-call loop brake for hosted
	 * execute calls. Held in memory: an evicted meter starts both windows
	 * over, which only ever admits more, so these stay safety nets rather
	 * than billed counters. A refused call is not counted in either window.
	 */
	async admitExecuteCall(input: {
		nowMs: number
		limitPerMinute: number
		repeat?: ExecuteRepeatInput
	}): Promise<UserMeterExecuteAdmissionResult> {
		const result = admitExecuteCallInWindows({
			...input,
			minuteWindow: this.executeCallMinute,
			repeatWindow: this.executeRepeatWindow,
		})
		if (result.admitted) {
			this.ctx.storage.sql.exec(
				`INSERT INTO execute_call_days (day, count) VALUES (?, 1)
				ON CONFLICT(day) DO UPDATE SET count = count + 1`,
				utcDayKey(new Date(input.nowMs)),
			)
		}
		return result
	}

	private readonly executeCallMinute: ExecuteCallMinuteWindow = {
		minute: 0,
		count: 0,
	}

	private readonly executeRepeatWindow = new ExecuteRepeatWindow()

	private checkDailyWindows(input: {
		resource: DailyEntitlementResource
		day: string
		limit: number
		weekStart?: string
		weekLimit?: number | null
		existing: { count: number }
	}): { deniedWindow?: UserMeterDeniedWindow; weekCount?: number } {
		const weekLimit =
			typeof input.weekLimit === 'number' && Number.isFinite(input.weekLimit)
				? input.weekLimit
				: null
		const weekStart = input.weekStart ? assertUtcDayKey(input.weekStart) : null
		const weekCount =
			weekStart && weekLimit !== null
				? this.sumRange(input.resource, weekStart, input.day)
				: undefined
		if (input.limit < 1 || input.existing.count + 1 > input.limit) {
			return { deniedWindow: 'day', weekCount }
		}
		if (
			weekStart &&
			weekLimit !== null &&
			(weekLimit < 1 || (weekCount ?? 0) + 1 > weekLimit)
		) {
			return { deniedWindow: 'week', weekCount }
		}
		return { weekCount }
	}

	private incrementCounterRow(input: {
		resource: DailyEntitlementResource
		day: string
		existing: { count: number; revision: number }
		updatedAt: string
	}): number {
		return this.ctx.storage.sql.exec(
			`UPDATE daily_counters
			SET count = ?,
				revision = ?,
				updated_at = ?
			WHERE resource = ? AND day = ? AND revision = ?`,
			input.existing.count + 1,
			input.existing.revision + 1,
			input.updatedAt,
			input.resource,
			input.day,
			input.existing.revision,
		).rowsWritten
	}

	/**
	 * Sum daily counts for `resource` from `startDay` through `endDay`
	 * inclusive. Missing days count as zero.
	 */
	async readRange(input: {
		resource: string
		startDay: string
		endDay: string
		now?: string
	}): Promise<{ outcome: 'ready'; count: number }> {
		const resource = assertDailyResource(input.resource)
		const startDay = assertUtcDayKey(input.startDay)
		const endDay = assertUtcDayKey(input.endDay)
		const now = input.now ? new Date(input.now) : new Date()
		this.deleteStaleCounters(Number.isNaN(now.valueOf()) ? new Date() : now)
		return {
			outcome: 'ready',
			count: this.sumRange(resource, startDay, endDay),
		}
	}

	async read(input: {
		resource: string
		day: string
		now?: string
	}): Promise<UserMeterReadResult> {
		const resource = assertDailyResource(input.resource)
		const day = assertUtcDayKey(input.day)
		const now = input.now ? new Date(input.now) : new Date()
		this.deleteStaleCounters(Number.isNaN(now.valueOf()) ? new Date() : now)
		const row = this.readRow(resource, day)
		if (!row) return { outcome: 'needs_bootstrap' }
		return readyState(row.count, row.revision)
	}

	/**
	 * One-RPC read of every daily counter, weekly window, and optional storage
	 * bytes an entitlement usage snapshot needs. Prunes stale counters once.
	 * Missing daily keys and a missing storage singleton still return
	 * `needs_bootstrap` so callers can cold-init the same way as {@link read}
	 * / {@link readStorageBytes}; this method does not write.
	 */
	async readUsageSnapshot(input: {
		day: string
		weekStart: string
		dailyResources: ReadonlyArray<string>
		weeklyResources: ReadonlyArray<string>
		includeStorageBytes?: boolean
		now?: string
	}): Promise<UserMeterUsageSnapshotResult> {
		const day = assertUtcDayKey(input.day)
		const weekStart = assertUtcDayKey(input.weekStart)
		if (weekStart > day) {
			throw new Error(
				`UserMeter readUsageSnapshot weekStart ${JSON.stringify(weekStart)} is after day ${JSON.stringify(day)}.`,
			)
		}
		const now = input.now ? new Date(input.now) : new Date()
		this.deleteStaleCounters(Number.isNaN(now.valueOf()) ? new Date() : now)

		const daily: Array<UserMeterUsageSnapshotDailyEntry> = []
		for (const raw of input.dailyResources) {
			const resource = assertDailyResource(raw)
			const row = this.readRow(resource, day)
			daily.push(
				row
					? { resource, ...readyState(row.count, row.revision) }
					: { resource, outcome: 'needs_bootstrap' },
			)
		}

		const weekly: Array<UserMeterUsageSnapshotWeeklyEntry> = []
		for (const raw of input.weeklyResources) {
			const resource = assertDailyResource(raw)
			weekly.push({
				resource,
				outcome: 'ready',
				count: this.sumRange(resource, weekStart, day),
			})
		}

		const storageBytes = input.includeStorageBytes
			? (() => {
					const row = this.readStorageRow()
					if (!row) return { outcome: 'needs_bootstrap' as const }
					return this.storageReadyState(row.bytes, row.revision)
				})()
			: null

		return { daily, weekly, storageBytes }
	}

	/**
	 * Compact read of remaining daily entitlement counters and unique Dynamic
	 * Worker claim counts for the retention window ending at `now`. Prunes
	 * once. Does not write counters or bootstrap missing keys — callers treat
	 * absent days/resources as zero.
	 */
	async readDailyTrend(input?: {
		now?: string
	}): Promise<UserMeterDailyTrendResult> {
		const now = input?.now ? new Date(input.now) : new Date()
		const safeNow = Number.isNaN(now.valueOf()) ? new Date() : now
		this.deleteStaleCounters(safeNow)
		const endDay = utcDayKey(safeNow)
		const startDay = retentionCutoffDay(safeNow)

		const counterRows = this.ctx.storage.sql
			.exec<{
				resource: string
				day: string
				count: number
			}>(
				`SELECT resource, day, count
				FROM daily_counters
				WHERE day >= ? AND day <= ?
				ORDER BY day ASC, resource ASC`,
				startDay,
				endDay,
			)
			.toArray()

		const counters: Array<UserMeterDailyTrendCounterRow> = []
		for (const row of counterRows) {
			const resource = String(row.resource)
			if (!isDailyEntitlementResource(resource)) continue
			counters.push({
				resource,
				day: String(row.day),
				count: Math.max(0, Number(row.count ?? 0)),
			})
		}

		const uniqueWorkerDayRows = this.ctx.storage.sql
			.exec<{
				day: string
				count: number
			}>(
				`SELECT day, COUNT(*) AS count
				FROM dynamic_worker_days
				WHERE day >= ? AND day <= ?
				GROUP BY day
				ORDER BY day ASC`,
				startDay,
				endDay,
			)
			.toArray()

		const uniqueWorkerDays: Array<UserMeterDailyTrendUniqueWorkerDayRow> =
			uniqueWorkerDayRows.map((row) => ({
				day: String(row.day),
				count: Math.max(0, Number(row.count ?? 0)),
			}))

		const executeCalls = this.ctx.storage.sql
			.exec<{ day: string; count: number }>(
				`SELECT day, SUM(count) AS count
				FROM execute_call_days
				WHERE day >= ? AND day <= ?
				GROUP BY day
				ORDER BY day ASC`,
				startDay,
				endDay,
			)
			.toArray()
			.map((row) => ({
				day: String(row.day),
				count: Math.max(0, Number(row.count ?? 0)),
			}))

		return {
			retentionDays: userMeterDailyCounterRetentionDays,
			startDay,
			endDay,
			counters,
			uniqueWorkerDays,
			executeCalls,
		}
	}

	/**
	 * Claim `deliveryId` and consume one receive unit. Increment + claim insert
	 * run in `storage.transactionSync`.
	 */
	async consumeInboundDelivery(input: {
		deliveryId: string
		resource: string
		day: string
		limit: number
		updatedAt: string
	}): Promise<UserMeterInboundDeliveryConsumeResult> {
		const resource = assertInboundReceiveResource(input.resource)
		const day = assertUtcDayKey(input.day)
		const deliveryId = assertInboundDeliveryId(input.deliveryId)
		const now = new Date(input.updatedAt)
		this.deleteStaleCounters(Number.isNaN(now.valueOf()) ? new Date() : now)

		const priorClaim = this.readInboundDeliveryClaim(deliveryId)
		if (priorClaim) {
			if (priorClaim.resource !== resource) {
				throw new Error(
					`UserMeter inbound deliveryId was claimed for ${JSON.stringify(priorClaim.resource)}; cannot reuse for ${JSON.stringify(resource)}.`,
				)
			}
			const claimedResource = assertInboundReceiveResource(priorClaim.resource)
			const claimedDay = assertUtcDayKey(priorClaim.day)
			const row = this.readRow(claimedResource, claimedDay)
			return {
				...(row
					? readyState(row.count, row.revision)
					: readyState(priorClaim.countAfter, priorClaim.revision)),
				consumed: false,
				replayed: true,
				day: claimedDay,
				resource: claimedResource,
			}
		}

		const existing = this.readRow(resource, day)
		if (!existing) {
			return { outcome: 'needs_bootstrap' }
		}

		if (input.limit < 1 || existing.count + 1 > input.limit) {
			return {
				...readyState(existing.count, existing.revision),
				consumed: false,
				replayed: false,
				day,
				resource,
			}
		}

		const nextCount = existing.count + 1
		const nextRevision = existing.revision + 1
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec(
				`UPDATE daily_counters
				SET count = ?,
					revision = ?,
					updated_at = ?
				WHERE resource = ? AND day = ? AND revision = ?`,
				nextCount,
				nextRevision,
				input.updatedAt,
				resource,
				day,
				existing.revision,
			)
			this.ctx.storage.sql.exec(
				`INSERT INTO inbound_delivery_claims (
					delivery_id, resource, day, count_after, revision, claimed_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				deliveryId,
				resource,
				day,
				nextCount,
				nextRevision,
				input.updatedAt,
			)
		})
		const row = this.readRow(resource, day)
		if (!row) {
			throw new Error(
				'UserMeter inbound delivery consume lost the counter row.',
			)
		}
		return {
			...readyState(row.count, row.revision),
			consumed: row.count === nextCount && row.revision === nextRevision,
			replayed: false,
			day,
			resource,
		}
	}

	/**
	 * Claim one unique Dynamic Worker id for a UTC day. First insert wins;
	 * later claims for the same `(day, worker_id)` return `created: false`.
	 * Cost attribution for uncapped surfaces; hosted execute claims through
	 * {@link claimDynamicWorkerDayWithinLimit} instead.
	 */
	async claimDynamicWorkerDay(input: {
		workerId: string
		day: string
		createdAt: string
	}): Promise<{ created: boolean }> {
		const workerId = assertDynamicWorkerId(input.workerId)
		const day = assertUtcDayKey(input.day)
		const now = new Date(input.createdAt)
		this.deleteStaleCounters(Number.isNaN(now.valueOf()) ? new Date() : now)
		const cursor = this.ctx.storage.sql.exec(
			`INSERT INTO dynamic_worker_days (worker_id, day, created_at)
			VALUES (?, ?, ?)
			ON CONFLICT(day, worker_id) DO NOTHING`,
			workerId,
			day,
			input.createdAt,
		)
		return { created: cursor.rowsWritten > 0 }
	}

	/** Decrement one unit (floors at zero); missing keys stay uninitialized. */
	async refund(input: {
		resource: string
		day: string
		updatedAt: string
	}): Promise<UserMeterRefundResult> {
		const resource = assertDailyResource(input.resource)
		const day = assertUtcDayKey(input.day)
		const now = new Date(input.updatedAt)
		this.deleteStaleCounters(Number.isNaN(now.valueOf()) ? new Date() : now)

		const existing = this.readRow(resource, day)
		if (!existing) {
			return readyState(0, 0)
		}
		const nextCount = Math.max(0, existing.count - 1)
		const nextRevision = existing.revision + 1
		this.ctx.storage.sql.exec(
			`UPDATE daily_counters
			SET count = ?,
				revision = ?,
				updated_at = ?
			WHERE resource = ? AND day = ? AND revision = ?`,
			nextCount,
			nextRevision,
			input.updatedAt,
			resource,
			day,
			existing.revision,
		)
		const row = this.readRow(resource, day)
		if (!row) {
			throw new Error('UserMeter refund lost the counter row.')
		}
		return readyState(row.count, row.revision)
	}

	/** Cold initialize authoritative state from a caller-provided physical byte count. */
	async initializeStorageBytes(input: {
		bytes: number
		updatedAt: string
	}): Promise<UserMeterStorageBytesInitializeResult> {
		const bytes = Math.max(0, Math.trunc(Number(input.bytes) || 0))
		const cursor = this.ctx.storage.sql.exec(
			`INSERT INTO storage_bytes_state (id, bytes, revision, updated_at)
			VALUES (?, ?, 1, ?)
			ON CONFLICT(id) DO NOTHING`,
			storageBytesStateRowId,
			bytes,
			input.updatedAt,
		)
		const created = cursor.rowsWritten > 0
		const row = this.readStorageRow()
		if (!row) {
			throw new Error(
				'UserMeter initializeStorageBytes failed to materialize storage state.',
			)
		}
		return { ...this.storageReadyState(row.bytes, row.revision), created }
	}

	/** Authoritative storage-byte usage read. */
	async readStorageBytes(): Promise<UserMeterStorageBytesReadResult> {
		const row = this.readStorageRow()
		if (!row) return { outcome: 'needs_bootstrap' }
		return this.storageReadyState(row.bytes, row.revision)
	}

	/**
	 * Authoritative atomic reserve. Missing state returns `needs_bootstrap`.
	 */
	async reserveStorageBytes(input: {
		requested: number
		limit: number
		updatedAt: string
	}): Promise<UserMeterStorageBytesReserveResult> {
		const requested = Math.max(0, Math.trunc(Number(input.requested) || 0))
		const existing = this.readStorageRow()
		if (!existing) {
			return { outcome: 'needs_bootstrap' }
		}
		if (
			requested > 0 &&
			(input.limit < 1 || existing.bytes + requested > input.limit)
		) {
			return {
				...this.storageReadyState(existing.bytes, existing.revision),
				reserved: false,
			}
		}
		if (requested === 0) {
			return {
				...this.storageReadyState(existing.bytes, existing.revision),
				reserved: true,
			}
		}
		const nextBytes = existing.bytes + requested
		const nextRevision = existing.revision + 1
		this.ctx.storage.sql.exec(
			`UPDATE storage_bytes_state
			SET bytes = ?,
				revision = ?,
				updated_at = ?
			WHERE id = ? AND revision = ?`,
			nextBytes,
			nextRevision,
			input.updatedAt,
			storageBytesStateRowId,
			existing.revision,
		)
		const row = this.readStorageRow()
		if (!row) {
			throw new Error('UserMeter reserveStorageBytes lost storage state.')
		}
		return {
			...this.storageReadyState(row.bytes, row.revision),
			reserved: row.bytes === nextBytes && row.revision === nextRevision,
		}
	}

	/**
	 * Absolute maintenance set for authoritative storage usage. Materializes
	 * the singleton and bumps its revision.
	 */
	async setStorageBytes(input: {
		bytes: number
		updatedAt: string
	}): Promise<UserMeterStorageBytesSetResult> {
		const bytes = Math.max(0, Math.trunc(Number(input.bytes) || 0))
		const existing = this.readStorageRow()
		if (!existing) {
			this.ctx.storage.sql.exec(
				`INSERT INTO storage_bytes_state (id, bytes, revision, updated_at)
				VALUES (?, ?, 1, ?)`,
				storageBytesStateRowId,
				bytes,
				input.updatedAt,
			)
			const row = this.readStorageRow()
			if (!row) {
				throw new Error(
					'UserMeter setStorageBytes failed to materialize storage state.',
				)
			}
			return {
				...this.storageReadyState(row.bytes, row.revision),
				created: true,
			}
		}
		const nextRevision = existing.revision + 1
		this.ctx.storage.sql.exec(
			`UPDATE storage_bytes_state
			SET bytes = ?,
				revision = ?,
				updated_at = ?
			WHERE id = ? AND revision = ?`,
			bytes,
			nextRevision,
			input.updatedAt,
			storageBytesStateRowId,
			existing.revision,
		)
		const row = this.readStorageRow()
		if (!row) {
			throw new Error('UserMeter setStorageBytes lost storage state.')
		}
		return {
			...this.storageReadyState(row.bytes, row.revision),
			created: false,
		}
	}

	/**
	 * Revision-guarded absolute reconciliation CAS. Applies `bytes` only when
	 * the current revision equals `expectedRevision`, preventing a scheduled
	 * reconcile sweep from clobbering a live reservation that arrived between
	 * revision capture and the CAS call. Returns `needs_bootstrap` when the
	 * singleton is absent; `applied: false` when another writer changed the
	 * revision first.
	 */
	async reconcileStorageBytes(input: {
		bytes: number
		expectedRevision: number
		updatedAt: string
	}): Promise<UserMeterStorageBytesReconcileResult> {
		const bytes = Math.max(0, Math.trunc(Number(input.bytes) || 0))
		const existing = this.readStorageRow()
		if (!existing) {
			return { outcome: 'needs_bootstrap' }
		}
		if (existing.revision !== input.expectedRevision) {
			// CAS miss: a concurrent reserve or other write changed the revision.
			return {
				...this.storageReadyState(existing.bytes, existing.revision),
				applied: false,
			}
		}
		const nextRevision = existing.revision + 1
		this.ctx.storage.sql.exec(
			`UPDATE storage_bytes_state
			SET bytes = ?,
				revision = ?,
				updated_at = ?
			WHERE id = ? AND revision = ?`,
			bytes,
			nextRevision,
			input.updatedAt,
			storageBytesStateRowId,
			existing.revision,
		)
		const row = this.readStorageRow()
		if (!row) {
			throw new Error('UserMeter reconcileStorageBytes lost storage state.')
		}
		return {
			...this.storageReadyState(row.bytes, row.revision),
			applied: row.revision === nextRevision,
		}
	}

	private readDeletingAt(): string | null {
		const row = this.ctx.storage.sql
			.exec<{
				deleting_at: string
			}>(
				`SELECT deleting_at FROM deletion_state WHERE id = ?`,
				deletionStateRowId,
			)
			.toArray()[0]
		if (!row) return null
		const deletingAt = String(row.deleting_at ?? '')
		return deletingAt.length > 0 ? deletingAt : null
	}

	private writeLeaseFromRow(row: WriteLeaseSqlRow): UserMeterWriteLeaseEntry {
		return {
			token: String(row.token),
			holder: String(row.holder),
			acquiredAt: String(row.acquired_at),
		}
	}

	private pendingRepairIdFromRow(row: WriteLeaseSqlRow): string | null {
		const pending = row.pending_repair_id
		return typeof pending === 'string' && pending.length > 0 ? pending : null
	}

	private readWriteLeaseRow(token: string): WriteLeaseSqlRow | null {
		const row = this.ctx.storage.sql
			.exec<WriteLeaseSqlRow>(
				`SELECT token, holder, acquired_at, pending_repair_id
				FROM account_write_leases
				WHERE token = ?`,
				token,
			)
			.toArray()[0]
		return row ?? null
	}

	private readWriteLease(token: string): UserMeterWriteLeaseEntry | null {
		const row = this.readWriteLeaseRow(token)
		if (!row) return null
		return this.writeLeaseFromRow(row)
	}

	private listAllWriteLeaseRows(): Array<UserMeterWriteLeaseEntry> {
		const rows = this.ctx.storage.sql
			.exec<WriteLeaseSqlRow>(
				`SELECT token, holder, acquired_at, pending_repair_id
				FROM account_write_leases
				ORDER BY acquired_at ASC, token ASC`,
			)
			.toArray()
		return rows.map((row) => this.writeLeaseFromRow(row))
	}

	private countWriteLeases(): number {
		const row = this.ctx.storage.sql
			.exec<{
				count: number
			}>(`SELECT COUNT(*) AS count FROM account_write_leases`)
			.toArray()[0]
		return Math.max(0, Number(row?.count ?? 0))
	}

	private insertOrPreserveDeletingAt(deletingAt: string): {
		deletingAt: string
		created: boolean
	} {
		const existing = this.readDeletingAt()
		if (existing != null) {
			return { deletingAt: existing, created: false }
		}
		const cursor = this.ctx.storage.sql.exec(
			`INSERT INTO deletion_state (id, deleting_at)
			VALUES (?, ?)
			ON CONFLICT(id) DO NOTHING`,
			deletionStateRowId,
			deletingAt,
		)
		return {
			deletingAt: this.readDeletingAt() ?? deletingAt,
			created: cursor.rowsWritten > 0,
		}
	}

	private listWriteLeasesPage(input: {
		pageSize?: number
		startAfter?: string | null
	}): UserMeterWriteLeaseListResult {
		const pageSize = normalizePageSize(input.pageSize)
		const cursor =
			typeof input.startAfter === 'string' && input.startAfter.length > 0
				? decodeWriteLeaseCursor(input.startAfter)
				: null
		const rows = (
			cursor
				? this.ctx.storage.sql.exec<WriteLeaseSqlRow>(
						`SELECT token, holder, acquired_at, pending_repair_id
						FROM account_write_leases
						WHERE acquired_at > ?
							OR (acquired_at = ? AND token > ?)
						ORDER BY acquired_at ASC, token ASC
						LIMIT ?`,
						cursor.acquiredAt,
						cursor.acquiredAt,
						cursor.token,
						pageSize + 1,
					)
				: this.ctx.storage.sql.exec<WriteLeaseSqlRow>(
						`SELECT token, holder, acquired_at, pending_repair_id
							FROM account_write_leases
							ORDER BY acquired_at ASC, token ASC
							LIMIT ?`,
						pageSize + 1,
					)
		).toArray()
		const truncated = rows.length > pageSize
		const pageRows = truncated ? rows.slice(0, pageSize) : rows
		const leases = pageRows.map((row) => this.writeLeaseFromRow(row))
		const last = pageRows[pageRows.length - 1]
		return {
			leases,
			nextStartAfter:
				truncated && last
					? encodeWriteLeaseCursor({
							acquiredAt: String(last.acquired_at),
							token: String(last.token),
						})
					: null,
			truncated,
		}
	}

	private readDeletionStateExport(): UserMeterDeletionStateExport {
		const writeLeases = this.listAllWriteLeaseRows().map((lease) => ({
			acquiredAt: lease.acquiredAt,
		}))
		return {
			deletingAt: this.readDeletingAt(),
			activeWriteLeaseCount: writeLeases.length,
			writeLeases,
		}
	}

	/**
	 * Authoritative mark: preserve tombstone, return active DO write-lease count.
	 */
	async markDeleting(input: {
		deletingAt: string
	}): Promise<UserMeterMarkDeletingResult> {
		const deletingAt = assertDeletionTimestamp('deletingAt', input.deletingAt)
		return await this.ctx.blockConcurrencyWhile(async () => {
			const marked = this.insertOrPreserveDeletingAt(deletingAt)
			const leaseCount = this.countWriteLeases()
			return {
				deletingAt: marked.deletingAt,
				created: marked.created,
				leaseCount,
			}
		})
	}

	/**
	 * Abort a deletion that has not started cleanup: drop the DO tombstone so
	 * later writes and a retry can proceed. D1 `users.deleting_at` is cleared
	 * by the caller first (permanent gate).
	 */
	async clearDeleting(input?: {
		expectedDeletingAt?: string
	}): Promise<UserMeterClearDeletingResult> {
		const expectedDeletingAt =
			input?.expectedDeletingAt == null
				? undefined
				: assertDeletionTimestamp(
						'expectedDeletingAt',
						input.expectedDeletingAt,
					)
		return await this.ctx.blockConcurrencyWhile(async () => {
			const current = this.readDeletingAt()
			if (current == null) return { cleared: false }
			if (expectedDeletingAt != null && current !== expectedDeletingAt) {
				return { cleared: false }
			}
			this.ctx.storage.sql.exec(
				`DELETE FROM deletion_state WHERE id = ?`,
				deletionStateRowId,
			)
			return { cleared: true }
		})
	}

	/** Authoritative lease acquire. */
	async acquireWriteLease(input: {
		token: string
		holder: string
		acquiredAt: string
	}): Promise<UserMeterAcquireWriteLeaseResult> {
		const token = assertWriteLeaseToken(input.token)
		const holder = assertWriteLeaseHolder(input.holder)
		const acquiredAt = assertDeletionTimestamp('acquiredAt', input.acquiredAt)
		const existing = this.readWriteLease(token)
		if (existing) {
			return { acquired: true }
		}
		if (this.readDeletingAt() != null) return { acquired: false }
		const cursor = this.ctx.storage.sql.exec(
			`INSERT INTO account_write_leases (
				token, holder, acquired_at, pending_repair_id
			)
			VALUES (?, ?, ?, NULL)
			ON CONFLICT(token) DO NOTHING`,
			token,
			holder,
			acquiredAt,
		)
		const held = this.readWriteLease(token)
		return {
			acquired: cursor.rowsWritten > 0 || held != null,
		}
	}

	/**
	 * Authoritative lease release. `released` doubles as the post-write held
	 * proof, so a release is remembered briefly: a reset retry whose first
	 * attempt already deleted the row still reports `released: true`, while a
	 * lease removed by repair or purge still reports `false`.
	 */
	async releaseWriteLease(input: {
		token: string
	}): Promise<UserMeterReleaseWriteLeaseResult> {
		const token = assertWriteLeaseToken(input.token)
		const nowMs = Date.now()
		this.ctx.storage.sql.exec(
			`DELETE FROM account_write_lease_releases WHERE released_at < ?`,
			new Date(nowMs - writeLeaseReleaseMemoryMs).toISOString(),
		)
		const cursor = this.ctx.storage.sql.exec(
			`DELETE FROM account_write_leases WHERE token = ?`,
			token,
		)
		if (cursor.rowsWritten > 0) {
			this.ctx.storage.sql.exec(
				`INSERT INTO account_write_lease_releases (token, released_at)
				VALUES (?, ?)
				ON CONFLICT(token) DO UPDATE SET released_at = excluded.released_at`,
				token,
				new Date(nowMs).toISOString(),
			)
			return { released: true }
		}
		const remembered = this.ctx.storage.sql
			.exec(
				`SELECT 1 AS present FROM account_write_lease_releases WHERE token = ?`,
				token,
			)
			.toArray()
		return { released: remembered.length > 0 }
	}

	/** Post-write held check; pending repair still counts as held. */
	async assertWriteLeaseHeld(input: {
		token: string
	}): Promise<UserMeterAssertWriteLeaseHeldResult> {
		const token = assertWriteLeaseToken(input.token)
		const lease = this.readWriteLease(token)
		return { held: lease != null }
	}

	/** Prepare audit-safe repair; retries reuse the pending `repairId`. All active rows are treated as authoritative. */
	async prepareWriteLeaseRepair(input: {
		token: string
		expectedAcquiredAt: string
	}): Promise<UserMeterPrepareWriteLeaseRepairResult> {
		const token = assertWriteLeaseToken(input.token)
		const expectedAcquiredAt = assertDeletionTimestamp(
			'expectedAcquiredAt',
			input.expectedAcquiredAt,
		)
		return await this.ctx.blockConcurrencyWhile(async () => {
			const row = this.readWriteLeaseRow(token)
			if (!row) return { prepared: false as const }
			const lease = this.writeLeaseFromRow(row)
			if (lease.acquiredAt !== expectedAcquiredAt) {
				throw new Error(
					'Active account write lease did not match repair request.',
				)
			}
			const existingRepairId = this.pendingRepairIdFromRow(row)
			const repairId = existingRepairId ?? crypto.randomUUID()
			if (!existingRepairId) {
				this.ctx.storage.sql.exec(
					`UPDATE account_write_leases
					SET pending_repair_id = ?
					WHERE token = ? AND acquired_at = ?
						AND (pending_repair_id IS NULL OR pending_repair_id = '')`,
					repairId,
					token,
					expectedAcquiredAt,
				)
			}
			const heldRow = this.readWriteLeaseRow(token)
			if (!heldRow) return { prepared: false as const }
			const held = this.writeLeaseFromRow(heldRow)
			const pending = this.pendingRepairIdFromRow(heldRow)
			if (!pending) {
				throw new Error('Account write lease repair could not be prepared.')
			}
			return {
				prepared: true as const,
				repairId: pending,
				token: held.token,
				holder: held.holder,
				acquiredAt: held.acquiredAt,
			}
		})
	}

	/** Finalize exact pending repair; idempotent when the lease is already gone. */
	async finalizeWriteLeaseRepair(input: {
		token: string
		repairId: string
		expectedAcquiredAt: string
	}): Promise<UserMeterFinalizeWriteLeaseRepairResult> {
		const token = assertWriteLeaseToken(input.token)
		const repairId = assertWriteLeaseRepairId(input.repairId)
		const expectedAcquiredAt = assertDeletionTimestamp(
			'expectedAcquiredAt',
			input.expectedAcquiredAt,
		)
		return await this.ctx.blockConcurrencyWhile(async () => {
			const row = this.readWriteLeaseRow(token)
			if (!row) return { finalized: true }
			const lease = this.writeLeaseFromRow(row)
			if (
				lease.acquiredAt !== expectedAcquiredAt ||
				this.pendingRepairIdFromRow(row) !== repairId
			) {
				throw new Error(
					'Active account write lease did not match repair request.',
				)
			}
			const cursor = this.ctx.storage.sql.exec(
				`DELETE FROM account_write_leases
				WHERE token = ?
					AND acquired_at = ?
					AND pending_repair_id = ?`,
				token,
				expectedAcquiredAt,
				repairId,
			)
			if (cursor.rowsWritten < 1 && this.readWriteLeaseRow(token) != null) {
				throw new Error(
					'Active account write lease did not match repair request.',
				)
			}
			return { finalized: true }
		})
	}

	/** Deletion tombstone read (D1 `deleting_at` remains the permanent gate). */
	async readDeletionState(): Promise<{ deletingAt: string | null }> {
		return { deletingAt: this.readDeletingAt() }
	}

	/** Paged lease list. */
	async listWriteLeases(
		input: {
			pageSize?: number
			startAfter?: string | null
		} = {},
	): Promise<UserMeterWriteLeaseListResult> {
		return this.listWriteLeasesPage(input)
	}

	/** Active lease count (pending repair still counts). */
	async countActiveWriteLeases(): Promise<UserMeterWriteLeaseCountResult> {
		return { count: this.countWriteLeases() }
	}

	async touchInboundConnectionLastUsed(input: {
		clientId: string
		lastUsedAt: string
	}): Promise<{ updated: boolean }> {
		const clientId = assertInboundMcpClientId(input.clientId)
		const lastUsedAt = assertInboundMcpLastUsedAt(input.lastUsedAt)
		const debounceCutoffIso = new Date(
			Date.parse(lastUsedAt) - inboundMcpConnectionLastUsedMinIntervalMs,
		).toISOString()
		this.ctx.storage.sql.exec(
			`INSERT INTO inbound_mcp_connection_last_used (client_id, last_used_at)
			VALUES (?, ?)
			ON CONFLICT(client_id) DO UPDATE SET last_used_at = excluded.last_used_at
			WHERE inbound_mcp_connection_last_used.last_used_at < ?`,
			clientId,
			lastUsedAt,
			debounceCutoffIso,
		)
		const row = this.ctx.storage.sql
			.exec<{ last_used_at: string }>(
				`SELECT last_used_at
				FROM inbound_mcp_connection_last_used
				WHERE client_id = ?`,
				clientId,
			)
			.toArray()[0]
		return { updated: row?.last_used_at === lastUsedAt }
	}

	async listInboundConnectionLastUsed(): Promise<
		Array<UserMeterInboundConnectionLastUsedRow>
	> {
		return this.ctx.storage.sql
			.exec<{ client_id: string; last_used_at: string }>(
				`SELECT client_id, last_used_at
				FROM inbound_mcp_connection_last_used
				ORDER BY last_used_at DESC, client_id ASC`,
			)
			.toArray()
			.map((row) => ({
				clientId: String(row.client_id),
				lastUsedAt: String(row.last_used_at),
			}))
	}

	async forgetInboundConnectionLastUsed(input: {
		clientId: string
	}): Promise<{ ok: true }> {
		const clientId = assertInboundMcpClientId(input.clientId)
		this.ctx.storage.sql.exec(
			`DELETE FROM inbound_mcp_connection_last_used WHERE client_id = ?`,
			clientId,
		)
		return { ok: true }
	}

	private resetBudgetSpendForMonth(month: string) {
		const safeMonth = assertUtcMonthKey(month)
		this.ctx.storage.sql.exec(`DELETE FROM budget_spend_users`)
		this.ctx.storage.sql.exec(
			`INSERT INTO budget_spend_state (id, month, automation_micro_usd)
			 VALUES (?, ?, 0)
			 ON CONFLICT(id) DO UPDATE SET
				month = excluded.month,
				automation_micro_usd = 0`,
			budgetSpendStateRowId,
			safeMonth,
		)
	}

	private storedBudgetMonth(): string | null {
		const row = this.ctx.storage.sql
			.exec<{ month: string }>(
				`SELECT month FROM budget_spend_state WHERE id = ?`,
				budgetSpendStateRowId,
			)
			.toArray()[0]
		return row ? String(row.month) : null
	}

	private ensureBudgetMonth(month: string): string {
		const safeMonth = assertUtcMonthKey(month)
		const stored = this.storedBudgetMonth()
		if (!stored) {
			this.resetBudgetSpendForMonth(safeMonth)
			return safeMonth
		}
		if (stored === safeMonth) {
			return safeMonth
		}
		// Late settlement for a past month must not wipe the live MTD row.
		if (safeMonth < stored) {
			return stored
		}
		this.resetBudgetSpendForMonth(safeMonth)
		return safeMonth
	}

	private readBudgetSpendState(month: string): UserMeterBudgetSpendState {
		const safeMonth = assertUtcMonthKey(month)
		const stored = this.storedBudgetMonth()
		if (stored && safeMonth < stored) {
			return {
				month: safeMonth,
				users: {},
				automationMicroUsd: 0,
			}
		}
		this.ensureBudgetMonth(safeMonth)
		const automationRow = this.ctx.storage.sql
			.exec<{ automation_micro_usd: number }>(
				`SELECT automation_micro_usd FROM budget_spend_state WHERE id = ?`,
				budgetSpendStateRowId,
			)
			.toArray()[0]
		const userRows = this.ctx.storage.sql
			.exec<{ user_id: string; micro_usd: number }>(
				`SELECT user_id, micro_usd FROM budget_spend_users`,
			)
			.toArray()
		const users: Record<string, number> = {}
		for (const row of userRows) {
			users[String(row.user_id)] = Math.max(0, Number(row.micro_usd ?? 0))
		}
		return {
			month,
			users,
			automationMicroUsd: Math.max(
				0,
				Number(automationRow?.automation_micro_usd ?? 0),
			),
		}
	}

	async getBudgetSpend(input: {
		month: string
	}): Promise<UserMeterBudgetSpendState> {
		const month = assertUtcMonthKey(input.month)
		return this.readBudgetSpendState(month)
	}

	async assertWithinBudgetAndRecord(input: {
		month: string
		actorUserId: string | null
		automationSource: string | null
		deltaMicroUsd: number
		userBudgetMicroUsd: number | null
		automationBudgetMicroUsd: number | null
		actorUsername?: string | null
		orgSlug?: string | null
	}): Promise<UserMeterBudgetSpendState> {
		const month = assertUtcMonthKey(input.month)
		const delta = Math.max(0, Math.floor(Number(input.deltaMicroUsd ?? 0)))
		const orgSlug = input.orgSlug?.trim() || 'org'
		const state = this.readBudgetSpendState(month)
		const isAutomation =
			input.actorUserId == null && input.automationSource != null
		if (isAutomation) {
			const budget = input.automationBudgetMicroUsd
			if (budget != null && budget >= 0) {
				const current = state.automationMicroUsd
				const next = current + delta
				const overBudget = next > budget || (delta === 0 && current >= budget)
				if (overBudget) {
					throwBudgetLimit({
						kind: 'automation',
						orgSlug,
						spentMicroUsd: current,
						budgetMicroUsd: budget,
					})
				}
			}
		} else if (input.actorUserId != null) {
			const budget = input.userBudgetMicroUsd
			if (budget != null && budget >= 0) {
				const current = state.users[input.actorUserId] ?? 0
				const next = current + delta
				const overBudget = next > budget || (delta === 0 && current >= budget)
				if (overBudget) {
					throwBudgetLimit({
						kind: 'user',
						orgSlug,
						actorUsername: input.actorUsername?.trim() || undefined,
						spentMicroUsd: current,
						budgetMicroUsd: budget,
					})
				}
			}
		}
		if (delta === 0) {
			return state
		}
		const stored = this.storedBudgetMonth()
		if (stored && month < stored) {
			console.info('user_meter_budget_skip_past_month', {
				month,
				storedMonth: stored,
			})
			return state
		}
		this.ctx.storage.transactionSync(() => {
			this.ensureBudgetMonth(month)
			if (isAutomation) {
				this.ctx.storage.sql.exec(
					`UPDATE budget_spend_state
					 SET automation_micro_usd = automation_micro_usd + ?
					 WHERE id = ?`,
					delta,
					budgetSpendStateRowId,
				)
			} else if (input.actorUserId != null) {
				this.ctx.storage.sql.exec(
					`INSERT INTO budget_spend_users (user_id, micro_usd)
					 VALUES (?, ?)
					 ON CONFLICT(user_id) DO UPDATE SET
						micro_usd = micro_usd + excluded.micro_usd`,
					input.actorUserId,
					delta,
				)
			}
		})
		return this.readBudgetSpendState(month)
	}

	async recomputeBudgetSpend(input: {
		month: string
		users: Record<string, number>
		automation: number
	}): Promise<UserMeterBudgetSpendState> {
		const month = assertUtcMonthKey(input.month)
		const stored = this.storedBudgetMonth()
		// Never let a past-month reconciliation wipe or rewrite live MTD rows.
		if (stored && month < stored) {
			console.info('user_meter_budget_recompute_skip_past_month', {
				month,
				storedMonth: stored,
			})
			return this.readBudgetSpendState(stored)
		}
		this.ensureBudgetMonth(month)
		const automationTarget = Math.max(0, Math.floor(Number(input.automation)))
		this.ctx.storage.transactionSync(() => {
			const state = this.readBudgetSpendState(month)
			if (automationTarget > state.automationMicroUsd) {
				this.ctx.storage.sql.exec(
					`UPDATE budget_spend_state
					 SET automation_micro_usd = ?
					 WHERE id = ?`,
					automationTarget,
					budgetSpendStateRowId,
				)
			}
			for (const [userId, microUsd] of Object.entries(input.users)) {
				const target = Math.max(0, Math.floor(Number(microUsd)))
				const current = state.users[userId] ?? 0
				if (target <= current) continue
				this.ctx.storage.sql.exec(
					`INSERT INTO budget_spend_users (user_id, micro_usd)
					 VALUES (?, ?)
					 ON CONFLICT(user_id) DO UPDATE SET
						micro_usd = MAX(micro_usd, excluded.micro_usd)`,
					userId,
					target,
				)
			}
		})
		return this.readBudgetSpendState(month)
	}

	/**
	 * Replace current-month budget MTD with absolute totals from the credit
	 * ledger. Unlike {@link recomputeBudgetSpend} (MAX-only), this clears prior
	 * actor rows so weight changes and org-fallback → member handoff cannot
	 * double-count the same debit.
	 */
	async replaceBudgetSpendFromLedger(input: {
		month: string
		users: Record<string, number>
		automation: number
	}): Promise<UserMeterBudgetSpendState> {
		const month = assertUtcMonthKey(input.month)
		const stored = this.storedBudgetMonth()
		if (stored && month < stored) {
			console.info('user_meter_budget_replace_skip_past_month', {
				month,
				storedMonth: stored,
			})
			return this.readBudgetSpendState(stored)
		}
		this.ensureBudgetMonth(month)
		const automationTarget = Math.max(0, Math.floor(Number(input.automation)))
		// Absolute ledger replace is source of truth and must overwrite
		// provisional rows from assertWithinBudgetAndRecord(estimatedDelta).
		// Do not gate on stored totals: estimates can exceed committed debit.
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec(`DELETE FROM budget_spend_users`)
			this.ctx.storage.sql.exec(
				`UPDATE budget_spend_state
				 SET automation_micro_usd = ?
				 WHERE id = ?`,
				automationTarget,
				budgetSpendStateRowId,
			)
			for (const [userId, microUsd] of Object.entries(input.users)) {
				const target = Math.max(0, Math.floor(Number(microUsd)))
				if (target <= 0) continue
				this.ctx.storage.sql.exec(
					`INSERT INTO budget_spend_users (user_id, micro_usd)
					 VALUES (?, ?)`,
					userId,
					target,
				)
			}
		})
		return this.readBudgetSpendState(month)
	}

	async purge(): Promise<{ ok: true }> {
		await this.ctx.blockConcurrencyWhile(async () => {
			const deletingAt = this.readDeletingAt()
			await this.ctx.storage.deleteAll()
			this.initializeSchema()
			if (deletingAt != null) {
				this.ctx.storage.sql.exec(
					`INSERT INTO deletion_state (id, deleting_at)
					VALUES (?, ?)
					ON CONFLICT(id) DO NOTHING`,
					deletionStateRowId,
					deletingAt,
				)
			}
		})
		return { ok: true }
	}

	async exportCounters(input: {
		pageSize?: number
		startAfter?: string | null
	}): Promise<UserMeterExportResult> {
		this.deleteStaleCounters(new Date())
		const pageSize = normalizePageSize(input.pageSize)
		const cursor =
			typeof input.startAfter === 'string' && input.startAfter.length > 0
				? decodeExportCursor(input.startAfter)
				: null

		const rows = (
			cursor
				? this.ctx.storage.sql.exec<{
						resource: string
						day: string
						count: number
						revision: number
						updated_at: string
					}>(
						`SELECT resource, day, count, revision, updated_at
						FROM daily_counters
						WHERE day > ?
							OR (day = ? AND resource > ?)
						ORDER BY day ASC, resource ASC
						LIMIT ?`,
						cursor.day,
						cursor.day,
						cursor.resource,
						pageSize + 1,
					)
				: this.ctx.storage.sql.exec<{
						resource: string
						day: string
						count: number
						revision: number
						updated_at: string
					}>(
						`SELECT resource, day, count, revision, updated_at
						FROM daily_counters
						ORDER BY day ASC, resource ASC
						LIMIT ?`,
						pageSize + 1,
					)
		).toArray()

		const truncated = rows.length > pageSize
		const pageRows = truncated ? rows.slice(0, pageSize) : rows
		const counters: Array<UserMeterCounterRow> = []
		for (const row of pageRows) {
			const resource = String(row.resource)
			if (!isDailyEntitlementResource(resource)) continue
			const revision = Math.max(0, Number(row.revision ?? 0))
			counters.push({
				resource,
				day: String(row.day),
				count: Math.max(0, Number(row.count ?? 0)),
				revision,
				updatedAt: String(row.updated_at),
				mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(revision),
			})
		}
		// Singleton and inventory state sits outside counter keyset paging. Emit
		// it once on the first page so totals and consumers never double-count.
		const includeFirstPageState = cursor == null
		const storageRow = includeFirstPageState ? this.readStorageRow() : null
		const deletionState = includeFirstPageState
			? this.readDeletionStateExport()
			: null
		const inboundConnectionLastUsed = includeFirstPageState
			? await this.listInboundConnectionLastUsed()
			: null
		const last = pageRows[pageRows.length - 1]
		return {
			counters,
			storageBytesState: storageRow
				? {
						bytes: storageRow.bytes,
						revision: storageRow.revision,
						updatedAt: storageRow.updatedAt,
						mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(storageRow.revision),
					}
				: null,
			deletionState,
			inboundConnectionLastUsed,
			nextStartAfter:
				truncated && last
					? encodeExportCursor({
							day: String(last.day),
							resource: String(last.resource),
						})
					: null,
			truncated,
		}
	}
}

export const UserMeter = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	UserMeterBase,
)
export type UserMeter = InstanceType<typeof UserMeter>

export type UserMeterRpc = DurableObjectPitrRpc & {
	initialize: (input: {
		resource: string
		day: string
		count: number
		updatedAt: string
	}) => Promise<UserMeterInitializeResult>
	consume: (input: {
		resource: string
		day: string
		limit: number
		updatedAt: string
		weekStart?: string
		weekLimit?: number | null
	}) => Promise<UserMeterConsumeResult>
	readRange: (input: {
		resource: string
		startDay: string
		endDay: string
		now?: string
	}) => Promise<{ outcome: 'ready'; count: number }>
	consumeInboundDelivery: (input: {
		deliveryId: string
		resource: string
		day: string
		limit: number
		updatedAt: string
	}) => Promise<UserMeterInboundDeliveryConsumeResult>
	read: (input: {
		resource: string
		day: string
		now?: string
	}) => Promise<UserMeterReadResult>
	/**
	 * Batch read for entitlement usage snapshots: daily counters, weekly
	 * windows, and optional storage bytes in one Durable Object hop.
	 */
	readUsageSnapshot: (input: {
		day: string
		weekStart: string
		dailyResources: ReadonlyArray<string>
		weeklyResources: ReadonlyArray<string>
		includeStorageBytes?: boolean
		now?: string
	}) => Promise<UserMeterUsageSnapshotResult>
	/**
	 * Retention-window daily counters plus unique-worker-day counts grouped by
	 * UTC day. Read-only aside from the usual stale-row prune.
	 */
	readDailyTrend: (input?: {
		now?: string
	}) => Promise<UserMeterDailyTrendResult>
	refund: (input: {
		resource: string
		day: string
		updatedAt: string
	}) => Promise<UserMeterRefundResult>
	/** First-seen unique Dynamic Worker id for a UTC day. */
	claimDynamicWorkerDay: (input: {
		workerId: string
		day: string
		createdAt: string
	}) => Promise<{ created: boolean }>
	/** Claim a worker day and spend one unit only when the claim is new. */
	claimDynamicWorkerDayWithinLimit: (input: {
		workerId: string
		resource: string
		day: string
		limit: number
		createdAt: string
		weekStart?: string
		weekLimit?: number | null
	}) => Promise<UserMeterWorkerDayConsumeResult>
	/** In-memory per-minute and identical-call hosted execute admission. */
	admitExecuteCall: (input: {
		nowMs: number
		limitPerMinute: number
		repeat?: ExecuteRepeatInput
	}) => Promise<UserMeterExecuteAdmissionResult>
	/** Cold initialize authoritative state from a caller-provided physical byte count. */
	initializeStorageBytes: (input: {
		bytes: number
		updatedAt: string
	}) => Promise<UserMeterStorageBytesInitializeResult>
	/** Authoritative storage-byte usage read. */
	readStorageBytes: () => Promise<UserMeterStorageBytesReadResult>
	/** Authoritative atomic storage-byte reserve. */
	reserveStorageBytes: (input: {
		requested: number
		limit: number
		updatedAt: string
	}) => Promise<UserMeterStorageBytesReserveResult>
	/** Absolute maintenance set; use revision CAS for live reconciliation. */
	setStorageBytes: (input: {
		bytes: number
		updatedAt: string
	}) => Promise<UserMeterStorageBytesSetResult>
	/**
	 * Revision-guarded absolute reconciliation CAS. Applies `bytes` only when
	 * current revision equals `expectedRevision`. Returns `needs_bootstrap` if
	 * the singleton is absent; `applied: false` on a CAS miss.
	 */
	reconcileStorageBytes: (input: {
		bytes: number
		expectedRevision: number
		updatedAt: string
	}) => Promise<UserMeterStorageBytesReconcileResult>
	/** Authoritative deletion mark; preserves tombstone. Returns active write-lease count. */
	markDeleting: (input: {
		deletingAt: string
	}) => Promise<UserMeterMarkDeletingResult>
	/** Drop the deletion tombstone after a pre-cleanup abort. */
	clearDeleting: (input?: {
		expectedDeletingAt?: string
	}) => Promise<UserMeterClearDeletingResult>
	/** Authoritative lease acquire. */
	acquireWriteLease: (input: {
		token: string
		holder: string
		acquiredAt: string
	}) => Promise<UserMeterAcquireWriteLeaseResult>
	/** Authoritative lease release. */
	releaseWriteLease: (input: {
		token: string
	}) => Promise<UserMeterReleaseWriteLeaseResult>
	/** Post-write held check; pending repair still counts as held. */
	assertWriteLeaseHeld: (input: {
		token: string
	}) => Promise<UserMeterAssertWriteLeaseHeldResult>
	/** Prepare an audit-safe lease repair; retries reuse repairId. */
	prepareWriteLeaseRepair: (input: {
		token: string
		expectedAcquiredAt: string
	}) => Promise<UserMeterPrepareWriteLeaseRepairResult>
	/** Finalize an exact pending repair by deleting the lease. */
	finalizeWriteLeaseRepair: (input: {
		token: string
		repairId: string
		expectedAcquiredAt: string
	}) => Promise<UserMeterFinalizeWriteLeaseRepairResult>
	/** Deletion tombstone read (D1 deleting_at remains the permanent gate). */
	readDeletionState: () => Promise<{ deletingAt: string | null }>
	/** Paged lease list. */
	listWriteLeases: (input: {
		pageSize?: number
		startAfter?: string | null
	}) => Promise<UserMeterWriteLeaseListResult>
	/** Active lease count (pending repair still counts). */
	countActiveWriteLeases: () => Promise<UserMeterWriteLeaseCountResult>
	touchInboundConnectionLastUsed: (input: {
		clientId: string
		lastUsedAt: string
	}) => Promise<{ updated: boolean }>
	listInboundConnectionLastUsed: () => Promise<
		Array<UserMeterInboundConnectionLastUsedRow>
	>
	forgetInboundConnectionLastUsed: (input: {
		clientId: string
	}) => Promise<{ ok: true }>
	purge: () => Promise<{ ok: true }>
	getBudgetSpend: (input: {
		month: string
	}) => Promise<UserMeterBudgetSpendState>
	assertWithinBudgetAndRecord: (input: {
		month: string
		actorUserId: string | null
		automationSource: string | null
		deltaMicroUsd: number
		userBudgetMicroUsd: number | null
		automationBudgetMicroUsd: number | null
		actorUsername?: string | null
		orgSlug?: string | null
	}) => Promise<UserMeterBudgetSpendState>
	recomputeBudgetSpend: (input: {
		month: string
		users: Record<string, number>
		automation: number
	}) => Promise<UserMeterBudgetSpendState>
	replaceBudgetSpendFromLedger: (input: {
		month: string
		users: Record<string, number>
		automation: number
	}) => Promise<UserMeterBudgetSpendState>
	exportCounters: (input: {
		pageSize?: number
		startAfter?: string | null
	}) => Promise<UserMeterExportResult>
}
