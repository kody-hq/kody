/**
 * Feature-flag success-metric readout.
 *
 * Answers "is this flag moving its declared metric?" by joining recorded
 * flag exposures (see `exposure.ts`) with the usage-metering event stream
 * over the current UTC month to date, split by exposure cohort:
 *
 * - Users with any `override`-sourced exposure are excluded from the on/off
 *   comparison (hand-picked users are selection-biased). Their usage is
 *   aggregated into the separate `override` cohort so dogfood volume stays
 *   visible.
 * - Users with any `org`-sourced exposure (and no user override) got the
 *   value from a per-org row: a hand-picked team, so they are also excluded
 *   from on/off and aggregated into the `orgOverride` cohort.
 * - Users who saw both fair (non-override) values inside the window are
 *   counted as `mixedUsers` and excluded from on/off (month-level usage
 *   cannot be split at the switch without contaminating the later cohort).
 * - Everyone else lands in the `on` or `off` cohort from their only fair
 *   value, and their usage events for the declared `eventType` are
 *   aggregated per cohort.
 *
 * Like usage rollups, the data source depends on the environment: with the
 * Analytics Engine bindings and Cloudflare REST credentials
 * (production/preview) both sides come from Analytics Engine SQL queries;
 * otherwise (local dev, tests) the D1 fallback tables
 * (`feature_flag_exposure_rollups`, `usage_rollups`) are used. Readout
 * failures degrade to `{ status: 'unavailable' }` — the admin surfaces must
 * render even when the analytics backend is down.
 */

import {
	queryAnalyticsEngineSql,
	resolveUsageEventsDataset,
} from '#worker/usage/aggregate-rollups.ts'
import { type FeatureFlagSuccessMetric } from '#universal/feature-flags/registry.ts'
import {
	type AdminFeatureFlag,
	type AdminFeatureFlagMetricReadout,
	type FeatureFlagMetricCohort,
} from '#universal/feature-flags/types.ts'

export type FeatureFlagReadoutEnv = {
	APP_DB: D1Database
	FLAG_EXPOSURES?: AnalyticsEngineDataset
	USAGE_EVENTS?: AnalyticsEngineDataset
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_TOKEN?: string
	CLOUDFLARE_API_BASE_URL?: string
	SENTRY_ENVIRONMENT?: string
	WRANGLER_IS_LOCAL_DEV?: string
}

/**
 * The Analytics Engine SQL API dataset (= table name) written by the
 * `FLAG_EXPOSURES` binding; see `packages/worker/wrangler.jsonc`.
 */
export function resolveFlagExposuresDataset(env: {
	SENTRY_ENVIRONMENT?: string
}) {
	return env.SENTRY_ENVIRONMENT === 'preview'
		? 'kody_flag_exposures_preview'
		: 'kody_flag_exposures'
}

type UserExposureState = {
	sawOn: boolean
	sawOff: boolean
	sawOverride: boolean
	sawOrg: boolean
	/** Latest non-override on/off; null when the user only has override rows. */
	latestFairEnabled: boolean | null
	latestFairAt: string | null
}

type UserUsageAggregate = {
	eventCount: number
	errorCount: number
	totalDurationMs: number
}

function toCount(value: number | string | null | undefined) {
	const parsed = Number(value ?? 0)
	return Number.isFinite(parsed) ? Math.round(parsed) : 0
}

function emptyCohort(): FeatureFlagMetricCohort {
	return {
		users: 0,
		eventCount: 0,
		errorCount: 0,
		errorRate: null,
		avgDurationMs: null,
	}
}

function finalizeCohort(cohort: FeatureFlagMetricCohort, durationMs: number) {
	cohort.errorRate =
		cohort.eventCount > 0 ? cohort.errorCount / cohort.eventCount : null
	cohort.avgDurationMs =
		cohort.eventCount > 0 ? durationMs / cohort.eventCount : null
}

function applyUsageToCohort(
	cohort: FeatureFlagMetricCohort,
	totalsSide: { durationMs: number },
	usage: UserUsageAggregate | undefined,
) {
	cohort.users += 1
	if (!usage) return
	cohort.eventCount += usage.eventCount
	cohort.errorCount += usage.errorCount
	totalsSide.durationMs += usage.totalDurationMs
}

