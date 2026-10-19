/**
 * Derived usage rollup aggregation.
 *
 * In production/preview, `recordUsage` writes usage events only to Workers
 * Analytics Engine (see `record-usage.ts`); the D1 `usage_rollups` table is a
 * derived aggregate. `aggregateUsageRollups` recomputes the current UTC
 * month's rows from Analytics Engine via the SQL API and upserts them with
 * absolute values — an idempotent recompute, not an increment — so the hourly
 * cron can run any number of times without drift. The recompute is
 * authoritative for the current month: rows whose (user, metric) pair is
 * absent from the Analytics Engine result are deleted, so stragglers from
 * direct local-development or recovery D1 upserts cannot linger.
 * Analytics Engine retention (~90 days) always covers a full month, so a
 * month-to-date recompute is complete; rows for prior months already in D1
 * stay untouched.
 *
 * In local dev and tests (no `USAGE_EVENTS` binding or Cloudflare REST
 * credentials) this is a no-op: `recordUsage` upserts `usage_rollups`
 * directly there.
 */

import { coalescedCountUsageEventTypes } from '#universal/usage-event-types.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { listSystemInboundUsageRows } from '#worker/email/system-inbound-delivery-store.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	liveBillingOwnerSql,
	liveOrgMatchSql,
	liveUserMatchSql,
} from '#worker/usage/live-billing-owner.ts'

export const usageAggregationCronGateMinutes = 5
export const usageAggregationCronIntervalMinutes = 60

/**
 * Hourly gate for the scheduled handler, mirroring `shouldRunRetentionCron`
 * in `packages/worker/src/app/retention.ts`.
 */
export function shouldRunUsageAggregationCron(now: Date) {
	return (
		now.getUTCMinutes() < usageAggregationCronGateMinutes &&
		now.getUTCMinutes() % usageAggregationCronIntervalMinutes === 0
	)
}

export type UsageAggregationEnv = {
	USAGE_EVENTS?: AnalyticsEngineDataset
	APP_DB: D1Database
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_TOKEN?: string
	CLOUDFLARE_API_BASE_URL?: string
	SENTRY_ENVIRONMENT?: string
}

export type UsageAggregationResult =
	| { skipped: true; reason: string }
	| {
			skipped: false
			month: string
			upsertedRows: number
			deletedRows: number
			users: number
	  }

/**
 * The Analytics Engine SQL API dataset (= table name) written by the
 * `USAGE_EVENTS` binding; see `packages/worker/wrangler.jsonc`.
 */
export function resolveUsageEventsDataset(env: {
	SENTRY_ENVIRONMENT?: string
}) {
	return env.SENTRY_ENVIRONMENT === 'preview'
		? 'kody_usage_events_preview'
		: 'kody_usage_events'
}

/**
 * Analytics Engine SQL for unique Dynamic Worker days this UTC month,
 * grouped by `blob6` surface. Weight by `_sample_interval`. Empty blob6
 * is historical events recorded before surface tagging.
 */
export function buildUniqueWorkerDayBySurfaceQuery(
	dataset: string,
	bounds: { monthStart: string; nextMonthStart: string },
) {
	return `
SELECT
	if(blob6 = '', 'unknown', blob6) AS surface,
	sum(_sample_interval) AS unique_worker_days
FROM ${dataset}
WHERE timestamp >= toDateTime('${bounds.monthStart}')
	AND timestamp < toDateTime('${bounds.nextMonthStart}')
	AND blob2 = 'dynamic_worker_day'
GROUP BY surface
ORDER BY unique_worker_days DESC
FORMAT JSON
`.trim()
}

/**
 * Analytics Engine SQL for Dynamic Worker invoke reuse this UTC month,
 * grouped by `blob8` cache reuse (`hit` / `miss`) and `blob6` surface.
 * Weight by `_sample_interval`. Empty blob8 is an unset reuse tag.
 */
export function buildDynamicWorkerInvokeReuseQuery(
	dataset: string,
	bounds: { monthStart: string; nextMonthStart: string },
) {
	return `
SELECT
	if(blob8 = '', 'unknown', blob8) AS cache_reuse,
	if(blob6 = '', 'unknown', blob6) AS surface,
	sum(_sample_interval) AS invokes,
	sum(double1 * _sample_interval) / sum(_sample_interval) AS avg_duration_ms,
	sum(double4 * _sample_interval) / sum(_sample_interval) AS avg_code_chars,
	sum(double5 * _sample_interval) / sum(_sample_interval) AS avg_params_chars
FROM ${dataset}
WHERE timestamp >= toDateTime('${bounds.monthStart}')
	AND timestamp < toDateTime('${bounds.nextMonthStart}')
	AND blob2 = 'dynamic_worker_invoke'
GROUP BY cache_reuse, surface
ORDER BY invokes DESC
FORMAT JSON
`.trim()
}

