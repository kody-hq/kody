import {
	queryAnalyticsEngineSql,
	resolveUsageEventsDataset,
} from './aggregate-rollups.ts'
import {
	parseFleetPackageErrorRateConcentration,
	resolveFleetPackageErrorRateConcentration,
} from './fleet-package-error-rate-concentration.ts'
import {
	fleetPackageErrorRateMetrics,
	type FleetPackageErrorRateConcentration,
	type FleetPackageErrorRateCounts,
	type FleetPackageErrorRateElevationReason,
	type FleetPackageErrorRateMetric,
	type FleetPackageErrorRateWindowKind,
	type FleetPackageErrorRateWindowSnapshot,
} from './fleet-package-error-rate-subscription-event.ts'

export const fleetPackageErrorRateKvKey = 'fleet-package-error-rate:v1'

/** Completed-hour windows: last 1h vs the hour before. */
export const fleetPackageErrorRateHourWindowMs = 60 * 60 * 1000
/** Completed-hour-aligned day windows: last 24h vs the 24h before. */
export const fleetPackageErrorRateDayWindowMs = 24 * 60 * 60 * 1000

export const fleetPackageErrorRateMinHourEvents = 20
export const fleetPackageErrorRateMinDayEvents = 50
export const fleetPackageErrorRateMinRecentRate = 0.05
export const fleetPackageErrorRateAbsoluteDelta = 0.05
export const fleetPackageErrorRateRelativeFactor = 2
export const fleetPackageErrorRateAlertCooldownMinutes = 6 * 60

const hourMs = fleetPackageErrorRateHourWindowMs

export type FleetPackageErrorRateEnv = {
	USAGE_EVENTS?: AnalyticsEngineDataset
	APP_DB?: D1Database
	BUNDLE_ARTIFACTS_KV?: KVNamespace
	APP_BASE_URL?: string
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_TOKEN?: string
	CLOUDFLARE_API_BASE_URL?: string
	SENTRY_ENVIRONMENT?: string
}

export type FleetPackageErrorRateComparison = {
	kind: FleetPackageErrorRateWindowKind
	recent: FleetPackageErrorRateWindowSnapshot
	previous: FleetPackageErrorRateWindowSnapshot
}

export type FleetPackageErrorRateSnapshot = {
	version: 1
	updatedAt: string
	environment: string
	day: FleetPackageErrorRateComparison
	hour: FleetPackageErrorRateComparison
	lastAlertAt: string | null
	lastAlertEventId: string | null
	/**
	 * Who owns the recent-window error spike. Null when the rate is not
	 * elevated, the concentration query failed, or owners could not be
	 * resolved. Never includes user ids, emails, or package UUIDs.
	 */
	concentration: FleetPackageErrorRateConcentration | null
}

export type FleetPackageErrorRateElevation = {
	kind: FleetPackageErrorRateWindowKind
	reason: FleetPackageErrorRateElevationReason
	comparison: FleetPackageErrorRateComparison
}

export function isFleetPackageErrorRateMetric(
	value: string,
): value is FleetPackageErrorRateMetric {
	return (fleetPackageErrorRateMetrics as ReadonlyArray<string>).includes(value)
}

export function alignToUtcHour(now: Date) {
	return new Date(
		Date.UTC(
			now.getUTCFullYear(),
			now.getUTCMonth(),
			now.getUTCDate(),
			now.getUTCHours(),
		),
	)
}

export function countsOf(
	events: number,
	errors: number,
): FleetPackageErrorRateCounts {
	const safeEvents = Math.max(0, Math.round(events))
	const safeErrors = Math.max(0, Math.min(safeEvents, Math.round(errors)))
	return {
		events: safeEvents,
		errors: safeErrors,
		rate: safeEvents === 0 ? null : safeErrors / safeEvents,
	}
}

export function emptyMetricCounts(): Record<
	FleetPackageErrorRateMetric,
	FleetPackageErrorRateCounts
> {
	return {
		package_export: countsOf(0, 0),
		package_static_call: countsOf(0, 0),
		job_run: countsOf(0, 0),
		workflow_run: countsOf(0, 0),
	}
}

export function combineMetricCounts(
	byMetric: Record<FleetPackageErrorRateMetric, FleetPackageErrorRateCounts>,
) {
	let events = 0
	let errors = 0
	for (const metric of fleetPackageErrorRateMetrics) {
		events += byMetric[metric].events
		errors += byMetric[metric].errors
	}
	return countsOf(events, errors)
}

