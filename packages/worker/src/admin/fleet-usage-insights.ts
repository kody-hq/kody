import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	estimateDynamicWorkerUsd,
	fleetDynamicWorkerCostAlertUsd,
	toAdminDynamicWorkerCost,
} from '#universal/dynamic-worker-cost.ts'
import {
	parseEntitlementLadder,
	parseStoredPlanName,
	resolveEffectivePlan,
	type EntitlementLadder,
	type PlanName,
	type UserEntitlement,
} from '#universal/plans.ts'
import { observeOnlyUsageEventTypes } from '#universal/usage-event-types.ts'
import {
	adminFleetCostVsPayDisplayLimit,
	adminFleetCostVsPayScanLimit,
	rankRiskCostConsumers,
	toAdminCostVsPayConsumer,
} from '#worker/admin/cost-vs-pay.ts'
import { resolveStripePriceCatalog } from '#worker/billing/stripe-price-catalog.ts'
import { adminUsageMetrics } from '#worker/admin/user-usage-data.ts'
import { readAdminEntitlementConsumption } from '#worker/admin/entitlement-consumption.ts'
import {
	resolveUserEntitlementFromRow,
	userEntitlementColumnsSql,
	type UserEntitlementRow,
} from '#worker/entitlements/service.ts'
import type {
	AdminInsightsDurationConsumer,
	AdminInsightsDynamicWorkerCost,
	AdminInsightsEntitlementPressureUser,
	AdminInsightsEventCountConsumer,
	AdminInsightsMetricDurationConsumers,
	AdminPlanName,
	AdminUsageEntitlementResource,
	AdminUsageMetric,
} from '#universal/loader-data.ts'

import {
	joinOrgsOnPersonalOrgIdSql,
	personalOrgIdSql,
} from '#worker/orgs/personal-org-sql.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
export const adminFleetTopConsumersLimit = 10

const observeOnlyMetricPlaceholders = observeOnlyUsageEventTypes
	.map(() => '?')
	.join(', ')

/**
 * Entitlement-pressure sweep and the usage-entitlement alert lane share this
 * bound so fleet reads stay O(1) regardless of user-table size.
 */
export const adminFleetEntitlementSweepUserLimit = 15

export const adminFleetRuntimeDurationMetrics = [
	'execute',
	'job_run',
	'workflow_run',
] as const satisfies ReadonlyArray<AdminUsageMetric>

export const adminFleetRuntimeDurationAlertMetrics =
	adminFleetRuntimeDurationMetrics

/**
 * Combined current-month execute + job_run + workflow_run duration above which
 * a non-admin account warrants operator review. 24h of metered sandbox / job /
 * workflow wall-clock in one UTC month is a practical "heavy but not
 * necessarily abusive" ceiling before paging. Admin accounts are omitted from
 * this signal so operator dogfooding does not page the on-call roster.
 */
export const fleetRuntimeDurationAlertThresholdMs = 24 * 60 * 60 * 1000

const entitlementSweepConcurrency = 4

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

type RuntimeDurationRow = {
	user_id: string
	total_duration_ms: number
}

type ActiveUserRow = UserEntitlementRow & {
	stable_user_id: OwnerId
	/** Personal org id (owner key for usage / wallets / meters). */
	org_id: OwnerId
	username: string
	event_count: number
}

export type FleetEntitlementPressureIssue =
	| {
			kind: 'entitlement'
			stableUserId: string
			username: string
			resource: AdminUsageEntitlementResource
			label: string
			current: number
			limit: number
			percentOfLimit: number
	  }
	| {
			kind: 'runtime_duration'
			stableUserId: string
			username: string
			totalDurationMs: number
	  }
	| {
			kind: 'dynamic_worker_cost'
			stableUserId: string
			username: string
			uniqueWorkerDays: number
			estimatedGrossUsd: number
			thresholdUsd: number
	  }

export type FleetEntitlementCrossingSnapshot = {
	stableUserId: string
	username: string
	plan: PlanName
	ladder: EntitlementLadder
	isAdmin: boolean
	entitlements: Array<{
		resource: AdminUsageEntitlementResource
		label: string
		current: number
		limit: number
		percentOfLimit: number | null
		overEightyPercent: boolean
	}>
	runtimeDurationMs: number
	uniqueWorkerDays: number
}