/**
 * Analytics Engine SQL for fleet reuse ratios this UTC month: unique
 * worker days over invokes and over execute calls, plus invoke hit/miss
 * counts. Weight by `_sample_interval`.
 */
export function buildDynamicWorkerReuseRatioQuery(
	dataset: string,
	bounds: { monthStart: string; nextMonthStart: string },
) {
	return `
SELECT
	sumIf(_sample_interval, blob2 = 'dynamic_worker_day') AS unique_worker_days,
	sumIf(_sample_interval, blob2 = 'dynamic_worker_invoke') AS invokes,
	sumIf(_sample_interval, blob2 = 'execute') AS execute_calls,
	sumIf(_sample_interval, blob2 = 'dynamic_worker_invoke' AND blob8 = 'hit') AS invoke_hits,
	sumIf(_sample_interval, blob2 = 'dynamic_worker_invoke' AND blob8 = 'miss') AS invoke_misses
FROM ${dataset}
WHERE timestamp >= toDateTime('${bounds.monthStart}')
	AND timestamp < toDateTime('${bounds.nextMonthStart}')
	AND blob2 IN ('dynamic_worker_day', 'dynamic_worker_invoke', 'execute')
FORMAT JSON
`.trim()
}

const upsertBatchSize = 50

/**
 * Pairs per DELETE statement. Each pair binds two parameters plus one for
 * the month, so 49 pairs keeps every statement under D1's ~100
 * bind-parameter cap.
 */
const deleteStatementPairLimit = 49

/**
 * Upper bound for one Analytics Engine SQL API round trip so a hung API can
 * never stall the scheduled lane; a timeout aborts the fetch and surfaces
 * through the same error path as a failed query.
 */
export const analyticsEngineSqlTimeoutMs = 30_000

/**
 * Transient Cloudflare Analytics Engine SQL API failures (5xx / 429) are
 * retried with exponential backoff. The hourly aggregation is already
 * idempotent, but absorbing a single blip avoids a missed rollup hour and
 * Sentry noise from `scheduled_lane_failed`.
 */
export const analyticsEngineSqlRetryMaxAttempts = 3
export const analyticsEngineSqlRetryBaseDelayMs = 200

function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export function isRetryableAnalyticsEngineSqlStatus(status: number) {
	return status === 429 || (status >= 500 && status <= 599)
}

const usageRollupAbsoluteUpsertStatement = `
INSERT INTO usage_rollups (
	user_id, metric, month,
	event_count, error_count, caught_count,
	total_duration_ms, total_cpu_ms, total_bytes,
	updated_at
)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
WHERE ${liveBillingOwnerSql('?1')}
ON CONFLICT (user_id, metric, month) DO UPDATE SET
	event_count = excluded.event_count,
	error_count = excluded.error_count,
	caught_count = excluded.caught_count,
	total_duration_ms = excluded.total_duration_ms,
	total_cpu_ms = excluded.total_cpu_ms,
	total_bytes = excluded.total_bytes,
	updated_at = excluded.updated_at
`.trim()

/**
 * Half-open [current month start, next month start) UTC bounds for the SQL
 * time filter, formatted for `toDateTime`. The explicit upper bound keeps
 * events stamped into a later month (clock skew, backdated writes) from
 * inflating the current month's rollups.
 */
function utcMonthBounds(now: Date) {
	const toDateTimeArgument = (date: Date) =>
		`${date.toISOString().slice(0, 'YYYY-MM-DD'.length)} 00:00:00`
	return {
		monthStart: toDateTimeArgument(
			new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
		),
		nextMonthStart: toDateTimeArgument(
			new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
		),
	}
}

/**
 * Analytics Engine samples data under load, so every aggregate must weight
 * by `_sample_interval`: counts are `sum(_sample_interval)` and value sums
 * are `sum(doubleN * _sample_interval)`. Coalesced points
 * (`coalescedCountUsageEventTypes`) store the unit count in `double3`, so
 * those metrics' counts use `double3` when it is set. Blob/double positions match the data point layout in
 * `record-usage.ts`. Analytics Engine `blob1` is the org billing id (same as
 * the rollup `user_id` for personal orgs). Actor and automation attribution
 * live in `blob10` and `blob11` when present.
 *
 * Every `if()` branch must be a Float: Analytics Engine rejects the whole
 * query (HTTP 422) when one branch is `doubleN` and the other an Integer
 * literal, so fallbacks are written `1.0` / `0.0`, never `1` / `0`.
 */
