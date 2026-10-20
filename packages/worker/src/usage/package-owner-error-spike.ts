import { chunkArray } from '@kody-internal/shared/chunk.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	queryAnalyticsEngineSql,
	resolveUsageEventsDataset,
} from './aggregate-rollups.ts'
import { fleetPackageErrorRateMetrics } from './fleet-package-error-rate-subscription-event.ts'
import { alignToUtcHour, countsOf } from './fleet-package-error-rate.ts'

/**
 * Hourly package-owner error spike: when an owner's packages (any caller)
 * fail hard enough to cross volume + rate floors, email the owner once and
 * emit a non-paging admin audit event. Re-arm after sustained health or
 * inactivity so a later spike can notify again.
 */

export const packageOwnerErrorSpikeKvKeyPrefix =
	'ops-alert:package-owner-error-spike:v1:'
/** Index of owner ids currently in `alerted` so inactivity can re-arm. */
export const packageOwnerErrorSpikeAlertedIndexKvKey =
	'ops-alert:package-owner-error-spike:alerted-index:v1'

/** Minimum errored events in the last completed hour to consider a spike. */
export const packageOwnerErrorSpikeMinErrors = 20
/** Minimum error rate (errors / events) in that hour to trigger. */
export const packageOwnerErrorSpikeMinRate = 0.25
/** Error rate at or below this counts as a healthy window (with min errors). */
export const packageOwnerErrorSpikeHealthyRate = 0.05
/** Absolute error count below this also counts as healthy. */
export const packageOwnerErrorSpikeHealthyMaxErrors = 5
/** Consecutive healthy hourly windows required to re-arm after an alert. */
export const packageOwnerErrorSpikeHealthyWindowsToRearm = 2
/** No activity for this long re-arms even without healthy windows. */
export const packageOwnerErrorSpikeInactiveRearmMs = 24 * 60 * 60 * 1000
/** Cap named packages in email / admin event payloads. */
export const packageOwnerErrorSpikeMaxNamedPackages = 8
/** Cap owners evaluated per hourly sweep (highest error first). */
export const packageOwnerErrorSpikeMaxOwnersPerSweep = 40
/** Cap package rows loaded from AE before owner fold. */
export const packageOwnerErrorSpikeMaxPackageRows = 200
/** Max delivery attempts for a pending spike email (hourly sweeps). */
export const packageOwnerErrorSpikeMaxDeliveryAttempts = 6
/** Drop a pending spike if delivery never succeeds within this age. */
export const packageOwnerErrorSpikePendingMaxAgeMs = 24 * 60 * 60 * 1000

const packageMetrics = ['package_export', 'package_static_call'] as const
const accountMetrics = ['job_run', 'workflow_run'] as const
const analyticsEngineIdPattern = /^[A-Za-z0-9:._-]+$/
const maxSqlBindingsPerChunk = 90
const stateTtlSeconds = 14 * 24 * 60 * 60

export type PackageOwnerErrorSpikeEnv = {
	USAGE_EVENTS?: AnalyticsEngineDataset
	APP_DB?: D1Database
	BUNDLE_ARTIFACTS_KV?: KVNamespace
	APP_BASE_URL?: string
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_TOKEN?: string
	CLOUDFLARE_API_BASE_URL?: string
	SENTRY_ENVIRONMENT?: string
}

export type PackageOwnerErrorSpikePackageRow = {
	package_id?: string
	metric?: string
	event_count?: number | string
	error_count?: number | string
}

export type PackageOwnerErrorSpikeAccountRow = {
	owner_id?: string
	metric?: string
	event_count?: number | string
	error_count?: number | string
}

export type PackageOwnerSpikePackageSummary = {
	kody_id: string
	events: number
	errors: number
	rate: number | null
}

export type PackageOwnerSpikeMetricSummary = {
	metric: (typeof fleetPackageErrorRateMetrics)[number]
	events: number
	errors: number
	rate: number | null
}

export type PackageOwnerSpikeWindow = {
	ownerId: string
	windowStart: string
	windowEnd: string
	events: number
	errors: number
	rate: number | null
	packages: Array<PackageOwnerSpikePackageSummary>
	byMetric: Array<PackageOwnerSpikeMetricSummary>
}

export type PackageOwnerSpikeStateStatus = 'ok' | 'pending' | 'alerted'

export type PackageOwnerSpikeSnapshot = {
	startedAt: string
	windowStart: string
	windowEnd: string
	errors: number
	events: number
	rate: number | null
	packages: Array<PackageOwnerSpikePackageSummary>
	byMetric: Array<PackageOwnerSpikeMetricSummary>
}