export function toWindowSnapshot(input: {
	start: Date
	end: Date
	byMetric: Record<FleetPackageErrorRateMetric, FleetPackageErrorRateCounts>
}): FleetPackageErrorRateWindowSnapshot {
	const combined = combineMetricCounts(input.byMetric)
	return {
		start: input.start.toISOString(),
		end: input.end.toISOString(),
		combined,
		by_metric: fleetPackageErrorRateMetrics.map((metric) => ({
			metric,
			...input.byMetric[metric],
		})),
	}
}

export function detectFleetPackageErrorRateElevation(input: {
	comparison: FleetPackageErrorRateComparison
	minEvents: number
}): FleetPackageErrorRateElevation | null {
	const recent = input.comparison.recent.combined
	const previous = input.comparison.previous.combined
	if (recent.rate == null || recent.events < input.minEvents) return null
	if (recent.rate < fleetPackageErrorRateMinRecentRate) return null
	if (previous.events < input.minEvents || previous.rate == null) return null

	if (previous.rate === 0) {
		return {
			kind: input.comparison.kind,
			reason: 'from_zero',
			comparison: input.comparison,
		}
	}
	if (recent.rate >= previous.rate + fleetPackageErrorRateAbsoluteDelta) {
		return {
			kind: input.comparison.kind,
			reason: 'absolute_delta',
			comparison: input.comparison,
		}
	}
	if (recent.rate >= previous.rate * fleetPackageErrorRateRelativeFactor) {
		return {
			kind: input.comparison.kind,
			reason: 'relative_factor',
			comparison: input.comparison,
		}
	}
	return null
}

export function chooseFleetPackageErrorRateElevation(input: {
	hour: FleetPackageErrorRateComparison
	day: FleetPackageErrorRateComparison
}) {
	const day = detectFleetPackageErrorRateElevation({
		comparison: input.day,
		minEvents: fleetPackageErrorRateMinDayEvents,
	})
	if (day) return day
	return detectFleetPackageErrorRateElevation({
		comparison: input.hour,
		minEvents: fleetPackageErrorRateMinHourEvents,
	})
}

export function parseFleetPackageErrorRateSnapshot(
	value: unknown,
): FleetPackageErrorRateSnapshot | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const record = value as Record<string, unknown>
	if (record.version !== 1) return null
	if (typeof record.updatedAt !== 'string') return null
	if (typeof record.environment !== 'string') return null
	const day = parseComparison(record.day, 'day')
	const hour = parseComparison(record.hour, 'hour')
	if (!day || !hour) return null
	return {
		version: 1,
		updatedAt: record.updatedAt,
		environment: record.environment,
		day,
		hour,
		lastAlertAt:
			typeof record.lastAlertAt === 'string' ? record.lastAlertAt : null,
		lastAlertEventId:
			typeof record.lastAlertEventId === 'string'
				? record.lastAlertEventId
				: null,
		concentration: parseFleetPackageErrorRateConcentration(
			record.concentration,
		),
	}
}

function parseComparison(
	value: unknown,
	kind: FleetPackageErrorRateWindowKind,
): FleetPackageErrorRateComparison | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const record = value as Record<string, unknown>
	const recent = parseWindowSnapshot(record.recent)
	const previous = parseWindowSnapshot(record.previous)
	if (!recent || !previous) return null
	return { kind, recent, previous }
}

function parseWindowSnapshot(
	value: unknown,
): FleetPackageErrorRateWindowSnapshot | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const record = value as Record<string, unknown>
	if (typeof record.start !== 'string' || typeof record.end !== 'string') {
		return null
	}
	const combined = parseCounts(record.combined)
	if (!combined) return null
	if (!Array.isArray(record.by_metric)) return null
	const byMetric = emptyMetricCounts()
	for (const entry of record.by_metric) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
		const row = entry as Record<string, unknown>
		if (
			typeof row.metric !== 'string' ||
			!isFleetPackageErrorRateMetric(row.metric)
		) {
			continue
		}
		const counts = parseCounts(row)
		if (counts) byMetric[row.metric] = counts
	}
	return {
		start: record.start,
		end: record.end,
		combined,
		by_metric: fleetPackageErrorRateMetrics.map((metric) => ({
			metric,
			...byMetric[metric],
		})),
	}
}