export async function loadFleetUsageInsights(input: {
	db: D1Database
	env: Env
	now: Date
}): Promise<{
	topRuntimeDurationConsumers: Array<AdminInsightsDurationConsumer>
	topEventCountConsumers: Array<AdminInsightsEventCountConsumer>
	topDurationConsumersByMetric: Array<AdminInsightsMetricDurationConsumers>
	entitlementPressure: Array<AdminInsightsEntitlementPressureUser>
	dynamicWorkerCost: AdminInsightsDynamicWorkerCost
}> {
	const currentMonth = utcMonthKey(input.now)
	const [
		topRuntimeDurationConsumers,
		topEventCountConsumers,
		topDurationConsumersByMetric,
		entitlementPressure,
		dynamicWorkerCost,
	] = await Promise.all([
		queryTopRuntimeDurationConsumers(input.db, currentMonth),
		queryTopEventCountConsumers(input.db, currentMonth),
		queryTopDurationConsumersByMetric(input.db, currentMonth),
		buildEntitlementPressurePanel(input),
		queryDynamicWorkerCost(input.db, input.env, currentMonth),
	])
	return {
		topRuntimeDurationConsumers,
		topEventCountConsumers,
		topDurationConsumersByMetric,
		entitlementPressure,
		dynamicWorkerCost,
	}
}

export async function loadFleetEntitlementCrossingSnapshots(input: {
	db: D1Database
	env: Env
	now: Date
}): Promise<Array<FleetEntitlementCrossingSnapshot>> {
	const currentMonth = utcMonthKey(input.now)
	const activeUsers = await listActiveUsersForEntitlementSweep(
		input.db,
		currentMonth,
	)
	if (activeUsers.length === 0) return []

	const ownerIds = activeUsers.map((user) => user.org_id)
	const [durationByUser, uniqueWorkerDaysByUser, adminUserIds] =
		await Promise.all([
			queryCombinedRuntimeDurationByUserIds(
				input.db,
				currentMonth,
				ownerIds,
				adminFleetRuntimeDurationAlertMetrics,
			),
			queryUniqueWorkerDaysByUserIds(input.db, currentMonth, ownerIds),
			listAdminStableUserIds(input.db),
		])
	const snapshots: Array<FleetEntitlementCrossingSnapshot> = []

	await mapWithConcurrency(
		activeUsers,
		entitlementSweepConcurrency,
		async (user) => {
			const effective = await resolveUserEntitlementFromRow({
				db: input.env.APP_DB,
				stableUserId: user.org_id,
				row: user,
				now: input.now,
			})
			const { plan, ladder } = effective
			const consumption = await readAdminEntitlementConsumption({
				env: input.env,
				usageUserId: user.org_id,
				entitlement: effective,
				now: input.now,
				inboundReceive: inboundReceiveAgainstBasePlan(user, effective),
			})
			snapshots.push({
				stableUserId: user.stable_user_id,
				username: user.username,
				plan,
				ladder,
				isAdmin: adminUserIds.has(user.stable_user_id),
				entitlements: consumption.map((item) => ({
					resource: item.resource,
					label: item.label,
					current: item.current,
					limit: item.limit,
					percentOfLimit: item.percentOfLimit,
					overEightyPercent: item.overEightyPercent,
				})),
				runtimeDurationMs: durationByUser.get(user.org_id) ?? 0,
				uniqueWorkerDays: uniqueWorkerDaysByUser.get(user.org_id) ?? 0,
			})
		},
	)

	return snapshots.sort((left, right) =>
		left.stableUserId.localeCompare(right.stableUserId),
	)
}

export async function detectFleetUsagePressure(input: {
	db: D1Database
	env: Env
	now: Date
	runtimeDurationThresholdMs?: number
}): Promise<Array<FleetEntitlementPressureIssue>> {
	const runtimeDurationThresholdMs =
		input.runtimeDurationThresholdMs ?? fleetRuntimeDurationAlertThresholdMs
	const snapshots = await loadFleetEntitlementCrossingSnapshots(input)
	const issues: Array<FleetEntitlementPressureIssue> = []
	for (const snapshot of snapshots) {
		for (const item of snapshot.entitlements) {
			if (!item.overEightyPercent || item.percentOfLimit == null) continue
			issues.push({
				kind: 'entitlement',
				stableUserId: snapshot.stableUserId,
				username: snapshot.username,
				resource: item.resource,
				label: item.label,
				current: item.current,
				limit: item.limit,
				percentOfLimit: item.percentOfLimit,
			})
		}
		if (snapshot.isAdmin) continue
		if (snapshot.runtimeDurationMs > runtimeDurationThresholdMs) {
			issues.push({
				kind: 'runtime_duration',
				stableUserId: snapshot.stableUserId,
				username: snapshot.username,
				totalDurationMs: snapshot.runtimeDurationMs,
			})
		}
		const thresholdUsd = fleetDynamicWorkerCostAlertUsd(snapshot.plan)
		if (thresholdUsd == null) continue
		const estimatedGrossUsd = estimateDynamicWorkerUsd(
			snapshot.uniqueWorkerDays,
		)
		if (estimatedGrossUsd >= thresholdUsd) {
			issues.push({
				kind: 'dynamic_worker_cost',
				stableUserId: snapshot.stableUserId,
				username: snapshot.username,
				uniqueWorkerDays: snapshot.uniqueWorkerDays,
				estimatedGrossUsd,
				thresholdUsd,
			})
		}
	}
	return issues
}