export type PackageOwnerSpikeState = {
	version: 1
	status: PackageOwnerSpikeStateStatus
	alertedAt: string | null
	/** When status is pending: first failed (or not-yet-sent) delivery time. */
	pendingSince: string | null
	/** Delivery attempts while pending (0 when ok/alerted). */
	deliveryAttempts: number
	consecutiveHealthyWindows: number
	lastActivityAt: string | null
	lastWindowEnd: string | null
	/** Snapshot of the spike that opened the episode (pending or alerted). */
	spike: PackageOwnerSpikeSnapshot | null
}

export type PackageOwnerSpikeTransitionAction =
	| 'none'
	| 'alert'
	| 'retry_alert'
	| 'abandon'
	| 'rearm'

export type PackageOwnerSpikeTransition = {
	next: PackageOwnerSpikeState
	action: PackageOwnerSpikeTransitionAction
}

type AlertedOwnerIndexDraft = {
	ownerIds: Set<string>
	dirty: boolean
}

export function packageOwnerErrorSpikeKvKey(ownerId: string) {
	return `${packageOwnerErrorSpikeKvKeyPrefix}${ownerId}`
}

export function isPackageOwnerErrorSpikeTrigger(input: {
	errors: number
	events: number
	minErrors?: number
	minRate?: number
}) {
	const minErrors = input.minErrors ?? packageOwnerErrorSpikeMinErrors
	const minRate = input.minRate ?? packageOwnerErrorSpikeMinRate
	if (input.errors < minErrors) return false
	if (input.events <= 0) return false
	return input.errors / input.events >= minRate
}

export function isPackageOwnerErrorSpikeHealthy(input: {
	errors: number
	events: number
	healthyRate?: number
	healthyMaxErrors?: number
}) {
	const healthyRate = input.healthyRate ?? packageOwnerErrorSpikeHealthyRate
	const healthyMaxErrors =
		input.healthyMaxErrors ?? packageOwnerErrorSpikeHealthyMaxErrors
	if (input.errors < healthyMaxErrors) return true
	if (input.events <= 0) return true
	return input.errors / input.events < healthyRate
}

/**
 * ok → pending on trigger (email once after delivery). Pending retries
 * delivery independent of later thresholds until success, max attempts, or
 * max age. Alerted stays quiet while elevated; re-arm after consecutive
 * healthy windows, or after inactivity with no activity for 24h.
 */
