/**
 * Load and (in production) recompute daily credit-attribution units from
 * Analytics Engine into `usage_attribution_daily`. Local/dev upserts on
 * each billable `recordUsage` write instead.
 */
import { utcDayKey, utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { connectionUsageRetentionDays } from '#worker/usage/connection-usage-rollup.ts'
import { creditDebitCostMicroUsd } from '#universal/credits.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	summarizeAdHocConnectionUsage,
	buildCreditAttributionBreakdown,
	creditAttributionMeters,
	creditAttributionMeterFromComputeResource,
	creditAttributionUsageEventTypes,
	normalizeCreditAttributionAutomationSource,
	type CreditAttributionBreakdown,
	type CreditAttributionDailyUnit,
	type CreditAttributionMeter,
	type CreditAttributionVisitorRow,
} from '#universal/credit-attribution.ts'
import { type AccountUsageComputeOverage } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	filterLiveUsageRows,
	queryAnalyticsEngineSql,
	resolveUsageEventsDataset,
	type UsageAggregationEnv,
} from '#worker/usage/aggregate-rollups.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'

const attributionUpsertStatement = `
INSERT INTO usage_attribution_daily (
	user_id, day, package_id, meter, units, updated_at,
	actor_user_id, automation_source
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
ON CONFLICT (user_id, day, package_id, meter) DO UPDATE SET
	units = excluded.units,
	updated_at = excluded.updated_at,
	actor_user_id = excluded.actor_user_id,
	automation_source = excluded.automation_source
`.trim()

const visitorAttributionUpsertStatement = `
INSERT INTO package_app_visitor_attribution_daily (
	user_id, day, package_id, visitor_user_id, meter, units, updated_at,
	billed_org_id
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
ON CONFLICT (
	user_id, day, package_id, visitor_user_id, billed_org_id, meter
) DO UPDATE SET
	units = excluded.units,
	updated_at = excluded.updated_at
`.trim()

/**
 * Analytics Engine SQL for billable units this UTC month, grouped by day and
 * package id (blob9). Empty blob9 is Ad hoc / historical unattributed.
 * `blob1` is the org billing id. When multiple actors share a rollup key,
 * `argMax(blobN, timestamp)` keeps the actor (blob10) and automation source
 * (blob11) of the latest unit. Analytics Engine SQL has no `any()` and
 * rejects `max()` over String columns (HTTP 422).
 */
export function buildCreditAttributionDailyQuery(
	dataset: string,
	bounds: { monthStart: string; nextMonthStart: string },
) {
	const billable = creditAttributionUsageEventTypes
		.map((eventType) => `'${eventType}'`)
		.join(', ')
	return `
SELECT
	blob1 AS user_id,
	toDate(timestamp) AS day,
	blob9 AS package_id,
	blob2 AS event_type,
	argMax(blob10, timestamp) AS actor_user_id,
	argMax(blob11, timestamp) AS automation_source,
	sum(
		if(blob2 = 'durable_object_rows_read' AND double3 > 0, double3, 1.0) * _sample_interval
	) AS units
FROM ${dataset}
WHERE timestamp >= toDateTime('${bounds.monthStart}')
	AND timestamp < toDateTime('${bounds.nextMonthStart}')
	AND blob2 IN (${billable})
GROUP BY user_id, day, package_id, event_type
FORMAT JSON
`.trim()
}

/**
 * Visitor attribution stays under the app's owning org. `blob16` is that org
 * when a visiting org was billed (`blob1`, ADR 0095); then `billed_org_id`
 * names the visiting org. Empty `billed_org_id` means the owner paid.
 */