async function queryTopRuntimeDurationConsumers(
	db: D1Database,
	currentMonth: string,
): Promise<Array<AdminInsightsDurationConsumer>> {
	const metricPlaceholders = adminFleetRuntimeDurationMetrics
		.map(() => '?')
		.join(', ')
	const rows = await db
		.prepare(
			`SELECT u.stable_user_id, u.username, SUM(r.total_duration_ms) AS total_duration_ms
			 FROM usage_rollups r
			 INNER JOIN users u ON ${personalOrgIdSql} = r.user_id
			 WHERE r.month = ?
				AND r.metric IN (${metricPlaceholders})
				AND u.deleting_at IS NULL${andLiveDeletedAtSql('u')}
			 GROUP BY u.stable_user_id, u.username
			 ORDER BY total_duration_ms DESC
			 LIMIT ?`,
		)
		.bind(
			currentMonth,
			...adminFleetRuntimeDurationMetrics,
			adminFleetTopConsumersLimit,
		)
		.all<{
			stable_user_id: string
			username: string
			total_duration_ms: number
		}>()
	return (rows.results ?? []).map((row) => ({
		stableUserId: row.stable_user_id,
		username: row.username,
		totalDurationMs: Number(row.total_duration_ms),
	}))
}

async function queryTopEventCountConsumers(
	db: D1Database,
	currentMonth: string,
): Promise<Array<AdminInsightsEventCountConsumer>> {
	const rows = await db
		.prepare(
			`SELECT u.stable_user_id, u.username, SUM(r.event_count) AS event_count
			 FROM usage_rollups r
			 INNER JOIN users u ON ${personalOrgIdSql} = r.user_id
			 WHERE r.month = ?
				AND r.metric NOT IN (${observeOnlyMetricPlaceholders})
				AND u.deleting_at IS NULL${andLiveDeletedAtSql('u')}
			 GROUP BY u.stable_user_id, u.username
			 ORDER BY event_count DESC
			 LIMIT ?`,
		)
		.bind(
			currentMonth,
			...observeOnlyUsageEventTypes,
			adminFleetTopConsumersLimit,
		)
		.all<{ stable_user_id: string; username: string; event_count: number }>()
	return (rows.results ?? []).map((row) => ({
		stableUserId: row.stable_user_id,
		username: row.username,
		eventCount: Number(row.event_count),
	}))
}

async function queryDynamicWorkerCost(
	db: D1Database,
	env: Env,
	currentMonth: string,
): Promise<AdminInsightsDynamicWorkerCost> {
	const catalog = resolveStripePriceCatalog(env)
	const [totalRow, consumerRows, adminUserIds] = await Promise.all([
		db
			.prepare(
				`SELECT COALESCE(SUM(event_count), 0) AS unique_worker_days
				 FROM usage_rollups
				 WHERE month = ?
					AND metric = 'dynamic_worker_day'`,
			)
			.bind(currentMonth)
			.first<{ unique_worker_days: number }>(),
		db
			.prepare(
				`SELECT u.stable_user_id, u.username, o.plan, o.stripe_plan,
					o.stripe_price_id, r.event_count
				 FROM usage_rollups r
				 INNER JOIN orgs o ON o.id = r.user_id${andLiveDeletedAtSql('o')}
				 INNER JOIN users u ON COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id) = o.id
				 WHERE r.month = ?
					AND r.metric = 'dynamic_worker_day'
					AND u.deleting_at IS NULL${andLiveDeletedAtSql('u')}
				 ORDER BY r.event_count DESC
				 LIMIT ?`,
			)
			.bind(currentMonth, adminFleetCostVsPayScanLimit)
			.all<{
				stable_user_id: string
				username: string
				plan: string
				stripe_plan: string | null
				stripe_price_id: string | null
				event_count: number
			}>(),
		listAdminStableUserIds(db),
	])
	const uniqueWorkerDays = Number(totalRow?.unique_worker_days ?? 0)
	const scanned = (consumerRows.results ?? []).map((row) =>
		toAdminCostVsPayConsumer({
			stableUserId: row.stable_user_id,
			username: row.username,
			uniqueWorkerDays: Number(row.event_count),
			stripePlan: row.stripe_plan,
			stripePriceId: row.stripe_price_id,
			catalog,
			manualPlan: row.plan,
			isOperator: adminUserIds.has(row.stable_user_id),
		}),
	)
	return {
		...toAdminDynamicWorkerCost(uniqueWorkerDays),
		topConsumers: scanned.slice(0, adminFleetCostVsPayDisplayLimit),
		riskConsumers: rankRiskCostConsumers(scanned),
	}
}