export function buildMonthToDateAggregateQuery(
	dataset: string,
	bounds: { monthStart: string; nextMonthStart: string },
) {
	const coalescedMetrics = `blob2 IN (${coalescedCountUsageEventTypes
		.map((eventType) => `'${eventType}'`)
		.join(', ')})`
	return `
SELECT
	blob1 AS user_id,
	blob2 AS metric,
	sum(
		if(${coalescedMetrics} AND double3 > 0, double3, 1.0) * _sample_interval
	) AS event_count,
	sum(
		if(
			blob4 = 'error',
			if(${coalescedMetrics} AND double3 > 0, double3, 1.0),
			0.0
		) * _sample_interval
	) AS error_count,
	sum(
		if(
			blob4 = 'caught',
			if(${coalescedMetrics} AND double3 > 0, double3, 1.0),
			0.0
		) * _sample_interval
	) AS caught_count,
	sum(double1 * _sample_interval) AS total_duration_ms,
	sum(double2 * _sample_interval) AS total_cpu_ms,
	sum(if(${coalescedMetrics}, 0.0, double3) * _sample_interval) AS total_bytes
FROM ${dataset}
WHERE timestamp >= toDateTime('${bounds.monthStart}')
	AND timestamp < toDateTime('${bounds.nextMonthStart}')
GROUP BY blob1, blob2
FORMAT JSON
`.trim()
}

type AnalyticsEngineSqlRow = {
	user_id: string
	metric: string
	month?: string
	event_count: number | string
	error_count: number | string
	caught_count?: number | string
	total_duration_ms: number | string
	total_cpu_ms: number | string
	total_bytes: number | string
}

export async function readIdempotentInboundEmailUsage(input: {
	db: D1Database
	months: [string, string]
}) {
	return await listSystemInboundUsageRows(input)
}

/**
 * Run one Analytics Engine SQL API query (with timeout + retry on transient
 * failures) and return the parsed rows. Shared with the feature-flag
 * success-metric readout, which queries the same API against the usage and
 * flag-exposure datasets.
 */
export async function queryAnalyticsEngineSql<
	Row = AnalyticsEngineSqlRow,
