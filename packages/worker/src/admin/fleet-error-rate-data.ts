/**
 * Admin fleet package-runtime error-rate read model.
 *
 * Reuses the KV snapshot that `/admin/insights` shows, and adds a daily
 * Analytics Engine breakdown of caught vs error outcomes (same fleet metrics
 * as the alert) plus distinct billing owners with errors. Aggregates only —
 * never returns usernames or package lists from the daily query. The snapshot
 * may still carry concentration names when elevated (same as the page).
 */

import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { type AdminInsightsPackageErrorRate } from '#universal/loader-data.ts'
import { personalOrgIdFromUserRow } from '#worker/orgs/personal-org-id.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	queryAnalyticsEngineSql,
	resolveUsageEventsDataset,
} from '#worker/usage/aggregate-rollups.ts'
import {
	loadFleetPackageErrorRateSnapshot,
	type FleetPackageErrorRateEnv,
	type FleetPackageErrorRateSnapshot,
} from '#worker/usage/fleet-package-error-rate.ts'
import { fleetPackageErrorRateMetrics } from '#worker/usage/fleet-package-error-rate-subscription-event.ts'

export const adminFleetErrorRateDefaultDays = 7
export const adminFleetErrorRateMaxDays = 31

const utcDayMs = 24 * 60 * 60 * 1000
const analyticsEngineIdPattern = /^[A-Za-z0-9:._-]+$/

export type AdminFleetErrorRateDailyRow = {
	day: string
	errorCount: number
	caughtCount: number
	usersWithErrors: number
}

export type AdminFleetErrorRateData = {
	snapshot: AdminInsightsPackageErrorRate
	days: number
	startDay: string
	endDay: string
	dailyAvailable: boolean
	daily: Array<AdminFleetErrorRateDailyRow>
	/** Echo of a requested person filter; null for fleet aggregates. */
	filter: { stableUserId: string } | null
}

export type AdminFleetErrorRateOutcomeAnalyticsRow = {
	day?: string
	error_count?: number | string
	caught_count?: number | string
}

export type AdminFleetErrorRateUsersAnalyticsRow = {
	day?: string
	users_with_errors?: number | string
}

/**
 * Map the KV fleet snapshot into the insights / capability shape. Shared so
 * the page and `adminFleetErrorRate` cannot drift.
 */
export function toAdminInsightsPackageErrorRate(
	snapshot: FleetPackageErrorRateSnapshot | null,
): AdminInsightsPackageErrorRate {
	if (!snapshot) {
		return {
			available: false,
			updatedAt: null,
			environment: null,
			day: null,
			hour: null,
			lastAlertAt: null,
			concentration: null,
		}
	}
	return {
		available: true,
		updatedAt: snapshot.updatedAt,
		environment: snapshot.environment,
		day: snapshot.day,
		hour: snapshot.hour,
		lastAlertAt: snapshot.lastAlertAt,
		concentration: snapshot.concentration,
	}
}

export function resolveAdminFleetErrorRateWindow(input: {
	days: number
	now?: Date
}): { days: number; startDay: string; endDay: string; nextDay: string } {
	const days = clampDays(input.days)
	const now = input.now ?? new Date()
	const endDay = utcDayKey(now)
	const startDay = utcDayKey(new Date(now.getTime() - (days - 1) * utcDayMs))
	const nextDay = utcDayKey(new Date(now.getTime() + utcDayMs))
	return { days, startDay, endDay, nextDay }
}

function fleetMetricsInClause() {
	return fleetPackageErrorRateMetrics.map((metric) => `'${metric}'`).join(', ')
}

export function buildAdminFleetErrorRateDailyOutcomeQuery(input: {
	dataset: string
	startDay: string
	nextDay: string
	/** Billing owner ids (blob1). Empty = fleet-wide. */
	billingOwnerIds?: ReadonlyArray<string>
}) {
	const ownerClause = ownerInClause(input.billingOwnerIds)
	return `
SELECT
	toDate(timestamp) AS day,
	sum(if(blob4 = 'error', _sample_interval, 0)) AS error_count,
	sum(if(blob4 = 'caught', _sample_interval, 0)) AS caught_count
FROM ${input.dataset}
WHERE timestamp >= toDateTime('${input.startDay} 00:00:00')
	AND timestamp < toDateTime('${input.nextDay} 00:00:00')
	AND blob2 IN (${fleetMetricsInClause()})${ownerClause}
GROUP BY day
ORDER BY day ASC
FORMAT JSON
`.trim()
}