export function evaluatePackageOwnerSpikeTransition(input: {
	previous: PackageOwnerSpikeState | null
	window: PackageOwnerSpikeWindow | null
	now: Date
	healthyWindowsToRearm?: number
	inactiveRearmMs?: number
	pendingMaxAgeMs?: number
}): PackageOwnerSpikeTransition {
	const healthyWindowsToRearm =
		input.healthyWindowsToRearm ?? packageOwnerErrorSpikeHealthyWindowsToRearm
	const inactiveRearmMs =
		input.inactiveRearmMs ?? packageOwnerErrorSpikeInactiveRearmMs
	const pendingMaxAgeMs =
		input.pendingMaxAgeMs ?? packageOwnerErrorSpikePendingMaxAgeMs
	const previous = input.previous ?? emptyOwnerSpikeState()
	const nowIso = input.now.toISOString()

	if (previous.status === 'pending') {
		if (
			isPendingSpikeExpired({
				state: previous,
				now: input.now,
				pendingMaxAgeMs,
			})
		) {
			if (input.window) {
				// Drop the expired episode, then evaluate the current window as
				// a fresh ok owner so a same-hour new spike is not written as
				// ok and lost if the next hour is quiet.
				return evaluatePackageOwnerSpikeTransition({
					...input,
					previous: {
						...emptyOwnerSpikeState(),
						lastActivityAt: input.window.windowEnd,
						lastWindowEnd: input.window.windowEnd,
					},
				})
			}
			return {
				action: 'abandon',
				next: {
					...emptyOwnerSpikeState(),
					lastActivityAt: previous.lastActivityAt,
					lastWindowEnd: previous.lastWindowEnd,
				},
			}
		}
		return {
			action: 'retry_alert',
			next: {
				...previous,
				status: 'pending',
				lastActivityAt: input.window?.windowEnd ?? previous.lastActivityAt,
				lastWindowEnd: input.window?.windowEnd ?? previous.lastWindowEnd,
			},
		}
	}

	if (!input.window) {
		const lastActivityAt = previous.lastActivityAt
		const inactive =
			lastActivityAt != null &&
			input.now.getTime() - Date.parse(lastActivityAt) >= inactiveRearmMs
		if (previous.status === 'alerted' && (inactive || lastActivityAt == null)) {
			return {
				action: 'rearm',
				next: {
					...emptyOwnerSpikeState(),
					lastActivityAt,
					lastWindowEnd: previous.lastWindowEnd,
				},
			}
		}
		return {
			action: 'none',
			next: {
				...previous,
				lastWindowEnd: previous.lastWindowEnd,
			},
		}
	}

	const window = input.window
	const triggered = isPackageOwnerErrorSpikeTrigger({
		errors: window.errors,
		events: window.events,
	})
	const healthy = isPackageOwnerErrorSpikeHealthy({
		errors: window.errors,
		events: window.events,
	})
	const base: PackageOwnerSpikeState = {
		version: 1,
		status: previous.status,
		alertedAt: previous.alertedAt,
		pendingSince: previous.pendingSince,
		deliveryAttempts: previous.deliveryAttempts,
		consecutiveHealthyWindows: previous.consecutiveHealthyWindows,
		lastActivityAt: window.windowEnd,
		lastWindowEnd: window.windowEnd,
		spike: previous.spike,
	}

	if (previous.status === 'ok') {
		if (!triggered) {
			return {
				action: 'none',
				next: {
					...base,
					status: 'ok',
					alertedAt: null,
					pendingSince: null,
					deliveryAttempts: 0,
					consecutiveHealthyWindows: 0,
					spike: null,
				},
			}
		}
		return {
			action: 'alert',
			next: {
				...base,
				status: 'pending',
				alertedAt: null,
				pendingSince: nowIso,
				deliveryAttempts: 0,
				consecutiveHealthyWindows: 0,
				spike: {
					startedAt: nowIso,
					windowStart: window.windowStart,
					windowEnd: window.windowEnd,
					errors: window.errors,
					events: window.events,
					rate: window.rate,
					packages: window.packages,
					byMetric: window.byMetric,
				},
			},
		}
	}

	// alerted
	if (triggered) {
		return {
			action: 'none',
			next: {
				...base,
				status: 'alerted',
				pendingSince: null,
				deliveryAttempts: 0,
				consecutiveHealthyWindows: 0,
			},
		}
	}
	if (healthy) {
		const consecutive = previous.consecutiveHealthyWindows + 1
		if (consecutive >= healthyWindowsToRearm) {
			return {
				action: 'rearm',
				next: {
					...emptyOwnerSpikeState(),
					lastActivityAt: window.windowEnd,
					lastWindowEnd: window.windowEnd,
				},
			}
		}
		return {
			action: 'none',
			next: {
				...base,
				status: 'alerted',
				pendingSince: null,
				deliveryAttempts: 0,
				consecutiveHealthyWindows: consecutive,
			},
		}
	}
	// Neither trigger nor healthy (mid band): hold alerted, reset healthy streak.
	return {
		action: 'none',
		next: {
			...base,
			status: 'alerted',
			pendingSince: null,
			deliveryAttempts: 0,
			consecutiveHealthyWindows: 0,
		},
	}
}

export function isPendingSpikeExpired(input: {
	state: PackageOwnerSpikeState
	now: Date
	pendingMaxAgeMs?: number
	maxDeliveryAttempts?: number
}) {
	if (input.state.status !== 'pending') return false
	const pendingMaxAgeMs =
		input.pendingMaxAgeMs ?? packageOwnerErrorSpikePendingMaxAgeMs
	const maxDeliveryAttempts =
		input.maxDeliveryAttempts ?? packageOwnerErrorSpikeMaxDeliveryAttempts
	if (input.state.deliveryAttempts >= maxDeliveryAttempts) return true
	const since = input.state.pendingSince
	if (since == null) return true
	const started = Date.parse(since)
	if (!Number.isFinite(started)) return true
	return input.now.getTime() - started >= pendingMaxAgeMs
}

/** Rebuild the notify window from the retained spike snapshot. */
export function packageOwnerSpikeWindowFromState(input: {
	ownerId: string
	state: PackageOwnerSpikeState
}): PackageOwnerSpikeWindow | null {
	const spike = input.state.spike
	if (!spike) return null
	return {
		ownerId: input.ownerId,
		windowStart: spike.windowStart,
		windowEnd: spike.windowEnd,
		events: spike.events,
		errors: spike.errors,
		rate: spike.rate,
		packages: spike.packages,
		byMetric: spike.byMetric,
	}
}

export function emptyOwnerSpikeState(): PackageOwnerSpikeState {
	return {
		version: 1,
		status: 'ok',
		alertedAt: null,
		pendingSince: null,
		deliveryAttempts: 0,
		consecutiveHealthyWindows: 0,
		lastActivityAt: null,
		lastWindowEnd: null,
		spike: null,
	}
}