/**
 * Prefer the chronologically latest fair exposure. ISO timestamps and
 * `YYYY-MM-DD` day stamps both compare correctly as strings.
 */
function considerFairExposure(
	state: UserExposureState,
	enabled: boolean,
	at: string,
) {
	if (enabled) state.sawOn = true
	else state.sawOff = true
	if (state.latestFairAt === null || at > state.latestFairAt) {
		state.latestFairAt = at
		state.latestFairEnabled = enabled
	} else if (at === state.latestFairAt && state.latestFairEnabled !== enabled) {
		// Equal-timestamp on+off is ambiguous; leave null so buildReadout
		// excludes via mixed (sawOn && sawOff) rather than iteration order.
		state.latestFairEnabled = null
	}
}

function buildReadout(input: {
	exposuresByUser: Map<string, UserExposureState>
	usageByUser: Map<string, UserUsageAggregate>
	windowStart: string
	windowEnd: string
}): AdminFeatureFlagMetricReadout {
	const on = emptyCohort()
	const off = emptyCohort()
	const override = emptyCohort()
	const orgOverride = emptyCohort()
	let overrideUsers = 0
	let orgOverrideUsers = 0
	let mixedUsers = 0
	const totals = {
		on: { durationMs: 0 },
		off: { durationMs: 0 },
		override: { durationMs: 0 },
		orgOverride: { durationMs: 0 },
	}
	for (const [userId, state] of input.exposuresByUser) {
		const usage = input.usageByUser.get(userId)
		if (state.sawOverride) {
			overrideUsers += 1
			applyUsageToCohort(override, totals.override, usage)
			continue
		}
		if (state.sawOrg) {
			orgOverrideUsers += 1
			applyUsageToCohort(orgOverride, totals.orgOverride, usage)
			continue
		}
		if (state.sawOn && state.sawOff) {
			// Mid-window switchers stay out of on/off: month-level usage
			// aggregates cannot be split at the switch, so assigning by latest
			// would contaminate the later cohort with pre-switch events.
			mixedUsers += 1
			continue
		}
		if (state.latestFairEnabled === null) continue
		const cohort = state.latestFairEnabled ? on : off
		const totalsSide = state.latestFairEnabled ? totals.on : totals.off
		applyUsageToCohort(cohort, totalsSide, usage)
	}
	finalizeCohort(on, totals.on.durationMs)
	finalizeCohort(off, totals.off.durationMs)
	finalizeCohort(override, totals.override.durationMs)
	finalizeCohort(orgOverride, totals.orgOverride.durationMs)
	return {
		status: 'ok',
		windowStart: input.windowStart,
		windowEnd: input.windowEnd,
		on,
		off,
		override,
		overrideUsers,
		orgOverride,
		orgOverrideUsers,
		mixedUsers,
	}
}

function utcMonthWindow(now: Date) {
	const monthStart = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
	)
	return {
		windowStart: monthStart.toISOString(),
		windowEnd: now.toISOString(),
		monthStartDay: monthStart.toISOString().slice(0, 'YYYY-MM-DD'.length),
		month: monthStart.toISOString().slice(0, 'YYYY-MM'.length),
	}
}

/**
 * Registry flag keys and usage event types are code-owned kebab/snake-case
 * identifiers, but they are interpolated into Analytics Engine SQL (which
 * has no parameter binding), so reject anything that could break out of a
 * string literal.
 */
function assertSqlSafeIdentifier(value: string) {
	if (!/^[a-z0-9_-]+$/.test(value)) {
		throw new Error(`Unsafe identifier for Analytics Engine SQL: ${value}`)
	}
	return value
}

function toDateTimeArgument(iso: string) {
	return `${iso.slice(0, 'YYYY-MM-DD'.length)} 00:00:00`
}

type AnalyticsExposureRow = {
	user_id: string
	state: string
	source: string
	last_ts: string
}

type AnalyticsUsageRow = {
	user_id: string
	event_count: number | string
	error_count: number | string
	total_duration_ms: number | string
}