export function buildPackageAppVisitorAttributionDailyQuery(
	dataset: string,
	bounds: { monthStart: string; nextMonthStart: string },
) {
	const billable = creditAttributionUsageEventTypes
		.map((eventType) => `'${eventType}'`)
		.join(', ')
	return `
SELECT
	if(blob16 != '', blob16, blob1) AS user_id,
	if(blob16 != '', blob1, '') AS billed_org_id,
	toDate(timestamp) AS day,
	blob9 AS package_id,
	blob14 AS visitor_user_id,
	blob2 AS event_type,
	sum(
		if(blob2 = 'durable_object_rows_read' AND double3 > 0, double3, 1.0) * _sample_interval
	) AS units
FROM ${dataset}
WHERE timestamp >= toDateTime('${bounds.monthStart}')
	AND timestamp < toDateTime('${bounds.nextMonthStart}')
	AND blob15 = 'package-app'
	AND blob2 IN (${billable})
	AND blob9 != ''
GROUP BY user_id, billed_org_id, day, package_id, visitor_user_id, event_type
FORMAT JSON
`.trim()
}

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

type AttributionAnalyticsRow = {
	user_id: string
	day: string
	package_id: string | null
	event_type: string
	actor_user_id?: string | null
	automation_source?: string | null
	units: number | string
}

type VisitorAttributionAnalyticsRow = AttributionAnalyticsRow & {
	visitor_user_id?: string | null
	billed_org_id?: string | null
}

function meterFromEventType(eventType: string): CreditAttributionMeter | null {
	switch (eventType) {
		case 'dynamic_worker_day':
			return 'unique_worker_days'
		case 'durable_object_rows_read':
			return 'durable_object_rows_read'
		default:
			return null
	}
}

const attributionUpsertBatchSize = 50
const attributionDeleteBatchSize = 50
/** D1 bind budget: one for user_id plus package ids per IN chunk. */
const attributionPackageLabelChunkSize = 80

/**
 * Recompute the current UTC month's attribution daily rows from Analytics
 * Engine. Called from the same hourly lane as `usage_rollups`. No-op when
 * AE credentials are missing (local path already upserts on write).
 */
export async function aggregateCreditAttributionDaily(
	env: UsageAggregationEnv,
	now: Date = new Date(),
): Promise<
	{ skipped: true; reason: string } | { skipped: false; upserted: number }