export function parsePackageOwnerSpikeState(
	value: unknown,
): PackageOwnerSpikeState | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const record = value as Record<string, unknown>
	if (record.version !== 1) return null
	if (
		record.status !== 'ok' &&
		record.status !== 'alerted' &&
		record.status !== 'pending'
	) {
		return null
	}
	const spike = parseSpikeSnapshot(record.spike)
	if (record.status === 'pending' && spike == null) return null
	return {
		version: 1,
		status: record.status,
		alertedAt: typeof record.alertedAt === 'string' ? record.alertedAt : null,
		pendingSince:
			typeof record.pendingSince === 'string' ? record.pendingSince : null,
		deliveryAttempts:
			typeof record.deliveryAttempts === 'number'
				? Math.max(0, Math.round(record.deliveryAttempts))
				: 0,
		consecutiveHealthyWindows:
			typeof record.consecutiveHealthyWindows === 'number'
				? Math.max(0, Math.round(record.consecutiveHealthyWindows))
				: 0,
		lastActivityAt:
			typeof record.lastActivityAt === 'string' ? record.lastActivityAt : null,
		lastWindowEnd:
			typeof record.lastWindowEnd === 'string' ? record.lastWindowEnd : null,
		spike,
	}
}

function parseSpikeSnapshot(value: unknown): PackageOwnerSpikeState['spike'] {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const record = value as Record<string, unknown>
	if (typeof record.startedAt !== 'string') return null
	if (typeof record.errors !== 'number' || typeof record.events !== 'number') {
		return null
	}
	const rate =
		record.rate === null
			? null
			: typeof record.rate === 'number'
				? record.rate
				: null
	const windowStart =
		typeof record.windowStart === 'string'
			? record.windowStart
			: typeof record.startedAt === 'string'
				? record.startedAt
				: null
	const windowEnd =
		typeof record.windowEnd === 'string'
			? record.windowEnd
			: typeof record.startedAt === 'string'
				? record.startedAt
				: null
	if (windowStart == null || windowEnd == null) return null
	return {
		startedAt: record.startedAt,
		windowStart,
		windowEnd,
		errors: Math.max(0, Math.round(record.errors)),
		events: Math.max(0, Math.round(record.events)),
		rate,
		packages: Array.isArray(record.packages)
			? record.packages
					.map(parsePackageSummary)
					.filter((row): row is PackageOwnerSpikePackageSummary => row != null)
			: [],
		byMetric: Array.isArray(record.byMetric)
			? record.byMetric
					.map(parseMetricSummary)
					.filter((row): row is PackageOwnerSpikeMetricSummary => row != null)
			: [],
	}
}

function parsePackageSummary(
	value: unknown,
): PackageOwnerSpikePackageSummary | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const record = value as Record<string, unknown>
	if (
		typeof record.kody_id !== 'string' ||
		record.kody_id.trim().length === 0
	) {
		return null
	}
	if (typeof record.events !== 'number' || typeof record.errors !== 'number') {
		return null
	}
	return {
		kody_id: record.kody_id.trim(),
		events: Math.max(0, Math.round(record.events)),
		errors: Math.max(0, Math.round(record.errors)),
		rate:
			record.rate === null
				? null
				: typeof record.rate === 'number'
					? record.rate
					: null,
	}
}

function parseMetricSummary(
	value: unknown,
): PackageOwnerSpikeMetricSummary | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const record = value as Record<string, unknown>
	if (
		typeof record.metric !== 'string' ||
		!(fleetPackageErrorRateMetrics as ReadonlyArray<string>).includes(
			record.metric,
		)
	) {
		return null
	}
	if (typeof record.events !== 'number' || typeof record.errors !== 'number') {
		return null
	}
	return {
		metric: record.metric as PackageOwnerSpikeMetricSummary['metric'],
		events: Math.max(0, Math.round(record.events)),
		errors: Math.max(0, Math.round(record.errors)),
		rate:
			record.rate === null
				? null
				: typeof record.rate === 'number'
					? record.rate
					: null,
	}
}

export function buildPackageOwnerErrorSpikePackageQuery(input: {
	dataset: string
	windowStart: Date
	windowEnd: Date
}) {
	const metrics = packageMetrics.map((metric) => `'${metric}'`).join(', ')
	return `
SELECT
	blob3 AS package_id,
	blob2 AS metric,
	sum(_sample_interval) AS event_count,
	sum(if(blob4 = 'error', _sample_interval, 0)) AS error_count
FROM ${input.dataset}
WHERE timestamp >= toDateTime('${toAnalyticsDateTime(input.windowStart)}')
	AND timestamp < toDateTime('${toAnalyticsDateTime(input.windowEnd)}')
	AND blob2 IN (${metrics})
	AND blob3 != ''
GROUP BY package_id, metric
ORDER BY error_count DESC
LIMIT ${packageOwnerErrorSpikeMaxPackageRows}
FORMAT JSON
`.trim()
}

