import { cachified, type Cache } from '@epic-web/cachified'
import { utcDayKey, utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { toAdminDynamicWorkerCost } from '#universal/dynamic-worker-cost.ts'
import {
	toAdminDurableObjectDuration,
	toAdminMeasuredDurableObjectDuration,
} from '#universal/durable-object-duration.ts'
import {
	type AdminUsageMetric,
	type AdminUsageMonthRollup,
	type AdminUsageRollup,
	type AdminUserUsageLoaderData,
} from '#universal/loader-data.ts'
import {
	parseEntitlementLadder,
	parseStoredPlanName,
	resolveEffectivePlan,
	resolvePlanLimits,
	type UserEntitlement,
} from '#universal/plans.ts'
import { toAdminCostVsPay } from '#worker/admin/cost-vs-pay.ts'
import { readAdminEntitlementConsumption } from '#worker/admin/entitlement-consumption.ts'
import {
	AdminOrgLimitOverrideError,
	resolveAdminOrgTarget,
	type AdminOrgTarget,
} from '#worker/admin/org-limit-overrides.ts'
import { adminUsageMetrics } from '#worker/admin/user-usage-data.ts'
import { isCreditsEligiblePriceId } from '#worker/billing/billing-config.ts'
import { resolveStripePriceCatalog } from '#worker/billing/stripe-price-catalog.ts'
import {
	resolveUserEntitlementFromRow,
	userEntitlementColumnsSql,
	type UserEntitlementRow,
} from '#worker/entitlements/service.ts'
import { createKvCachifiedCache } from '#worker/kv-cachified.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

const rollupCacheTtlMs = 5 * 60 * 1000

type AdminOrgUsageRow = UserEntitlementRow & {
	id: string
	slug: string
	display_name: string | null
	stripe_price_id: string | null
}

type AdminUsageRollupRow = {
	user_id: string
	metric: string
	month: string
	event_count: number
	error_count: number
	caught_count?: number | null
	total_duration_ms: number
	total_cpu_ms: number
	total_bytes: number
}

export type AdminOrgUsageLoaderData = Omit<
	AdminUserUsageLoaderData,
	'stableUserId' | 'username'
> & {
	org: { id: string; slug: string; displayName: string | null }
}

/**
 * Usage drill-down for one org (personal or team): month-over-month usage
 * rollups plus current entitlement consumption against plan limits. Keys
 * UserMeter and usage_rollups by `orgs.id`. Returns null when the org target
 * does not resolve.
 */
export async function loadAdminOrgUsageData(
	env: Env,
	target: AdminOrgTarget,
	now: Date = new Date(),
): Promise<AdminOrgUsageLoaderData | null> {
	let orgTarget
	try {
		orgTarget = await resolveAdminOrgTarget(env.APP_DB, target)
	} catch (error) {
		if (error instanceof AdminOrgLimitOverrideError && error.status === 404) {
			return null
		}
		throw error
	}

	const row = await env.APP_DB.prepare(
		`SELECT o.id, o.slug, o.display_name, o.stripe_price_id, ${userEntitlementColumnsSql('o')}
		 FROM orgs o
		 WHERE o.id = ?${andLiveDeletedAtSql('o')}`,
	)
		.bind(orgTarget.id)
		.first<AdminOrgUsageRow>()
	if (!row) return null

	const usageUserId = ownerIdFromStored(row.id)
	const entitlement = await resolveUserEntitlementFromRow({
		db: env.APP_DB,
		stableUserId: usageUserId,
		row,
		now,
	})
	const plan = entitlement.plan
	const includedUniqueWorkerDays = resolvePlanLimits(
		plan,
		entitlement.ladder,
		entitlement.creditWallet,
	).maxUniqueWorkerDaysPerMonth
	const currentMonth = utcMonthKey(now)
	const today = utcDayKey(now)
	const rollupCache = env.BUNDLE_ARTIFACTS_KV
		? createKvCachifiedCache(env.BUNDLE_ARTIFACTS_KV)
		: null

	const [monthRows, entitlementConsumption, measuredDuration] =
		await Promise.all([
			loadOwnerMonthRollups({
				db: env.APP_DB,
				cache: rollupCache,
				userId: usageUserId,
				currentMonth,
			}),
			readAdminEntitlementConsumption({
				env,
				usageUserId,
				entitlement,
				now,
				inboundReceive: inboundReceiveAgainstBasePlan(row, entitlement),
			}),
			loadMeasuredDurableObjectDuration({
				db: env.APP_DB,
				userId: usageUserId,
				currentMonth,
			}),
		])

	const monthUsage = toMonthUsage(monthRows, currentMonth)
	const currentMonthUsage =
		monthUsage.find((entry) => entry.month === currentMonth)?.usage ??
		toCompleteUsage([])
	const uniqueWorkerDays =
		currentMonthUsage.find((entry) => entry.metric === 'dynamic_worker_day')
			?.eventCount ?? 0
	const durableObjectUsage = currentMonthUsage.find(
		(entry) => entry.metric === 'durable_object_gb_seconds',
	)
	const costVsPay = toAdminCostVsPay({
		uniqueWorkerDays,
		stripePlan: row.stripe_plan,
		stripePriceId: row.stripe_price_id,
		catalog: resolveStripePriceCatalog(env),
		manualPlan: row.plan,
		username: row.slug,
		isOperator: false,
		includedPerAccountMonth: includedUniqueWorkerDays,
		// Only purchasable seat prices track live seats in Stripe (seat-sync skips
		// retired prices), so retired subscriptions keep the unit estimate.
		quantity: isCreditsEligiblePriceId(env, row.stripe_price_id)
			? (entitlement.seats ?? 1)
			: 1,
	})

	return {
		ok: true,
		org: {
			id: usageUserId,
			slug: row.slug,
			displayName: row.display_name,
		},
		plan,
		currentMonth,
		today,
		currentMonthUsage,
		monthUsage,
		entitlementConsumption,
		warnings: entitlementConsumption.filter((item) => item.overEightyPercent),
		dynamicWorkerCost: toAdminDynamicWorkerCost(
			uniqueWorkerDays,
			includedUniqueWorkerDays,
		),
		durableObjectDuration: {
			...toAdminDurableObjectDuration({
				durationMs: durableObjectUsage?.totalDurationMs ?? 0,
				rpcCount: durableObjectUsage?.eventCount ?? 0,
			}),
			measured: toAdminMeasuredDurableObjectDuration(measuredDuration),
		},
		costVsPay,
	}
}

/**
 * Inbound receives enforce the base (manual + Stripe) plan so a temporary Pro
 * gift cannot inflate the receive cap. Overlays only raise Free → Pro, so when
 * effective and base differ the base wallet is always `none` and we skip a
 * second credit-wallet read. When they match, omit the override entirely.
 */
function inboundReceiveAgainstBasePlan(
	row: Pick<UserEntitlementRow, 'plan' | 'stripe_plan' | 'entitlement_ladder'>,
	effective: UserEntitlement,
): UserEntitlement | undefined {
	const basePlan = resolveEffectivePlan(
		parseStoredPlanName(row.plan),
		row.stripe_plan,
	)
	if (basePlan === effective.plan) return undefined
	return {
		plan: basePlan,
		ladder: parseEntitlementLadder(row.entitlement_ladder),
		creditWallet: 'none',
		limitOverrides: effective.limitOverrides,
	}
}

async function loadMeasuredDurableObjectDuration(input: {
	db: D1Database
	userId: string
	currentMonth: string
}) {
	try {
		const rows = await input.db
			.prepare(
				`SELECT do_class, SUM(active_ms) AS active_ms, MAX(day) AS last_day
				 FROM durable_object_duration_daily
				 WHERE user_id = ? AND day >= ? AND day < ?
				 GROUP BY do_class`,
			)
			.bind(
				input.userId,
				`${input.currentMonth}-01`,
				`${input.currentMonth}-32`,
			)
			.all<{ do_class: string; active_ms: number; last_day: string }>()
		return (rows.results ?? []).map((row) => ({
			doClass: row.do_class,
			activeMs: Number(row.active_ms) || 0,
			lastDay: row.last_day,
		}))
	} catch (error) {
		console.debug('measured-durable-object-duration-read-failed', error)
		return []
	}
}

async function loadOwnerMonthRollups(input: {
	db: D1Database
	cache: Cache | null
	userId: string
	currentMonth: string
}) {
	if (!input.cache) return await queryOwnerMonthRollups(input)
	return await cachified({
		key: `usage-rollups:org:${input.userId}:asof:${input.currentMonth}`,
		cache: input.cache,
		ttl: rollupCacheTtlMs,
		getFreshValue: () => queryOwnerMonthRollups(input),
	})
}

async function queryOwnerMonthRollups(input: {
	db: D1Database
	userId: string
}) {
	const result = await input.db
		.prepare(
			`SELECT user_id, metric, month, event_count, error_count, caught_count,
				total_duration_ms, total_cpu_ms, total_bytes
			 FROM usage_rollups
			 WHERE user_id = ?
			 ORDER BY month DESC, metric ASC`,
		)
		.bind(input.userId)
		.all<AdminUsageRollupRow>()
	return result.results ?? []
}

function toMonthUsage(
	rows: Array<AdminUsageRollupRow>,
	currentMonth: string,
): Array<AdminUsageMonthRollup> {
	const byMonth = new Map<string, Array<AdminUsageRollupRow>>()
	for (const row of rows) {
		const current = byMonth.get(row.month) ?? []
		current.push(row)
		byMonth.set(row.month, current)
	}
	if (!byMonth.has(currentMonth)) {
		byMonth.set(currentMonth, [])
	}
	return Array.from(byMonth.entries())
		.sort(([left], [right]) => right.localeCompare(left))
		.slice(0, 12)
		.map(([month, usage]) => ({ month, usage: toCompleteUsage(usage) }))
}

function toCompleteUsage(rows: Array<AdminUsageRollupRow>) {
	const byMetric = new Map<string, AdminUsageRollupRow>()
	for (const row of rows) {
		if (isAdminUsageMetric(row.metric)) byMetric.set(row.metric, row)
	}
	return adminUsageMetrics.map((metric) =>
		toUsageRollup(metric, byMetric.get(metric)),
	)
}

function toUsageRollup(
	metric: AdminUsageMetric,
	row: AdminUsageRollupRow | undefined,
): AdminUsageRollup {
	return {
		metric,
		eventCount: Number(row?.event_count ?? 0),
		errorCount: Number(row?.error_count ?? 0),
		caughtCount: Number(row?.caught_count ?? 0),
		totalDurationMs: Number(row?.total_duration_ms ?? 0),
		totalCpuMs: Number(row?.total_cpu_ms ?? 0),
		totalBytes: Number(row?.total_bytes ?? 0),
	}
}

function isAdminUsageMetric(metric: string): metric is AdminUsageMetric {
	return (adminUsageMetrics as ReadonlyArray<string>).includes(metric)
}