> {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()
	if (!env.USAGE_EVENTS || !accountId || !apiToken) {
		return { skipped: true, reason: 'missing-analytics-config' }
	}
	const baseUrl =
		env.CLOUDFLARE_API_BASE_URL?.trim() || 'https://api.cloudflare.com'
	const dataset = resolveUsageEventsDataset(env)
	const analyticsRows = await queryAnalyticsEngineSql<AttributionAnalyticsRow>({
		accountId,
		apiToken,
		baseUrl,
		query: buildCreditAttributionDailyQuery(dataset, utcMonthBounds(now)),
	})
	const visitorAnalyticsRows =
		await queryAnalyticsEngineSql<VisitorAttributionAnalyticsRow>({
			accountId,
			apiToken,
			baseUrl,
			query: buildPackageAppVisitorAttributionDailyQuery(
				dataset,
				utcMonthBounds(now),
			),
		})
	// Same live-owner guard as usage_rollups: AE retains points after account
	// deletion; never reinsert those into D1 attribution rows. Team org ids
	// stay when the org row is live.
	const liveRows = await filterLiveUsageRows(env.APP_DB, analyticsRows)
	const month = utcMonthKey(now)
	const updatedAt = now.toISOString()
	const presentKeys = new Set<string>()
	const upsertStatements: Array<D1PreparedStatement> = []
	for (const row of liveRows) {
		const meter = meterFromEventType(row.event_type)
		if (!meter) continue
		const day =
			typeof row.day === 'string'
				? row.day.slice(0, 'YYYY-MM-DD'.length)
				: String(row.day).slice(0, 'YYYY-MM-DD'.length)
		if (!day.startsWith(month)) continue
		const packageId = (row.package_id ?? '').trim()
		const units = Number(row.units)
		if (!Number.isFinite(units) || units <= 0) continue
		presentKeys.add(`${row.user_id}\0${day}\0${packageId}\0${meter}`)
		const actorUserId =
			(typeof row.actor_user_id === 'string' && row.actor_user_id.trim()) ||
			row.user_id
		const automationSource = normalizeCreditAttributionAutomationSource(
			row.automation_source,
		)
		upsertStatements.push(
			env.APP_DB.prepare(attributionUpsertStatement).bind(
				row.user_id,
				day,
				packageId,
				meter,
				units,
				updatedAt,
				actorUserId,
				automationSource,
			),
		)
	}
	const liveVisitorRows = await filterLiveUsageRows(
		env.APP_DB,
		visitorAnalyticsRows,
	)
	const presentVisitorKeys = new Set<string>()
	const visitorUpsertStatements: Array<D1PreparedStatement> = []
	for (const row of liveVisitorRows) {
		const meter = meterFromEventType(row.event_type)
		if (!meter) continue
		const day =
			typeof row.day === 'string'
				? row.day.slice(0, 'YYYY-MM-DD'.length)
				: String(row.day).slice(0, 'YYYY-MM-DD'.length)
		if (!day.startsWith(month)) continue
		const packageId = (row.package_id ?? '').trim()
		const visitorUserId = row.visitor_user_id ?? ''
		const billedOrgId = (row.billed_org_id ?? '').trim()
		const units = Number(row.units)
		if (!packageId || !Number.isFinite(units) || units <= 0) continue
		presentVisitorKeys.add(
			`${row.user_id}\0${day}\0${packageId}\0${visitorUserId}\0${billedOrgId}\0${meter}`,
		)
		visitorUpsertStatements.push(
			env.APP_DB.prepare(visitorAttributionUpsertStatement).bind(
				row.user_id,
				day,
				packageId,
				visitorUserId,
				meter,
				units,
				updatedAt,
				billedOrgId,
			),
		)
	}
	for (
		let index = 0;
		index < upsertStatements.length;
		index += attributionUpsertBatchSize
	) {
		await runD1WithRetry(() =>
			env.APP_DB.batch(
				upsertStatements.slice(index, index + attributionUpsertBatchSize),
			),
		)
	}
	for (
		let index = 0;
		index < visitorUpsertStatements.length;
		index += attributionUpsertBatchSize
	) {
		await runD1WithRetry(() =>
			env.APP_DB.batch(
				visitorUpsertStatements.slice(
					index,
					index + attributionUpsertBatchSize,
				),
			),
		)
	}
	// Empty AE result is more likely ingestion lag than a truly empty month;
	// skip stale cleanup rather than wiping real attribution (same as rollups).
	// A non-empty AE result that yields no live rows still runs cleanup so
	// deleted-account rows do not linger.
	if (analyticsRows.length === 0 && visitorAnalyticsRows.length === 0) {
		return { skipped: false, upserted: 0 }
	}
	if (analyticsRows.length > 0) {
		const existing = await env.APP_DB.prepare(
			`SELECT user_id, day, package_id, meter
			 FROM usage_attribution_daily
			 WHERE day >= ? AND day < ?`,
		)
			.bind(
				`${month}-01`,
				utcMonthBounds(now).nextMonthStart.slice(0, 'YYYY-MM-DD'.length),
			)
			.all<{
				user_id: string
				day: string
				package_id: string
				meter: string
			}>()
		const deleteStatements: Array<D1PreparedStatement> = []
		for (const row of existing.results ?? []) {
			const key = `${row.user_id}\0${row.day}\0${row.package_id}\0${row.meter}`
			if (presentKeys.has(key)) continue
			deleteStatements.push(
				env.APP_DB.prepare(
					`DELETE FROM usage_attribution_daily
					 WHERE user_id = ? AND day = ? AND package_id = ? AND meter = ?`,
				).bind(row.user_id, row.day, row.package_id, row.meter),
			)
		}
		for (
			let index = 0;
			index < deleteStatements.length;
			index += attributionDeleteBatchSize
		) {
			await runD1WithRetry(() =>
				env.APP_DB.batch(
					deleteStatements.slice(index, index + attributionDeleteBatchSize),
				),
			)
		}
	}
	let visitorDeleteStatements: Array<D1PreparedStatement> = []
	if (visitorAnalyticsRows.length > 0) {
		const existingVisitorRows = await env.APP_DB.prepare(
			`SELECT user_id, day, package_id, visitor_user_id, billed_org_id, meter
			 FROM package_app_visitor_attribution_daily
			 WHERE day >= ? AND day < ?`,
		)
			.bind(
				`${month}-01`,
				utcMonthBounds(now).nextMonthStart.slice(0, 'YYYY-MM-DD'.length),
			)
			.all<{
				user_id: string
				day: string
				package_id: string
				visitor_user_id: string
				billed_org_id: string
				meter: string
			}>()
		visitorDeleteStatements = []
		for (const row of existingVisitorRows.results ?? []) {
			const key = `${row.user_id}\0${row.day}\0${row.package_id}\0${row.visitor_user_id}\0${row.billed_org_id}\0${row.meter}`
			if (presentVisitorKeys.has(key)) continue
			visitorDeleteStatements.push(
				env.APP_DB.prepare(
					`DELETE FROM package_app_visitor_attribution_daily
					 WHERE user_id = ? AND day = ? AND package_id = ?
						AND visitor_user_id = ? AND billed_org_id = ? AND meter = ?`,
				).bind(
					row.user_id,
					row.day,
					row.package_id,
					row.visitor_user_id,
					row.billed_org_id,
					row.meter,
				),
			)
		}
		for (
			let index = 0;
			index < visitorDeleteStatements.length;
			index += attributionDeleteBatchSize
		) {
			await runD1WithRetry(() =>
				env.APP_DB.batch(
					visitorDeleteStatements.slice(
						index,
						index + attributionDeleteBatchSize,
					),
				),
			)
		}
	}
	return {
		skipped: false,
		upserted: upsertStatements.length + visitorUpsertStatements.length,
	}
}