export function buildPackageOwnerErrorSpikeAccountQuery(input: {
	dataset: string
	windowStart: Date
	windowEnd: Date
}) {
	const metrics = accountMetrics.map((metric) => `'${metric}'`).join(', ')
	return `
SELECT
	blob1 AS owner_id,
	blob2 AS metric,
	sum(_sample_interval) AS event_count,
	sum(if(blob4 = 'error', _sample_interval, 0)) AS error_count
FROM ${input.dataset}
WHERE timestamp >= toDateTime('${toAnalyticsDateTime(input.windowStart)}')
	AND timestamp < toDateTime('${toAnalyticsDateTime(input.windowEnd)}')
	AND blob2 IN (${metrics})
GROUP BY owner_id, metric
ORDER BY error_count DESC
LIMIT ${packageOwnerErrorSpikeMaxOwnersPerSweep}
FORMAT JSON
`.trim()
}

/**
 * Fold package-metric rows (resolved to owners) and account-metric rows into
 * per-owner windows. Package static-call / export errors attribute to the
 * package publisher (any caller); job / workflow errors attribute to the
 * billing owner that ran them.
 */
export function foldPackageOwnerSpikeWindows(input: {
	windowStart: Date
	windowEnd: Date
	packageRows: ReadonlyArray<PackageOwnerErrorSpikePackageRow>
	accountRows: ReadonlyArray<PackageOwnerErrorSpikeAccountRow>
	packageOwners: ReadonlyMap<string, { ownerId: string; kodyId: string }>
}) {
	const byOwner = new Map<
		string,
		{
			events: number
			errors: number
			packages: Map<string, { events: number; errors: number }>
			metrics: Map<string, { events: number; errors: number }>
		}
	>()

	const touch = (ownerId: string) => {
		const existing = byOwner.get(ownerId)
		if (existing) return existing
		const created = {
			events: 0,
			errors: 0,
			packages: new Map<string, { events: number; errors: number }>(),
			metrics: new Map<string, { events: number; errors: number }>(),
		}
		byOwner.set(ownerId, created)
		return created
	}

	for (const row of input.packageRows) {
		const packageId = row.package_id?.trim() ?? ''
		const metric = row.metric?.trim() ?? ''
		if (!packageId || !analyticsEngineIdPattern.test(packageId)) continue
		const owner = input.packageOwners.get(packageId)
		if (!owner) continue
		const events = Math.max(0, Math.round(Number(row.event_count ?? 0)))
		const errors = Math.max(0, Math.round(Number(row.error_count ?? 0)))
		if (events <= 0 && errors <= 0) continue
		const bucket = touch(owner.ownerId)
		bucket.events += events
		bucket.errors += errors
		const pkg = bucket.packages.get(owner.kodyId) ?? { events: 0, errors: 0 }
		pkg.events += events
		pkg.errors += errors
		bucket.packages.set(owner.kodyId, pkg)
		if (
			(fleetPackageErrorRateMetrics as ReadonlyArray<string>).includes(metric)
		) {
			const metricBucket = bucket.metrics.get(metric) ?? {
				events: 0,
				errors: 0,
			}
			metricBucket.events += events
			metricBucket.errors += errors
			bucket.metrics.set(metric, metricBucket)
		}
	}

	for (const row of input.accountRows) {
		const ownerId = row.owner_id?.trim() ?? ''
		const metric = row.metric?.trim() ?? ''
		if (!ownerId || !analyticsEngineIdPattern.test(ownerId)) continue
		const events = Math.max(0, Math.round(Number(row.event_count ?? 0)))
		const errors = Math.max(0, Math.round(Number(row.error_count ?? 0)))
		if (events <= 0 && errors <= 0) continue
		const bucket = touch(ownerId)
		bucket.events += events
		bucket.errors += errors
		if (
			(fleetPackageErrorRateMetrics as ReadonlyArray<string>).includes(metric)
		) {
			const metricBucket = bucket.metrics.get(metric) ?? {
				events: 0,
				errors: 0,
			}
			metricBucket.events += events
			metricBucket.errors += errors
			bucket.metrics.set(metric, metricBucket)
		}
	}

	const windows: Array<PackageOwnerSpikeWindow> = []
	for (const [ownerId, bucket] of byOwner) {
		const combined = countsOf(bucket.events, bucket.errors)
		windows.push({
			ownerId,
			windowStart: input.windowStart.toISOString(),
			windowEnd: input.windowEnd.toISOString(),
			events: combined.events,
			errors: combined.errors,
			rate: combined.rate,
			packages: [...bucket.packages.entries()]
				.map(([kody_id, counts]) => ({
					kody_id,
					...countsOf(counts.events, counts.errors),
				}))
				.sort((left, right) => right.errors - left.errors)
				.slice(0, packageOwnerErrorSpikeMaxNamedPackages),
			byMetric: fleetPackageErrorRateMetrics
				.map((metric) => {
					const counts = bucket.metrics.get(metric) ?? { events: 0, errors: 0 }
					return { metric, ...countsOf(counts.events, counts.errors) }
				})
				.filter((row) => row.events > 0 || row.errors > 0),
		})
	}
	return windows.sort((left, right) => right.errors - left.errors)
}