function parseCounts(value: unknown): FleetPackageErrorRateCounts | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const record = value as Record<string, unknown>
	if (typeof record.events !== 'number' || typeof record.errors !== 'number') {
		return null
	}
	const rate =
		record.rate === null
			? null
			: typeof record.rate === 'number'
				? record.rate
				: null
	const counts = countsOf(record.events, record.errors)
	return { ...counts, rate: rate ?? counts.rate }
}

export async function loadFleetPackageErrorRateSnapshot(
	env: Pick<FleetPackageErrorRateEnv, 'BUNDLE_ARTIFACTS_KV'>,
): Promise<FleetPackageErrorRateSnapshot | null> {
	const kv = env.BUNDLE_ARTIFACTS_KV
	if (!kv) return null
	try {
		return parseFleetPackageErrorRateSnapshot(
			await kv.get(fleetPackageErrorRateKvKey, 'json'),
		)
	} catch (error) {
		console.debug('fleet-package-error-rate-kv-read-failed', error)
		return null
	}
}

export function buildFleetPackageErrorRateAnalyticsQuery(input: {
	dataset: string
	previousStart: Date
	recentStart: Date
	recentEnd: Date
}) {
	const metrics = fleetPackageErrorRateMetrics
		.map((metric) => `'${metric}'`)
		.join(', ')
	// Count only `error` outcomes. `package_static_call` may also write
	// `caught` (throw handled by a successful run); those must not inflate
	// the fleet alert rate or concentration shares.
	return `
SELECT
	if(timestamp >= toDateTime('${toAnalyticsDateTime(input.recentStart)}'), 'recent', 'previous') AS window,
	blob2 AS metric,
	sum(_sample_interval) AS event_count,
	sum(if(blob4 = 'error', _sample_interval, 0)) AS error_count
FROM ${input.dataset}
WHERE timestamp >= toDateTime('${toAnalyticsDateTime(input.previousStart)}')
	AND timestamp < toDateTime('${toAnalyticsDateTime(input.recentEnd)}')
	AND blob2 IN (${metrics})
GROUP BY window, metric
FORMAT JSON
`.trim()
}

export function foldAnalyticsWindowRows(
	rows: ReadonlyArray<{
		window?: string
		metric?: string
		event_count?: number | string
		error_count?: number | string
	}>,
	bounds: { start: Date; end: Date; window: 'recent' | 'previous' },
) {
	const byMetric = emptyMetricCounts()
	for (const row of rows) {
		if (row.window !== bounds.window) continue
		if (
			typeof row.metric !== 'string' ||
			!isFleetPackageErrorRateMetric(row.metric)
		) {
			continue
		}
		byMetric[row.metric] = countsOf(
			Number(row.event_count ?? 0),
			Number(row.error_count ?? 0),
		)
	}
	return toWindowSnapshot({
		start: bounds.start,
		end: bounds.end,
		byMetric,
	})
}

export function resolveFleetPackageErrorRateEnvironment(env: {
	SENTRY_ENVIRONMENT?: string
}) {
	const value = env.SENTRY_ENVIRONMENT?.trim()
	return value && value.length > 0 ? value : 'unknown'
}

export type FleetPackageErrorRateSnapshotResult =
	| {
			status: 'skipped'
			reason: 'missing-analytics-config' | 'query_failed' | 'no_kv'
	  }
	| {
			status: 'refreshed'
			snapshot: FleetPackageErrorRateSnapshot
			elevation: FleetPackageErrorRateElevation | null
	  }

/**
 * Recompute fleet package-runtime error rates from Analytics Engine and
 * persist the KV snapshot for `/admin/insights`. Totals stay anonymous;
 * an elevated refresh may attach named concentration (usernames and
 * package kody ids only).
 */