>(input: {
	accountId: string
	apiToken: string
	baseUrl: string
	query: string
}): Promise<Array<Row>> {
	const url = `${input.baseUrl.replace(/\/$/, '')}/client/v4/accounts/${input.accountId}/analytics_engine/sql`
	let lastError: Error | undefined
	for (
		let attempt = 1;
		attempt <= analyticsEngineSqlRetryMaxAttempts;
		attempt++
	) {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${input.apiToken}`,
			},
			body: input.query,
			signal: AbortSignal.timeout(analyticsEngineSqlTimeoutMs),
		})
		const text = await response.text()
		if (response.ok) {
			const parsed = JSON.parse(text) as {
				data?: Array<Row>
			}
			return parsed.data ?? []
		}
		lastError = new Error(
			`Analytics Engine SQL query failed (${response.status}): ${text.slice(0, 500)}`,
		)
		if (
			!isRetryableAnalyticsEngineSqlStatus(response.status) ||
			attempt === analyticsEngineSqlRetryMaxAttempts
		) {
			throw lastError
		}
		await sleep(analyticsEngineSqlRetryBaseDelayMs * 2 ** (attempt - 1))
	}
	throw lastError ?? new Error('Analytics Engine SQL query failed')
}

function toCount(value: number | string) {
	const parsed = Number(value)
	return Number.isFinite(parsed) ? Math.round(parsed) : 0
}

/**
 * Keep Analytics Engine rows whose billing id is still a live user or a live
 * org. Team org ids have no `users` row. Personal orgs share
 * `stable_user_id`. Soft-deleted owners stay out so the hourly recompute
 * cannot rebuild their rollups.
 */
export async function filterLiveUsageRows<T extends { user_id: string }>(
	db: D1Database,
	rows: Array<T>,
) {
	const systemRows = rows.filter((row) => row.user_id === 'system:email')
	const ownerIds = [
		...new Set(
			rows
				.map((row) => row.user_id)
				.filter((userId) => userId && userId !== 'system:email'),
		),
	]
	const live = new Set<string>()
	for (let index = 0; index < ownerIds.length; index += 80) {
		const chunk = ownerIds.slice(index, index + 80)
		const placeholders = chunk.map(() => '?').join(', ')
		const [users, orgs] = await Promise.all([
			runD1WithRetry(() =>
				db
					.prepare(
						`SELECT stable_user_id FROM users
						WHERE deleting_at IS NULL${andLiveDeletedAtSql()}
							AND stable_user_id IN (${placeholders})`,
					)
					.bind(...chunk)
					.all<{ stable_user_id: string }>(),
			),
			runD1WithRetry(() =>
				db
					.prepare(
						`SELECT id FROM orgs
						WHERE deleting_at IS NULL${andLiveDeletedAtSql()}
							AND id IN (${placeholders})`,
					)
					.bind(...chunk)
					.all<{ id: string }>(),
			),
		])
		for (const row of users.results ?? []) live.add(row.stable_user_id)
		for (const row of orgs.results ?? []) live.add(row.id)
	}
	return [...systemRows, ...rows.filter((row) => live.has(row.user_id))]
}

function rollupPairKey(row: { user_id: string; metric: string }) {
	return `${row.user_id}\n${row.metric}`
}

function previousMonth(month: string) {
	const [year, monthNumber] = month.split('-').map(Number)
	return new Date(Date.UTC(year ?? 1970, (monthNumber ?? 1) - 2, 1))
		.toISOString()
		.slice(0, 7)
}

/**
 * Delete current-month rollup rows whose (user_id, metric) pair is absent
 * from the Analytics Engine result, making the recompute authoritative for
 * the month (a direct recovery upsert or a row whose Analytics Engine data
 * point was lost would otherwise linger forever). A NOT IN over the full pair
 * set cannot be chunked without
 * deleting everything, so stale pairs are computed in memory from one SELECT
 * and deleted in parameter-capped chunks. Rows for other months are never
 * touched.
 */
async function deleteStaleCurrentMonthRollups(input: {
	db: D1Database
	month: string
	presentPairs: ReadonlySet<string>
}) {
	const { results } = await runD1WithRetry(() =>
		input.db
			.prepare(`SELECT user_id, metric FROM usage_rollups WHERE month = ?`)
			.bind(input.month)
			.all<{ user_id: string; metric: string }>(),
	)
	const stalePairs = (results ?? []).filter(
		(row) => !input.presentPairs.has(rollupPairKey(row)),
	)
	let deleted = 0
	for (
		let index = 0;
		index < stalePairs.length;
		index += deleteStatementPairLimit
	) {
		const chunk = stalePairs.slice(index, index + deleteStatementPairLimit)
		const pairPredicates = chunk
			.map(() => '(user_id = ? AND metric = ?)')
			.join(' OR ')
		const result = await runD1WithRetry(() =>
			input.db
				.prepare(
					`DELETE FROM usage_rollups WHERE month = ? AND (${pairPredicates})`,
				)
				.bind(
					input.month,
					...chunk.flatMap((pair) => [pair.user_id, pair.metric]),
				)
				.run(),
		)
		deleted += result.meta.changes ?? 0
	}
	return deleted
}

async function deleteNonLiveUserRollups(input: {
	db: D1Database
	months: [string, string]
}) {
	const result = await runD1WithRetry(() =>
		input.db
			.prepare(
				`DELETE FROM usage_rollups
				WHERE month IN (?, ?)
					AND user_id != 'system:email'
					AND NOT ${liveUserMatchSql('usage_rollups.user_id')}
					AND NOT ${liveOrgMatchSql('usage_rollups.user_id')}`,
			)
			.bind(...input.months)
			.run(),
	)
	return Number(result.meta.changes ?? 0)
}

/**
 * Recompute the current UTC month's `usage_rollups` rows from Analytics
 * Engine: upsert absolute values for every (user, metric) pair in the result
 * and delete current-month rows absent from it. No-op (with a debug log)
 * when the Analytics Engine binding or the Cloudflare REST credentials are
 * unavailable.
 */
export async function aggregateUsageRollups(
	env: UsageAggregationEnv,
	now: Date = new Date(),
): Promise<UsageAggregationResult> {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()
	if (!env.USAGE_EVENTS || !accountId || !apiToken) {
		console.debug(
			'usage-rollup-aggregation-skipped',
			'missing USAGE_EVENTS binding or Cloudflare REST credentials',
		)
		return { skipped: true, reason: 'missing-analytics-config' }
	}

	const month = now.toISOString().slice(0, 'YYYY-MM'.length)
	const priorMonth = previousMonth(month)
	const priorMonthDate = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15),
	)
	const baseUrl =
		env.CLOUDFLARE_API_BASE_URL?.trim() || 'https://api.cloudflare.com'
	const dataset = resolveUsageEventsDataset(env)
	const [currentAnalyticsRows, previousAnalyticsRows] = await Promise.all([
		queryAnalyticsEngineSql({
			accountId,
			apiToken,
			baseUrl,
			query: buildMonthToDateAggregateQuery(dataset, utcMonthBounds(now)),
		}),
		queryAnalyticsEngineSql({
			accountId,
			apiToken,
			baseUrl,
			query: buildMonthToDateAggregateQuery(
				dataset,
				utcMonthBounds(priorMonthDate),
			),
		}),
	])
	const [liveCurrentAnalyticsRows, livePreviousAnalyticsRows] =
		await Promise.all([
			filterLiveUsageRows(env.APP_DB, currentAnalyticsRows),
			filterLiveUsageRows(env.APP_DB, previousAnalyticsRows),
		])
	const rows = [
		...liveCurrentAnalyticsRows.map((row) => ({ ...row, month })),
		...livePreviousAnalyticsRows.map((row) => ({
			...row,
			month: priorMonth,
		})),
	]
	const analyticsMonthsWithRows = new Set<string>()
	if (liveCurrentAnalyticsRows.some((row) => row.user_id && row.metric)) {
		analyticsMonthsWithRows.add(month)
	}
	if (livePreviousAnalyticsRows.some((row) => row.user_id && row.metric)) {
		analyticsMonthsWithRows.add(priorMonth)
	}

	const updatedAt = now.toISOString()
	const emailRows = await readIdempotentInboundEmailUsage({
		db: env.APP_DB,
		months: [month, priorMonth],
	})
	const liveEmailRows = await filterLiveUsageRows(env.APP_DB, emailRows)
	const mergedRows = new Map<string, AnalyticsEngineSqlRow>()
	for (const row of [
		...rows,
		...liveEmailRows.filter(
			(row) => row.month && analyticsMonthsWithRows.has(row.month),
		),
	]) {
		if (!row.user_id || !row.metric) continue
		const rowMonth = row.month ?? month
		const key = `${rowMonth}\n${rollupPairKey(row)}`
		const existing = mergedRows.get(key)
		mergedRows.set(key, {
			user_id: row.user_id,
			metric: row.metric,
			month: rowMonth,
			event_count:
				toCount(existing?.event_count ?? 0) + toCount(row.event_count),
			error_count:
				toCount(existing?.error_count ?? 0) + toCount(row.error_count),
			caught_count:
				toCount(existing?.caught_count ?? 0) + toCount(row.caught_count ?? 0),
			total_duration_ms:
				toCount(existing?.total_duration_ms ?? 0) +
				toCount(row.total_duration_ms),
			total_cpu_ms:
				toCount(existing?.total_cpu_ms ?? 0) + toCount(row.total_cpu_ms),
			total_bytes:
				toCount(existing?.total_bytes ?? 0) + toCount(row.total_bytes),
		})
	}
	const presentRows = [...mergedRows.values()]
	const statements = presentRows.map((row) =>
		env.APP_DB.prepare(usageRollupAbsoluteUpsertStatement).bind(
			row.user_id,
			row.metric,
			row.month ?? month,
			toCount(row.event_count),
			toCount(row.error_count),
			toCount(row.caught_count ?? 0),
			toCount(row.total_duration_ms),
			toCount(row.total_cpu_ms),
			toCount(row.total_bytes),
			updatedAt,
		),
	)
	const users = new Set(presentRows.map((row) => row.user_id)).size
	for (let index = 0; index < statements.length; index += upsertBatchSize) {
		await runD1WithRetry(() =>
			env.APP_DB.batch(statements.slice(index, index + upsertBatchSize)),
		)
	}
	// An entirely empty result is more likely Analytics Engine ingestion
	// lag (or a dataset misconfiguration) than a genuinely event-free
	// month; skip the stale-row cleanup rather than wiping real counters.
	// The next hourly run reconciles once events are visible again.
	const currentRows = presentRows.filter(
		(row) => (row.month ?? month) === month,
	)
	const deletedStaleRows =
		!analyticsMonthsWithRows.has(month) || currentRows.length === 0
			? 0
			: await deleteStaleCurrentMonthRollups({
					db: env.APP_DB,
					month,
					presentPairs: new Set(currentRows.map(rollupPairKey)),
				})
	const deletedNonLiveRows = await deleteNonLiveUserRollups({
		db: env.APP_DB,
		months: [month, priorMonth],
	})
	const deletedRows = deletedStaleRows + deletedNonLiveRows

	const result = {
		skipped: false as const,
		month,
		upsertedRows: statements.length,
		deletedRows,
		users,
	}
	console.info('usage-rollup-aggregation', JSON.stringify(result))
	return result
}