async function queryTopDurationConsumersByMetric(
	db: D1Database,
	currentMonth: string,
): Promise<Array<AdminInsightsMetricDurationConsumers>> {
	const metricPlaceholders = adminFleetRuntimeDurationMetrics
		.map(() => '?')
		.join(', ')
	const rows = await db
		.prepare(
			`SELECT ranked.stable_user_id, ranked.metric, ranked.total_duration_ms, ranked.username
			 FROM (
				SELECT u.stable_user_id, r.metric, r.total_duration_ms, u.username,
					ROW_NUMBER() OVER (
						PARTITION BY r.metric
						ORDER BY r.total_duration_ms DESC
					) AS rank_in_metric
				FROM usage_rollups r
				INNER JOIN users u ON ${personalOrgIdSql} = r.user_id
				WHERE r.month = ?
					AND r.metric IN (${metricPlaceholders})
					AND r.total_duration_ms > 0
					AND u.deleting_at IS NULL${andLiveDeletedAtSql('u')}
			 ) AS ranked
			 WHERE ranked.rank_in_metric <= ?
			 ORDER BY ranked.metric ASC, ranked.total_duration_ms DESC`,
		)
		.bind(
			currentMonth,
			...adminFleetRuntimeDurationMetrics,
			adminFleetTopConsumersLimit,
		)
		.all<{
			stable_user_id: string
			metric: string
			total_duration_ms: number
			username: string
		}>()

	const byMetric = new Map<
		AdminUsageMetric,
		Array<AdminInsightsDurationConsumer>
	>()
	for (const metric of adminFleetRuntimeDurationMetrics) {
		byMetric.set(metric, [])
	}
	for (const row of rows.results ?? []) {
		if (!isAdminUsageMetric(row.metric)) continue
		const consumers = byMetric.get(row.metric)
		if (!consumers) continue
		consumers.push({
			stableUserId: row.stable_user_id,
			username: row.username,
			totalDurationMs: Number(row.total_duration_ms),
		})
	}
	return adminFleetRuntimeDurationMetrics.map((metric) => ({
		metric,
		consumers: byMetric.get(metric) ?? [],
	}))
}

async function buildEntitlementPressurePanel(input: {
	db: D1Database
	env: Env
	now: Date
}): Promise<Array<AdminInsightsEntitlementPressureUser>> {
	const currentMonth = utcMonthKey(input.now)
	const activeUsers = await listActiveUsersForEntitlementSweep(
		input.db,
		currentMonth,
	)
	if (activeUsers.length === 0) return []

	const pressured: Array<AdminInsightsEntitlementPressureUser> = []
	await mapWithConcurrency(
		activeUsers,
		entitlementSweepConcurrency,
		async (user) => {
			const entitlement = await resolveUserEntitlementFromRow({
				db: input.env.APP_DB,
				stableUserId: user.org_id,
				row: user,
				now: input.now,
			})
			const plan = toAdminPlanName(entitlement.plan)
			const consumption = await readAdminEntitlementConsumption({
				env: input.env,
				usageUserId: user.org_id,
				entitlement,
				now: input.now,
				inboundReceive: inboundReceiveAgainstBasePlan(user, entitlement),
			})
			const pressuredResources = consumption
				.filter((item) => item.overEightyPercent && item.percentOfLimit != null)
				.map((item) => ({
					resource: item.resource,
					label: item.label,
					current: item.current,
					limit: item.limit,
					percentOfLimit: item.percentOfLimit!,
				}))
			if (pressuredResources.length === 0) return
			pressured.push({
				stableUserId: user.stable_user_id,
				username: user.username,
				plan,
				pressuredResources,
			})
		},
	)

	return pressured.sort(
		(left, right) =>
			right.pressuredResources.length - left.pressuredResources.length ||
			left.username.localeCompare(right.username),
	)
}