export async function refreshFleetPackageErrorRateSnapshot(input: {
	env: FleetPackageErrorRateEnv
	now?: Date
}): Promise<FleetPackageErrorRateSnapshotResult> {
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	if (!kv) return { status: 'skipped', reason: 'no_kv' }

	const accountId = input.env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = input.env.CLOUDFLARE_API_TOKEN?.trim()
	if (!input.env.USAGE_EVENTS || !accountId || !apiToken) {
		console.debug(
			'fleet-package-error-rate-refresh-skipped',
			'missing USAGE_EVENTS binding or Cloudflare REST credentials',
		)
		return { status: 'skipped', reason: 'missing-analytics-config' }
	}

	const now = input.now ?? new Date()
	const asOf = alignToUtcHour(now)
	const hourRecentEnd = asOf
	const hourRecentStart = new Date(asOf.getTime() - hourMs)
	const hourPreviousStart = new Date(asOf.getTime() - 2 * hourMs)
	const dayRecentStart = new Date(
		asOf.getTime() - fleetPackageErrorRateDayWindowMs,
	)
	const dayPreviousStart = new Date(
		asOf.getTime() - 2 * fleetPackageErrorRateDayWindowMs,
	)

	const dataset = resolveUsageEventsDataset(input.env)
	const baseUrl =
		input.env.CLOUDFLARE_API_BASE_URL?.trim() || 'https://api.cloudflare.com'
	type AnalyticsRow = {
		window: string
		metric: string
		event_count: number | string
		error_count: number | string
	}
	let hourRows: Array<AnalyticsRow>
	let dayRows: Array<AnalyticsRow>
	try {
		;[hourRows, dayRows] = await Promise.all([
			queryAnalyticsEngineSql<AnalyticsRow>({
				accountId,
				apiToken,
				baseUrl,
				query: buildFleetPackageErrorRateAnalyticsQuery({
					dataset,
					previousStart: hourPreviousStart,
					recentStart: hourRecentStart,
					recentEnd: hourRecentEnd,
				}),
			}),
			queryAnalyticsEngineSql<AnalyticsRow>({
				accountId,
				apiToken,
				baseUrl,
				query: buildFleetPackageErrorRateAnalyticsQuery({
					dataset,
					previousStart: dayPreviousStart,
					recentStart: dayRecentStart,
					recentEnd: hourRecentEnd,
				}),
			}),
		])
	} catch (error) {
		console.warn('fleet-package-error-rate-query-failed', error)
		return { status: 'skipped', reason: 'query_failed' }
	}

	const existing = await loadFleetPackageErrorRateSnapshot(input.env)
	const hour: FleetPackageErrorRateComparison = {
		kind: 'hour',
		recent: foldAnalyticsWindowRows(hourRows, {
			window: 'recent',
			start: hourRecentStart,
			end: hourRecentEnd,
		}),
		previous: foldAnalyticsWindowRows(hourRows, {
			window: 'previous',
			start: hourPreviousStart,
			end: hourRecentStart,
		}),
	}
	const day: FleetPackageErrorRateComparison = {
		kind: 'day',
		recent: foldAnalyticsWindowRows(dayRows, {
			window: 'recent',
			start: dayRecentStart,
			end: hourRecentEnd,
		}),
		previous: foldAnalyticsWindowRows(dayRows, {
			window: 'previous',
			start: dayPreviousStart,
			end: dayRecentStart,
		}),
	}

	const elevation = chooseFleetPackageErrorRateElevation({ hour, day })
	const snapshot: FleetPackageErrorRateSnapshot = {
		version: 1,
		updatedAt: now.toISOString(),
		environment: resolveFleetPackageErrorRateEnvironment(input.env),
		day,
		hour,
		lastAlertAt: existing?.lastAlertAt ?? null,
		lastAlertEventId: existing?.lastAlertEventId ?? null,
		concentration: elevation
			? await resolveElevatedConcentration({
					env: input.env,
					dataset,
					recentStart: elevation.comparison.recent.start,
					recentEnd: elevation.comparison.recent.end,
					recentErrors: elevation.comparison.recent.combined.errors,
				})
			: null,
	}

	await writeFleetPackageErrorRateSnapshot(kv, snapshot)
	return { status: 'refreshed', snapshot, elevation }
}

async function resolveElevatedConcentration(input: {
	env: FleetPackageErrorRateEnv
	dataset: string
	recentStart: string
	recentEnd: string
	recentErrors: number
}): Promise<FleetPackageErrorRateConcentration | null> {
	try {
		return await resolveFleetPackageErrorRateConcentration({
			env: input.env,
			dataset: input.dataset,
			recentStart: new Date(input.recentStart),
			recentEnd: new Date(input.recentEnd),
			recentErrors: input.recentErrors,
		})
	} catch (error) {
		console.warn('fleet-package-error-rate-concentration-failed', error)
		return null
	}
}

export async function writeFleetPackageErrorRateSnapshot(
	kv: KVNamespace,
	snapshot: FleetPackageErrorRateSnapshot,
) {
	await kv.put(fleetPackageErrorRateKvKey, JSON.stringify(snapshot))
}

function toAnalyticsDateTime(date: Date) {
	return date.toISOString().slice(0, 19).replace('T', ' ')
}