export async function readCreditAttributionDailyUnits(input: {
	db: D1Database
	stableUserId: string
	month: string
}): Promise<Array<CreditAttributionDailyUnit>> {
	const nextMonth = nextUtcMonthKey(input.month)
	const rows = await input.db
		.prepare(
			`SELECT day, package_id, meter, units
			 FROM usage_attribution_daily
			 WHERE user_id = ?
				AND day >= ?
				AND day < ?
				AND meter IN (${creditAttributionMeters.map(() => '?').join(', ')})`,
		)
		.bind(
			input.stableUserId,
			`${input.month}-01`,
			`${nextMonth}-01`,
			...creditAttributionMeters,
		)
		.all<{
			day: string
			package_id: string
			meter: string
			units: number
		}>()
	const units: Array<CreditAttributionDailyUnit> = []
	for (const row of rows.results ?? []) {
		if (
			!(creditAttributionMeters as ReadonlyArray<string>).includes(row.meter)
		) {
			continue
		}
		units.push({
			day: row.day,
			packageId: row.package_id,
			meter: row.meter as CreditAttributionMeter,
			units: Number(row.units) || 0,
		})
	}
	return units
}

function nextUtcMonthKey(month: string) {
	const [yearText, monthText] = month.split('-')
	const year = Number(yearText)
	const monthIndex = Number(monthText) - 1
	const next = new Date(Date.UTC(year, monthIndex + 1, 1))
	return utcMonthKey(next)
}