export async function loadPackageOwnersByPackageIds(
	db: D1Database,
	packageIds: ReadonlyArray<string>,
) {
	const owners = new Map<string, { ownerId: string; kodyId: string }>()
	for (const chunk of chunkArray([...packageIds], maxSqlBindingsPerChunk)) {
		if (chunk.length === 0) continue
		const placeholders = chunk.map(() => '?').join(', ')
		const result = await db
			.prepare(
				`SELECT id, user_id, kody_id
				FROM saved_packages
				WHERE id IN (${placeholders})${andLiveDeletedAtSql()}`,
			)
			.bind(...chunk)
			.all<{ id: string; user_id: string; kody_id: string }>()
		for (const row of result.results ?? []) {
			const ownerId = row.user_id.trim()
			const kodyId = row.kody_id.trim()
			if (!ownerId || !kodyId) continue
			owners.set(row.id, { ownerId, kodyId })
		}
	}
	return owners
}

export async function loadPackageOwnerSpikeState(
	kv: KVNamespace,
	ownerId: string,
): Promise<PackageOwnerSpikeState | null> {
	try {
		return parsePackageOwnerSpikeState(
			await kv.get(packageOwnerErrorSpikeKvKey(ownerId), 'json'),
		)
	} catch (error) {
		console.debug('package-owner-error-spike-state-read-failed', {
			ownerId,
			error,
		})
		return null
	}
}

export async function writePackageOwnerSpikeState(input: {
	kv: KVNamespace
	ownerId: string
	state: PackageOwnerSpikeState
	previousStatus?: PackageOwnerSpikeStateStatus | null
	/** When set, index membership is deferred to one write at end of sweep. */
	indexDraft?: AlertedOwnerIndexDraft
}) {
	await input.kv.put(
		packageOwnerErrorSpikeKvKey(input.ownerId),
		JSON.stringify(input.state),
		{ expirationTtl: stateTtlSeconds },
	)
	const previous = input.previousStatus ?? null
	if (input.indexDraft) {
		applyAlertedOwnerIndexMembership({
			draft: input.indexDraft,
			ownerId: input.ownerId,
			status: input.state.status,
			previousStatus: previous,
		})
		return
	}
	// Fallback path (tests / single-owner writes): one index rewrite.
	const existing = await readAlertedOwnerIndex(input.kv)
	const draft: AlertedOwnerIndexDraft = {
		ownerIds: new Set(existing),
		dirty: false,
	}
	applyAlertedOwnerIndexMembership({
		draft,
		ownerId: input.ownerId,
		status: input.state.status,
		previousStatus: previous,
	})
	if (draft.dirty) {
		await writeAlertedOwnerIndex(input.kv, [...draft.ownerIds])
	}
}

function isIndexedSpikeStatus(status: PackageOwnerSpikeStateStatus | null) {
	return status === 'alerted' || status === 'pending'
}

function applyAlertedOwnerIndexMembership(input: {
	draft: AlertedOwnerIndexDraft
	ownerId: string
	status: PackageOwnerSpikeStateStatus
	previousStatus: PackageOwnerSpikeStateStatus | null
}) {
	if (isIndexedSpikeStatus(input.status)) {
		// Refresh index TTL whenever an in-sample episode is rewritten so a
		// long pending/alerted stretch cannot lose inactivity tracking.
		input.draft.ownerIds.add(input.ownerId)
		input.draft.dirty = true
		return
	}
	if (isIndexedSpikeStatus(input.previousStatus)) {
		input.draft.ownerIds.delete(input.ownerId)
		input.draft.dirty = true
	}
}

async function readAlertedOwnerIndex(kv: KVNamespace): Promise<Array<string>> {
	try {
		const value = await kv.get(packageOwnerErrorSpikeAlertedIndexKvKey, 'json')
		if (!Array.isArray(value)) return []
		return value.filter(
			(entry): entry is string =>
				typeof entry === 'string' && entry.trim().length > 0,
		)
	} catch (error) {
		console.debug('package-owner-error-spike-alerted-index-read-failed', error)
		return []
	}
}

async function writeAlertedOwnerIndex(
	kv: KVNamespace,
	ownerIds: Iterable<string>,
) {
	await kv.put(
		packageOwnerErrorSpikeAlertedIndexKvKey,
		JSON.stringify([...new Set(ownerIds)].sort()),
		{ expirationTtl: stateTtlSeconds },
	)
}

export type PackageOwnerErrorSpikeRefreshResult =
	| {
			status: 'skipped'
			reason: 'missing-analytics-config' | 'query_failed' | 'no_kv' | 'no_db'
	  }
	| {
			status: 'refreshed'
			ownersEvaluated: number
			alerted: number
			rearmed: number
	  }