async function loadReadoutFromAnalyticsEngine(input: {
	env: FeatureFlagReadoutEnv
	accountId: string
	apiToken: string
	flagKey: string
	successMetric: FeatureFlagSuccessMetric
	now: Date
}): Promise<AdminFeatureFlagMetricReadout> {
	const window = utcMonthWindow(input.now)
	const baseUrl =
		input.env.CLOUDFLARE_API_BASE_URL?.trim() || 'https://api.cloudflare.com'
	// The window upper bound is exclusive at the *next day* boundary so both
	// datasets see the same time filter shape as the usage aggregation cron;
	// month-to-date plus today is exactly what the readout wants.
	const nextDay = new Date(input.now.getTime() + 24 * 60 * 60 * 1000)
	const timeFilter = `timestamp >= toDateTime('${toDateTimeArgument(window.windowStart)}') AND timestamp < toDateTime('${toDateTimeArgument(nextDay.toISOString())}')`
	// Analytics Engine rejects max() over String columns (HTTP 422), so the
	// latest exposure comes from the DateTime `timestamp`, not the ISO `blob5`.
	// It serializes as `YYYY-MM-DD HH:MM:SS`, which still compares as a string.
	const exposuresQuery = `
SELECT
	blob1 AS user_id,
	blob3 AS state,
	blob4 AS source,
	max(timestamp) AS last_ts
FROM ${resolveFlagExposuresDataset(input.env)}
WHERE ${timeFilter}
	AND blob2 = '${assertSqlSafeIdentifier(input.flagKey)}'
GROUP BY blob1, blob3, blob4
FORMAT JSON
`.trim()
	const usageQuery = `
SELECT
	blob1 AS user_id,
	sum(_sample_interval) AS event_count,
	sum(if(blob4 = 'error', _sample_interval, 0)) AS error_count,
	sum(double1 * _sample_interval) AS total_duration_ms
FROM ${resolveUsageEventsDataset(input.env)}
WHERE ${timeFilter}
	AND blob2 = '${assertSqlSafeIdentifier(input.successMetric.eventType)}'
GROUP BY blob1
FORMAT JSON
`.trim()
	const [exposureRows, usageRows] = await Promise.all([
		queryAnalyticsEngineSql<AnalyticsExposureRow>({
			accountId: input.accountId,
			apiToken: input.apiToken,
			baseUrl,
			query: exposuresQuery,
		}),
		queryAnalyticsEngineSql<AnalyticsUsageRow>({
			accountId: input.accountId,
			apiToken: input.apiToken,
			baseUrl,
			query: usageQuery,
		}),
	])
	const exposuresByUser = new Map<string, UserExposureState>()
	for (const row of exposureRows) {
		if (!row.user_id) continue
		const state = exposuresByUser.get(row.user_id) ?? {
			sawOn: false,
			sawOff: false,
			sawOverride: false,
			sawOrg: false,
			latestFairEnabled: null,
			latestFairAt: null,
		}
		if (row.source === 'override') {
			state.sawOverride = true
		} else if (row.source === 'org') {
			state.sawOrg = true
		} else {
			considerFairExposure(state, row.state === 'on', row.last_ts || '')
		}
		exposuresByUser.set(row.user_id, state)
	}
	const usageByUser = new Map<string, UserUsageAggregate>()
	for (const row of usageRows) {
		if (!row.user_id) continue
		usageByUser.set(row.user_id, {
			eventCount: toCount(row.event_count),
			errorCount: toCount(row.error_count),
			totalDurationMs: toCount(row.total_duration_ms),
		})
	}
	return buildReadout({
		exposuresByUser,
		usageByUser,
		windowStart: window.windowStart,
		windowEnd: window.windowEnd,
	})
}

type D1ExposureRow = {
	user_id: string
	enabled: number
	source: string
	last_day: string
	last_updated: string | null
}

type D1UsageRow = {
	user_id: string
	event_count: number
	error_count: number
	total_duration_ms: number
}