async function listActiveUsersForEntitlementSweep(
	db: D1Database,
	currentMonth: string,
): Promise<Array<ActiveUserRow>> {
	const entitlementColumns = userEntitlementColumnsSql('o')
	const rows = await db
		.prepare(
			`SELECT u.stable_user_id, o.id AS org_id, u.username, ${entitlementColumns}, SUM(r.event_count) AS event_count
			 FROM usage_rollups r
			 INNER JOIN users u ON ${personalOrgIdSql} = r.user_id
			 ${joinOrgsOnPersonalOrgIdSql}${andLiveDeletedAtSql('o')}
			 WHERE r.month = ?
				AND r.metric NOT IN (${observeOnlyMetricPlaceholders})
				AND u.deleting_at IS NULL${andLiveDeletedAtSql('u')}
			 GROUP BY u.stable_user_id, o.id, u.username, ${entitlementColumns}
			 ORDER BY event_count DESC
			 LIMIT ?`,
		)
		.bind(
			currentMonth,
			...observeOnlyUsageEventTypes,
			adminFleetEntitlementSweepUserLimit,
		)
		.all<ActiveUserRow>()
	return rows.results ?? []
}

async function listAdminStableUserIds(db: D1Database) {
	const rows = await db
		.prepare(
			`SELECT u.stable_user_id
			 FROM users u
			 INNER JOIN user_roles ur ON ur.user_id = u.id
			 INNER JOIN roles r ON r.id = ur.role_id
			 WHERE r.name = 'admin'
				AND u.deleting_at IS NULL${andLiveDeletedAtSql()}`,
		)
		.all<{ stable_user_id: string }>()
	return new Set((rows.results ?? []).map((row) => row.stable_user_id))
}

async function queryUniqueWorkerDaysByUserIds(
	db: D1Database,
	currentMonth: string,
	userIds: ReadonlyArray<string>,
): Promise<Map<string, number>> {
	if (userIds.length === 0) return new Map()
	const userPlaceholders = userIds.map(() => '?').join(', ')
	const rows = await db
		.prepare(
			`SELECT user_id, event_count
			 FROM usage_rollups
			 WHERE month = ?
				AND metric = 'dynamic_worker_day'
				AND user_id IN (${userPlaceholders})`,
		)
		.bind(currentMonth, ...userIds)
		.all<{ user_id: string; event_count: number }>()
	const byUser = new Map<string, number>()
	for (const row of rows.results ?? []) {
		byUser.set(row.user_id, Number(row.event_count))
	}
	return byUser
}

async function queryCombinedRuntimeDurationByUserIds(
	db: D1Database,
	currentMonth: string,
	userIds: ReadonlyArray<string>,
	metrics: ReadonlyArray<AdminUsageMetric> = adminFleetRuntimeDurationMetrics,
): Promise<Map<string, number>> {
	if (userIds.length === 0) return new Map()
	const metricPlaceholders = metrics.map(() => '?').join(', ')
	const userPlaceholders = userIds.map(() => '?').join(', ')
	const rows = await db
		.prepare(
			`SELECT user_id, SUM(total_duration_ms) AS total_duration_ms
			 FROM usage_rollups
			 WHERE month = ?
				AND metric IN (${metricPlaceholders})
				AND user_id IN (${userPlaceholders})
			 GROUP BY user_id`,
		)
		.bind(currentMonth, ...metrics, ...userIds)
		.all<RuntimeDurationRow>()
	const byUser = new Map<string, number>()
	for (const row of rows.results ?? []) {
		byUser.set(row.user_id, Number(row.total_duration_ms))
	}
	return byUser
}

function toAdminPlanName(plan: PlanName): AdminPlanName {
	return plan
}

function isAdminUsageMetric(metric: string): metric is AdminUsageMetric {
	return (adminUsageMetrics as ReadonlyArray<string>).includes(metric)
}

async function mapWithConcurrency<T>(
	items: ReadonlyArray<T>,
	concurrency: number,
	mapper: (item: T) => Promise<void>,
): Promise<void> {
	if (items.length === 0) return
	const limit = Math.max(1, Math.min(concurrency, items.length))
	let nextIndex = 0
	await Promise.all(
		Array.from({ length: limit }, async () => {
			while (nextIndex < items.length) {
				const index = nextIndex
				nextIndex += 1
				const item = items[index]
				if (item === undefined) return
				await mapper(item)
			}
		}),
	)
}