/**
 * Recompute the last completed UTC hour per package owner and apply
 * ok↔alerted transitions. Callers send mail / admin events for `alert`.
 */
export async function refreshPackageOwnerErrorSpikes(input: {
	env: PackageOwnerErrorSpikeEnv
	now?: Date
	onAlert?: (input: {
		ownerId: string
		window: PackageOwnerSpikeWindow
		state: PackageOwnerSpikeState
	}) => Promise<void>
}): Promise<PackageOwnerErrorSpikeRefreshResult> {
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	const db = input.env.APP_DB
	if (!kv) return { status: 'skipped', reason: 'no_kv' }
	if (!db) return { status: 'skipped', reason: 'no_db' }

	const accountId = input.env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = input.env.CLOUDFLARE_API_TOKEN?.trim()
	if (!input.env.USAGE_EVENTS || !accountId || !apiToken) {
		return { status: 'skipped', reason: 'missing-analytics-config' }
	}

	const now = input.now ?? new Date()
	const windowEnd = alignToUtcHour(now)
	const windowStart = new Date(windowEnd.getTime() - 60 * 60 * 1000)
	const dataset = resolveUsageEventsDataset(input.env)
	const baseUrl =
		input.env.CLOUDFLARE_API_BASE_URL?.trim() || 'https://api.cloudflare.com'

	let packageRows: Array<PackageOwnerErrorSpikePackageRow>
	let accountRows: Array<PackageOwnerErrorSpikeAccountRow>
	try {
		;[packageRows, accountRows] = await Promise.all([
			queryAnalyticsEngineSql<PackageOwnerErrorSpikePackageRow>({
				accountId,
				apiToken,
				baseUrl,
				query: buildPackageOwnerErrorSpikePackageQuery({
					dataset,
					windowStart,
					windowEnd,
				}),
			}),
			queryAnalyticsEngineSql<PackageOwnerErrorSpikeAccountRow>({
				accountId,
				apiToken,
				baseUrl,
				query: buildPackageOwnerErrorSpikeAccountQuery({
					dataset,
					windowStart,
					windowEnd,
				}),
			}),
		])
	} catch (error) {
		console.warn('package-owner-error-spike-query-failed', error)
		return { status: 'skipped', reason: 'query_failed' }
	}

	const packageIds = [
		...new Set(
			packageRows
				.map((row) => row.package_id?.trim() ?? '')
				.filter((id) => id.length > 0),
		),
	]
	let packageOwners: Map<string, { ownerId: string; kodyId: string }>
	try {
		packageOwners = await loadPackageOwnersByPackageIds(db, packageIds)
	} catch (error) {
		console.warn('package-owner-error-spike-package-owners-failed', error)
		return { status: 'skipped', reason: 'query_failed' }
	}

	const windows = foldPackageOwnerSpikeWindows({
		windowStart,
		windowEnd,
		packageRows,
		accountRows,
		packageOwners,
	}).slice(0, packageOwnerErrorSpikeMaxOwnersPerSweep)

	const indexedOwnerIds = await readAlertedOwnerIndex(kv)
	const indexDraft: AlertedOwnerIndexDraft = {
		ownerIds: new Set(indexedOwnerIds),
		dirty: false,
	}

	let alerted = 0
	let rearmed = 0
	const evaluated = new Set<string>()

	for (const window of windows) {
		evaluated.add(window.ownerId)
		const previous = await loadPackageOwnerSpikeState(kv, window.ownerId)
		const transition = evaluatePackageOwnerSpikeTransition({
			previous,
			window,
			now,
		})
		const outcome = await applyPackageOwnerSpikeTransition({
			kv,
			ownerId: window.ownerId,
			previous,
			transition,
			window,
			now,
			onAlert: input.onAlert,
			indexDraft,
		})
		alerted += outcome.alerted
		rearmed += outcome.rearmed
	}

	// Indexed owners missing from this hour's top sample may still be
	// erroring under the LIMIT — do not treat absence as inactivity, and do
	// not refresh TTLs forever. Pending owners still get delivery retries.
	// Alerted owners only re-arm when lastActivityAt is stale (or missing);
	// action none leaves state and the index untouched.
	for (const ownerId of indexedOwnerIds) {
		if (evaluated.has(ownerId)) continue
		const previous = await loadPackageOwnerSpikeState(kv, ownerId)
		if (!previous || !isIndexedSpikeStatus(previous.status)) continue
		const transition = evaluatePackageOwnerSpikeTransition({
			previous,
			window: null,
			now,
		})
		if (transition.action === 'none') {
			evaluated.add(ownerId)
			continue
		}
		const outcome = await applyPackageOwnerSpikeTransition({
			kv,
			ownerId,
			previous,
			transition,
			window: null,
			now,
			onAlert: input.onAlert,
			indexDraft,
		})
		alerted += outcome.alerted
		rearmed += outcome.rearmed
		evaluated.add(ownerId)
	}

	// One index write per sweep (Workers KV: 1 write/sec/key). Owner states
	// are already committed, so a failed index write cannot re-send emails.
	if (indexDraft.dirty) {
		try {
			await writeAlertedOwnerIndex(kv, indexDraft.ownerIds)
		} catch (error) {
			console.warn(
				'package-owner-error-spike-alerted-index-write-failed',
				error,
			)
		}
	}

	return {
		status: 'refreshed',
		ownersEvaluated: evaluated.size,
		alerted,
		rearmed,
	}
}