async function loadReadoutFromD1(input: {
	db: D1Database
	flagKey: string
	successMetric: FeatureFlagSuccessMetric
	now: Date
}): Promise<AdminFeatureFlagMetricReadout> {
	const window = utcMonthWindow(input.now)
	// The upper bound mirrors the Analytics Engine path: rows stamped after
	// the window end (clock skew, backdated writes) must not join the cohorts.
	const windowEndDay = window.windowEnd.slice(0, 'YYYY-MM-DD'.length)
	const exposureResult = await input.db
		.prepare(
			`SELECT user_id, enabled, source,
				MAX(day) AS last_day,
				MAX(updated_at) AS last_updated
			 FROM feature_flag_exposure_rollups
			 WHERE flag_key = ? AND day >= ? AND day <= ?
			 GROUP BY user_id, enabled, source`,
		)
		.bind(input.flagKey, window.monthStartDay, windowEndDay)
		.all<D1ExposureRow>()
	const exposuresByUser = new Map<string, UserExposureState>()
	for (const row of exposureResult.results ?? []) {
		const state = exposuresByUser.get(row.user_id) ?? {
			sawOn: false,
			sawOff: false,
			sawOverride: false,
			sawOrg: false,
			latestFairEnabled: null,
			latestFairAt: null,
		}
		if (row.source === 'override') {
			state.sawOverride = true
		} else if (row.source === 'org') {
			state.sawOrg = true
		} else {
			const at = row.last_updated || row.last_day || ''
			considerFairExposure(state, row.enabled === 1, at)
		}
		exposuresByUser.set(row.user_id, state)
	}
	const usageResult = await input.db
		.prepare(
			`SELECT user_id, event_count, error_count, total_duration_ms
			 FROM usage_rollups
			 WHERE metric = ? AND month = ?`,
		)
		.bind(input.successMetric.eventType, window.month)
		.all<D1UsageRow>()
	const usageByUser = new Map<string, UserUsageAggregate>()
	for (const row of usageResult.results ?? []) {
		usageByUser.set(row.user_id, {
			eventCount: toCount(row.event_count),
			errorCount: toCount(row.error_count),
			totalDurationMs: toCount(row.total_duration_ms),
		})
	}
	return buildReadout({
		exposuresByUser,
		usageByUser,
		windowStart: window.windowStart,
		windowEnd: window.windowEnd,
	})
}

export async function loadFeatureFlagSuccessMetricReadout(
	env: FeatureFlagReadoutEnv,
	input: { flagKey: string; successMetric: FeatureFlagSuccessMetric },
	now: Date = new Date(),
): Promise<AdminFeatureFlagMetricReadout> {
	try {
		const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
		const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()
		// Local Wrangler dev emulates the Analytics Engine binding and the CLI
		// injects mock REST credentials, but the SQL API cannot read locally
		// emulated datasets — exposures are written to D1 there instead.
		if (env.FLAG_EXPOSURES && env.WRANGLER_IS_LOCAL_DEV !== 'true') {
			if (!accountId || !apiToken) {
				// With the binding present, exposures were written only to
				// Analytics Engine; falling back to the (empty) D1 tables would
				// present confident zero cohorts instead of a config problem.
				return {
					status: 'unavailable',
					reason:
						'Analytics Engine SQL credentials (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN) are not configured, so recorded exposures cannot be read.',
				}
			}
			return await loadReadoutFromAnalyticsEngine({
				env,
				accountId,
				apiToken,
				flagKey: input.flagKey,
				successMetric: input.successMetric,
				now,
			})
		}
		return await loadReadoutFromD1({
			db: env.APP_DB,
			flagKey: input.flagKey,
			successMetric: input.successMetric,
			now,
		})
	} catch (error) {
		console.warn('flag-metric-readout-failed', input.flagKey, error)
		const detail = error instanceof Error ? error.message : String(error)
		return {
			status: 'unavailable',
			reason: `Metric readout query failed; exposure or usage data could not be loaded: ${detail.slice(0, 600)}`,
		}
	}
}

/**
 * Attach a metric readout to every non-stale flag that declares a success
 * metric. Mutates and returns the given array; flags without a metric are
 * left untouched (the admin surfaces render the strong recommendation notice
 * for those instead).
 */
export async function attachFeatureFlagMetricReadouts(
	env: FeatureFlagReadoutEnv,
	flags: Array<AdminFeatureFlag>,
	now: Date = new Date(),
): Promise<Array<AdminFeatureFlag>> {
	await Promise.all(
		flags.map(async (flag) => {
			if (flag.stale || !flag.successMetric) return
			flag.metricReadout = await loadFeatureFlagSuccessMetricReadout(
				env,
				{ flagKey: flag.key, successMetric: flag.successMetric },
				now,
			)
		}),
	)
	return flags
}