/**
 * Fleet-wide distinct billing owner ids (`blob1`) with at least one real
 * failure that day. `caught` is excluded (same as the fleet alert). Do not
 * use this under a per-account filter: one person may have both a legacy
 * person id and a personal org id in `blob1`, which would inflate the count
 * to 2 — callers clamp filtered rows to 0/1 instead.
 */
export function buildAdminFleetErrorRateDailyUsersQuery(input: {
	dataset: string
	startDay: string
	nextDay: string
}) {
	return `
SELECT
	toDate(timestamp) AS day,
	count(DISTINCT blob1) AS users_with_errors
FROM ${input.dataset}
WHERE timestamp >= toDateTime('${input.startDay} 00:00:00')
	AND timestamp < toDateTime('${input.nextDay} 00:00:00')
	AND blob2 IN (${fleetMetricsInClause()})
	AND blob4 = 'error'
GROUP BY day
ORDER BY day ASC
FORMAT JSON
`.trim()
}

/** One filtered account: 0 or 1 user with errors that day (never 2+). */
export function usersWithErrorsForFilteredDay(errorCount: number) {
	return errorCount > 0 ? 1 : 0
}

export function foldAdminFleetErrorRateDailyRows(input: {
	outcomeRows: ReadonlyArray<AdminFleetErrorRateOutcomeAnalyticsRow>
	userRows: ReadonlyArray<AdminFleetErrorRateUsersAnalyticsRow>
	startDay: string
	endDay: string
}): Array<AdminFleetErrorRateDailyRow> {
	const byDay = new Map<string, AdminFleetErrorRateDailyRow>()
	for (const row of input.outcomeRows) {
		const day = String(row.day ?? '').slice(0, 'YYYY-MM-DD'.length)
		if (!isDayInInclusiveRange(day, input.startDay, input.endDay)) continue
		const existing = byDay.get(day)
		byDay.set(day, {
			day,
			errorCount: nonNegativeInt(row.error_count),
			caughtCount: nonNegativeInt(row.caught_count),
			usersWithErrors: existing?.usersWithErrors ?? 0,
		})
	}
	for (const row of input.userRows) {
		const day = String(row.day ?? '').slice(0, 'YYYY-MM-DD'.length)
		if (!isDayInInclusiveRange(day, input.startDay, input.endDay)) continue
		const existing = byDay.get(day)
		byDay.set(day, {
			day,
			errorCount: existing?.errorCount ?? 0,
			caughtCount: existing?.caughtCount ?? 0,
			usersWithErrors: nonNegativeInt(row.users_with_errors),
		})
	}
	const out: Array<AdminFleetErrorRateDailyRow> = []
	for (
		let cursor = Date.parse(`${input.startDay}T00:00:00.000Z`);
		cursor <= Date.parse(`${input.endDay}T00:00:00.000Z`);
		cursor += utcDayMs
	) {
		const day = utcDayKey(new Date(cursor))
		out.push(
			byDay.get(day) ?? {
				day,
				errorCount: 0,
				caughtCount: 0,
				usersWithErrors: 0,
			},
		)
	}
	return out
}

type AdminFleetErrorRateEnv = FleetPackageErrorRateEnv & {
	APP_DB?: D1Database
	USAGE_EVENTS?: AnalyticsEngineDataset
	WRANGLER_IS_LOCAL_DEV?: string
}

export async function loadAdminFleetErrorRateData(input: {
	env: AdminFleetErrorRateEnv
	days?: number
	stableUserId?: string
	now?: Date
}): Promise<AdminFleetErrorRateData> {
	const window = resolveAdminFleetErrorRateWindow({
		days: input.days ?? adminFleetErrorRateDefaultDays,
		now: input.now,
	})
	const snapshot = toAdminInsightsPackageErrorRate(
		await loadFleetPackageErrorRateSnapshot(input.env),
	)

	const filter = input.stableUserId
		? { stableUserId: input.stableUserId }
		: null
	const billingOwnerIds = filter
		? await resolveBillingOwnerIds(input.env.APP_DB, filter.stableUserId)
		: []

	const daily = await loadDailyBreakdown({
		env: input.env,
		startDay: window.startDay,
		nextDay: window.nextDay,
		endDay: window.endDay,
		billingOwnerIds: filter ? billingOwnerIds : undefined,
	})

	return {
		snapshot,
		days: window.days,
		startDay: window.startDay,
		endDay: window.endDay,
		dailyAvailable: daily.available,
		daily: daily.rows,
		filter,
	}
}