export async function loadCreditAttributionBreakdown(input: {
	db: D1Database
	stableUserId: string
	username: string
	computeOverage: AccountUsageComputeOverage | null
	now?: Date
}): Promise<CreditAttributionBreakdown> {
	const now = input.now ?? new Date()
	const month = utcMonthKey(now)
	const dailyUnits = await readCreditAttributionDailyUnits({
		db: input.db,
		stableUserId: input.stableUserId,
		month,
	})
	const packageIds = [
		...new Set(
			dailyUnits
				.map((row) => row.packageId.trim())
				.filter((packageId) => packageId.length > 0),
		),
	]
	const { names, hrefs } = await loadPackageAttributionLabels({
		db: input.db,
		stableUserId: input.stableUserId,
		username: input.username,
		packageIds,
	})
	const includes =
		input.computeOverage?.meters.map((meter) => ({
			meter: creditAttributionMeterFromComputeResource(meter.resource),
			include: meter.include,
		})) ?? creditAttributionMeters.map((meter) => ({ meter, include: 0 }))
	const breakdown = buildCreditAttributionBreakdown({
		month,
		dailyUnits,
		includes,
		packageNames: names,
		packageHrefs: hrefs,
	})
	const visitors = await loadPackageAppVisitorAttribution({
		db: input.db,
		stableUserId: input.stableUserId,
		month,
		dailyUnits,
		includes,
	})
	for (const row of breakdown.rows) {
		if (row.isAdHoc) continue
		const visitorData = visitors.get(row.packageId)
		if (!visitorData) continue
		row.visitors = visitorData.rows
		row.visitorCount = visitorData.total
		row.visitorsTruncated = visitorData.truncated
	}
	try {
		breakdown.adHocConnections = await loadAdHocConnectionUsage({
			db: input.db,
			stableUserId: input.stableUserId,
			now,
		})
	} catch (error) {
		console.warn('credit-attribution-adhoc-connections-failed', error)
	}
	return breakdown
}

/**
 * Ad hoc (no package) worker loads per connection this month, from
 * `usage_connection_daily`. That rollup keeps 14 days, so early in the
 * month this covers the whole month and later only the recent window.
 */
export async function loadAdHocConnectionUsage(input: {
	db: D1Database
	stableUserId: string
	now?: Date
}) {
	const now = input.now ?? new Date()
	const monthStart = `${utcMonthKey(now)}-01`
	const retentionStart = utcDayKey(
		new Date(now.getTime() - (connectionUsageRetentionDays - 1) * 86_400_000),
	)
	const sinceDay = retentionStart > monthStart ? retentionStart : monthStart
	const rows =
		(
			await input.db
				.prepare(
					`SELECT credential_kind, credential_id, SUM(units) AS units
					 FROM usage_connection_daily
					 WHERE user_id = ? AND day >= ? AND package_id = ''
						AND event_type = 'dynamic_worker_day'
					 GROUP BY credential_kind, credential_id`,
				)
				.bind(input.stableUserId, sinceDay)
				.all<{
					credential_kind: string
					credential_id: string
					units: number
				}>()
		).results ?? []
	return summarizeAdHocConnectionUsage({
		sinceDay,
		rows: rows.map((row) => ({
			credentialKind: row.credential_kind,
			credentialId: row.credential_id,
			units: Number(row.units) || 0,
		})),
	})
}

const maxPackageAppVisitorRows = 500
const visitorUsernameChunkSize = 80
const visitorUsernameLookupConcurrency = 4
const visitorMeterLabels = {
	unique_worker_days: 'Worker compute',
	durable_object_rows_read: 'Rows read',
} as const

export function selectPackageAppVisitorIds(
	visitors: ReadonlyArray<{ visitorId: string; creditsMicroUsd: number }>,
	limit = maxPackageAppVisitorRows,
) {
	return [...visitors]
		.sort(
			(left, right) =>
				right.creditsMicroUsd - left.creditsMicroUsd ||
				(left.visitorId < right.visitorId
					? -1
					: left.visitorId > right.visitorId
						? 1
						: 0),
		)
		.slice(0, limit)
		.map(({ visitorId }) => visitorId)
}