async function applyPackageOwnerSpikeTransition(input: {
	kv: KVNamespace
	ownerId: string
	previous: PackageOwnerSpikeState | null
	transition: PackageOwnerSpikeTransition
	window: PackageOwnerSpikeWindow | null
	now: Date
	onAlert?: (input: {
		ownerId: string
		window: PackageOwnerSpikeWindow
		state: PackageOwnerSpikeState
	}) => Promise<void>
	indexDraft: AlertedOwnerIndexDraft
}): Promise<{ alerted: number; rearmed: number }> {
	const previousStatus = input.previous?.status ?? null
	const { transition } = input

	if (transition.action === 'alert' || transition.action === 'retry_alert') {
		const deliveryWindow =
			packageOwnerSpikeWindowFromState({
				ownerId: input.ownerId,
				state: transition.next,
			}) ?? input.window
		if (!deliveryWindow || !transition.next.spike) {
			await writePackageOwnerSpikeState({
				kv: input.kv,
				ownerId: input.ownerId,
				state: emptyOwnerSpikeState(),
				previousStatus,
				indexDraft: input.indexDraft,
			})
			return { alerted: 0, rearmed: 1 }
		}

		const pendingBase: PackageOwnerSpikeState = {
			...transition.next,
			status: 'pending',
			alertedAt: null,
			pendingSince: transition.next.pendingSince ?? input.now.toISOString(),
			deliveryAttempts: transition.next.deliveryAttempts,
			spike: transition.next.spike,
		}

		if (input.onAlert) {
			try {
				await input.onAlert({
					ownerId: input.ownerId,
					window: deliveryWindow,
					state: pendingBase,
				})
			} catch (error) {
				console.warn('package-owner-error-spike-alert-callback-failed', {
					ownerId: input.ownerId,
					error,
				})
				const attempts = pendingBase.deliveryAttempts + 1
				const failedPending: PackageOwnerSpikeState = {
					...pendingBase,
					deliveryAttempts: attempts,
					pendingSince: pendingBase.pendingSince ?? input.now.toISOString(),
				}
				if (
					isPendingSpikeExpired({
						state: failedPending,
						now: input.now,
					})
				) {
					await writePackageOwnerSpikeState({
						kv: input.kv,
						ownerId: input.ownerId,
						state: {
							...emptyOwnerSpikeState(),
							lastActivityAt: failedPending.lastActivityAt,
							lastWindowEnd: failedPending.lastWindowEnd,
						},
						previousStatus,
						indexDraft: input.indexDraft,
					})
					return { alerted: 0, rearmed: 1 }
				}
				// Retain the triggering snapshot so a quieter next hour still
				// retries delivery instead of dropping the episode.
				await writePackageOwnerSpikeState({
					kv: input.kv,
					ownerId: input.ownerId,
					state: failedPending,
					previousStatus,
					indexDraft: input.indexDraft,
				})
				return { alerted: 0, rearmed: 0 }
			}
		}

		// Persist alerted only after a successful (or no-op) notify so a
		// failed send cannot suppress the one email for this spike.
		await writePackageOwnerSpikeState({
			kv: input.kv,
			ownerId: input.ownerId,
			state: {
				...pendingBase,
				status: 'alerted',
				alertedAt: input.now.toISOString(),
				pendingSince: null,
				deliveryAttempts: 0,
			},
			previousStatus,
			indexDraft: input.indexDraft,
		})
		return { alerted: 1, rearmed: 0 }
	}

	await writePackageOwnerSpikeState({
		kv: input.kv,
		ownerId: input.ownerId,
		state: transition.next,
		previousStatus,
		indexDraft: input.indexDraft,
	})
	if (transition.action === 'rearm' || transition.action === 'abandon') {
		return { alerted: 0, rearmed: 1 }
	}
	return { alerted: 0, rearmed: 0 }
}

function toAnalyticsDateTime(date: Date) {
	return date.toISOString().slice(0, 19).replace('T', ' ')
}