async function loadDailyBreakdown(input: {
	env: AdminFleetErrorRateEnv
	startDay: string
	nextDay: string
	endDay: string
	billingOwnerIds?: ReadonlyArray<string>
}): Promise<{ available: boolean; rows: Array<AdminFleetErrorRateDailyRow> }> {
	const empty = foldAdminFleetErrorRateDailyRows({
		outcomeRows: [],
		userRows: [],
		startDay: input.startDay,
		endDay: input.endDay,
	})
	if (input.env.WRANGLER_IS_LOCAL_DEV === 'true') {
		return { available: false, rows: empty }
	}
	const accountId = input.env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = input.env.CLOUDFLARE_API_TOKEN?.trim()
	if (!input.env.USAGE_EVENTS || !accountId || !apiToken) {
		return { available: false, rows: empty }
	}
	if (
		input.billingOwnerIds &&
		input.billingOwnerIds.length > 0 &&
		safeOwnerIds(input.billingOwnerIds).length === 0
	) {
		return { available: true, rows: empty }
	}

	const dataset = resolveUsageEventsDataset(input.env)
	const baseUrl =
		input.env.CLOUDFLARE_API_BASE_URL?.trim() || 'https://api.cloudflare.com'
	const filtered = (input.billingOwnerIds?.length ?? 0) > 0
	const queryInput = {
		dataset,
		startDay: input.startDay,
		nextDay: input.nextDay,
		billingOwnerIds: input.billingOwnerIds,
	}
	try {
		const outcomeRows =
			await queryAnalyticsEngineSql<AdminFleetErrorRateOutcomeAnalyticsRow>({
				accountId,
				apiToken,
				baseUrl,
				query: buildAdminFleetErrorRateDailyOutcomeQuery(queryInput),
			})
		if (filtered) {
			const rows = foldAdminFleetErrorRateDailyRows({
				outcomeRows,
				userRows: [],
				startDay: input.startDay,
				endDay: input.endDay,
			}).map((row) => ({
				...row,
				usersWithErrors: usersWithErrorsForFilteredDay(row.errorCount),
			}))
			return { available: true, rows }
		}
		const userRows =
			await queryAnalyticsEngineSql<AdminFleetErrorRateUsersAnalyticsRow>({
				accountId,
				apiToken,
				baseUrl,
				query: buildAdminFleetErrorRateDailyUsersQuery({
					dataset,
					startDay: input.startDay,
					nextDay: input.nextDay,
				}),
			})
		return {
			available: true,
			rows: foldAdminFleetErrorRateDailyRows({
				outcomeRows,
				userRows,
				startDay: input.startDay,
				endDay: input.endDay,
			}),
		}
	} catch (error) {
		console.warn('admin-fleet-error-rate-daily-query-failed', error)
		return { available: false, rows: empty }
	}
}

async function resolveBillingOwnerIds(
	db: D1Database | undefined,
	stableUserId: string,
): Promise<Array<string>> {
	const ids = [stableUserId]
	if (!db) return ids
	const row = await db
		.prepare(
			`SELECT personal_org_id, stable_user_id FROM users
			 WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(stableUserId)
		.first<{ personal_org_id: string | null; stable_user_id: string }>()
	if (!row) return ids
	const personalOrgId = personalOrgIdFromUserRow(row)
	if (personalOrgId !== stableUserId) ids.push(personalOrgId)
	return ids
}

function ownerInClause(billingOwnerIds: ReadonlyArray<string> | undefined) {
	if (!billingOwnerIds || billingOwnerIds.length === 0) return ''
	const list = safeOwnerIds(billingOwnerIds)
		.map((id) => `'${id}'`)
		.join(', ')
	if (list.length === 0) return ''
	return `
	AND blob1 IN (${list})`
}

function safeOwnerIds(ids: ReadonlyArray<string>) {
	return ids.filter((id) => analyticsEngineIdPattern.test(id))
}

function clampDays(days: number) {
	if (!Number.isFinite(days)) return adminFleetErrorRateDefaultDays
	return Math.min(adminFleetErrorRateMaxDays, Math.max(1, Math.round(days)))
}

function nonNegativeInt(value: number | string | undefined) {
	return Math.max(0, Math.round(Number(value ?? 0)) || 0)
}

function isDayInInclusiveRange(day: string, startDay: string, endDay: string) {
	return day.length === 'YYYY-MM-DD'.length && day >= startDay && day <= endDay
}