export async function loadPackageAppVisitorAttribution(input: {
	db: D1Database
	stableUserId: string
	month: string
	dailyUnits: ReadonlyArray<CreditAttributionDailyUnit>
	includes: ReadonlyArray<{ meter: CreditAttributionMeter; include: number }>
}): Promise<
	Map<
		string,
		{
			rows: Array<CreditAttributionVisitorRow>
			total: number
			truncated: boolean
		}
	>
> {
	const nextMonth = nextUtcMonthKey(input.month)
	const result = await input.db
		.prepare(
			`SELECT day, package_id, visitor_user_id, billed_org_id, meter, units
			 FROM package_app_visitor_attribution_daily
			 WHERE user_id = ? AND day >= ? AND day < ?`,
		)
		.bind(input.stableUserId, `${input.month}-01`, `${nextMonth}-01`)
		.all<{
			day: string
			package_id: string
			visitor_user_id: string
			billed_org_id?: string | null
			meter: string
			units: number
		}>()
	const rows = (result.results ?? []).filter(
		(row) =>
			(creditAttributionMeters as ReadonlyArray<string>).includes(row.meter) &&
			Number.isFinite(Number(row.units)) &&
			Number(row.units) > 0,
	)
	const dailyPackageUnits = new Map<string, number>()
	for (const row of input.dailyUnits) {
		const key = `${row.packageId}\0${row.day}\0${row.meter}`
		dailyPackageUnits.set(
			key,
			(dailyPackageUnits.get(key) ?? 0) + Math.max(0, row.units),
		)
	}
	const packageDayCredits = new Map<string, number>()
	const remaining = new Map<CreditAttributionMeter, number>(
		input.includes.map((entry) => [
			entry.meter,
			Number.isFinite(entry.include) ? Math.max(0, entry.include) : 0,
		]),
	)
	for (const meter of creditAttributionMeters) {
		if (!remaining.has(meter)) remaining.set(meter, 0)
	}
	const days = [...new Set(input.dailyUnits.map((row) => row.day))].sort()
	for (const day of days) {
		for (const meter of creditAttributionMeters) {
			const dayRows = input.dailyUnits.filter(
				(row) => row.day === day && row.meter === meter && row.units > 0,
			)
			const totalUnits = dayRows.reduce((sum, row) => sum + row.units, 0)
			if (totalUnits <= 0) continue
			const available = remaining.get(meter) ?? 0
			const covered = Math.min(available, totalUnits)
			remaining.set(meter, available - covered)
			const dayCredits = creditDebitCostMicroUsd(meter, totalUnits - covered)
			let attributed = 0
			dayRows.forEach((row, index) => {
				const credits =
					index === dayRows.length - 1
						? dayCredits - attributed
						: Math.floor((dayCredits * row.units) / totalUnits)
				attributed += credits
				packageDayCredits.set(`${row.packageId}\0${day}\0${meter}`, credits)
			})
		}
	}

	const visitorsByPackage = new Map<
		string,
		Map<
			string,
			{
				lastDay: string
				units: Map<CreditAttributionMeter, number>
				credits: Map<CreditAttributionMeter, number>
				visitorOrgUnits: Map<CreditAttributionMeter, number>
			}
		>
	>()
	for (const row of rows) {
		const meter = row.meter as CreditAttributionMeter
		const visitorId = row.visitor_user_id
		const byVisitor = visitorsByPackage.get(row.package_id) ?? new Map()
		const visitor = byVisitor.get(visitorId) ?? {
			lastDay: row.day,
			units: new Map<CreditAttributionMeter, number>(),
			credits: new Map<CreditAttributionMeter, number>(),
			visitorOrgUnits: new Map<CreditAttributionMeter, number>(),
		}
		if (row.day > visitor.lastDay) visitor.lastDay = row.day
		const units = Number(row.units)
		if (row.billed_org_id?.trim()) {
			// The visitor's own org paid (ADR 0095): show the units, but none of
			// this org's credits are theirs.
			visitor.visitorOrgUnits.set(
				meter,
				(visitor.visitorOrgUnits.get(meter) ?? 0) + units,
			)
			byVisitor.set(visitorId, visitor)
			visitorsByPackage.set(row.package_id, byVisitor)
			continue
		}
		visitor.units.set(meter, (visitor.units.get(meter) ?? 0) + units)
		const packageUnits =
			dailyPackageUnits.get(`${row.package_id}\0${row.day}\0${meter}`) ?? 0
		const packageCredits =
			packageDayCredits.get(`${row.package_id}\0${row.day}\0${meter}`) ?? 0
		const visitorCredits =
			packageUnits > 0 ? Math.floor((packageCredits * units) / packageUnits) : 0
		visitor.credits.set(
			meter,
			(visitor.credits.get(meter) ?? 0) + visitorCredits,
		)
		byVisitor.set(visitorId, visitor)
		visitorsByPackage.set(row.package_id, byVisitor)
	}

	const rankedByPackage = new Map<
		string,
		Array<{
			visitorId: string
			visitor: {
				lastDay: string
				units: Map<CreditAttributionMeter, number>
				credits: Map<CreditAttributionMeter, number>
				visitorOrgUnits: Map<CreditAttributionMeter, number>
			}
			creditsMicroUsd: number
		}>
	>()
	const retainedIds = new Set<string>()
	for (const [packageId, visitors] of visitorsByPackage) {
		const ranked = [...visitors.entries()].map(([visitorId, visitor]) => ({
			visitorId,
			visitor,
			creditsMicroUsd: [...visitor.credits.values()].reduce(
				(sum, credits) => sum + credits,
				0,
			),
		}))
		const retained = new Set(
			selectPackageAppVisitorIds(ranked, maxPackageAppVisitorRows),
		)
		const selected = ranked.filter(({ visitorId }) => retained.has(visitorId))
		for (const { visitorId } of selected) {
			if (visitorId) retainedIds.add(visitorId)
		}
		rankedByPackage.set(packageId, selected)
	}

	const ids = [...retainedIds]
	const usernames = new Map<string, string>()
	const chunks: Array<Array<string>> = []
	for (let index = 0; index < ids.length; index += visitorUsernameChunkSize) {
		chunks.push(ids.slice(index, index + visitorUsernameChunkSize))
	}
	let nextChunk = 0
	await Promise.all(
		Array.from(
			{ length: Math.min(visitorUsernameLookupConcurrency, chunks.length) },
			async () => {
				while (nextChunk < chunks.length) {
					const chunk = chunks[nextChunk++]
					if (!chunk) continue
					const placeholders = chunk.map(() => '?').join(', ')
					const users = await input.db
						.prepare(
							`SELECT stable_user_id, username
							 FROM users
							 WHERE stable_user_id IN (${placeholders})
								AND deleting_at IS NULL${andLiveDeletedAtSql()}`,
						)
						.bind(...chunk)
						.all<{ stable_user_id: string; username: string }>()
					for (const user of users.results ?? []) {
						const username = user.username?.trim()
						if (username) usernames.set(user.stable_user_id, username)
					}
				}
			},
		),
	)

	const byPackage = new Map<
		string,
		{
			rows: Array<CreditAttributionVisitorRow>
			total: number
			truncated: boolean
		}
	>()
	for (const [packageId, selected] of rankedByPackage) {
		const visitors = visitorsByPackage.get(packageId) ?? new Map()
		const displayRows = selected.map(({ visitorId, visitor }) => {
			const meters = creditAttributionMeters.flatMap((meter) => {
				const label = visitorMeterLabels[meter]
				const paid = {
					meter,
					label,
					units: visitor.units.get(meter) ?? 0,
					creditsMicroUsd: visitor.credits.get(meter) ?? 0,
				}
				const visitorOrg = {
					meter,
					label,
					units: visitor.visitorOrgUnits.get(meter) ?? 0,
					creditsMicroUsd: 0,
					billedToVisitorOrg: true,
				}
				return [paid, visitorOrg].filter((entry) => entry.units > 0)
			})
			const billedToVisitorOrg = visitor.visitorOrgUnits.size > 0
			return {
				visitorId,
				row: {
					displayName: visitorId
						? (usernames.get(visitorId) ?? 'Deleted account')
						: 'Anonymous visitor',
					creditsMicroUsd: meters.reduce(
						(sum, meter) => sum + meter.creditsMicroUsd,
						0,
					),
					lastDay: visitor.lastDay,
					...(billedToVisitorOrg ? { billedToVisitorOrg } : {}),
					meters,
				},
			}
		})
		displayRows.sort(
			(left, right) =>
				right.row.creditsMicroUsd - left.row.creditsMicroUsd ||
				left.row.displayName.localeCompare(right.row.displayName) ||
				(left.visitorId < right.visitorId
					? -1
					: left.visitorId > right.visitorId
						? 1
						: 0),
		)
		byPackage.set(packageId, {
			total: visitors.size,
			truncated: visitors.size > maxPackageAppVisitorRows,
			rows: displayRows.map(({ row }) => row),
		})
	}
	return byPackage
}

/** Where-it-went label for another org's app this org paid to use. */
export function sharedPackageAppLabel(input: {
	name: string
	ownerSlug: string
}) {
	return `${input.name} (app shared by @${input.ownerSlug})`
}

export async function loadPackageAttributionLabels(input: {
	db: D1Database
	stableUserId: string
	username: string
	packageIds: Array<string>
}): Promise<{
	names: Map<string, string>
	hrefs: Map<string, string>
}> {
	const names = new Map<string, string>()
	const hrefs = new Map<string, string>()
	if (input.packageIds.length === 0) return { names, hrefs }
	for (
		let index = 0;
		index < input.packageIds.length;
		index += attributionPackageLabelChunkSize
	) {
		const chunk = input.packageIds.slice(
			index,
			index + attributionPackageLabelChunkSize,
		)
		const placeholders = chunk.map(() => '?').join(', ')
		const rows = await input.db
			.prepare(
				`SELECT id, kody_id, name
				 FROM saved_packages
				 WHERE user_id = ?
				 AND id IN (${placeholders})${andLiveDeletedAtSql()}`,
			)
			.bind(input.stableUserId, ...chunk)
			.all<{ id: string; kody_id: string; name: string }>()
		for (const row of rows.results ?? []) {
			names.set(row.id, row.name?.trim() || row.kody_id)
			hrefs.set(
				row.id,
				routes.communityPackage.href({
					username: input.username,
					kodyId: row.kody_id,
				}),
			)
		}
	}
	// A package this org does not own is another org's internal app that this
	// org's people visited; this org paid for that metered work (ADR 0095).
	const shared = input.packageIds.filter((packageId) => !names.has(packageId))
	for (
		let index = 0;
		index < shared.length;
		index += attributionPackageLabelChunkSize
	) {
		const chunk = shared.slice(index, index + attributionPackageLabelChunkSize)
		const placeholders = chunk.map(() => '?').join(', ')
		const rows = await input.db
			.prepare(
				`SELECT sp.id, sp.kody_id, sp.name, o.slug AS owner_slug
				 FROM saved_packages sp
				 INNER JOIN orgs o ON o.id = sp.user_id
				 WHERE sp.id IN (${placeholders})${andLiveDeletedAtSql('sp')}${andLiveDeletedAtSql('o')}`,
			)
			.bind(...chunk)
			.all<{ id: string; kody_id: string; name: string; owner_slug: string }>()
		for (const row of rows.results ?? []) {
			names.set(
				row.id,
				sharedPackageAppLabel({
					name: row.name?.trim() || row.kody_id,
					ownerSlug: row.owner_slug,
				}),
			)
			hrefs.set(
				row.id,
				routes.communityPackage.href({
					username: row.owner_slug,
					kodyId: row.kody_id,
				}),
			)
		}
	}
	return { names, hrefs }
}
