import { expect, test } from 'vitest'
import {
	buildAdminFleetErrorRateDailyFailedRunByErrorNameQuery,
	buildAdminFleetErrorRateDailyOutcomeQuery,
	buildAdminFleetErrorRateDailyStaticCallByErrorNameQuery,
	buildAdminFleetErrorRateDailyUsersQuery,
} from '#worker/admin/fleet-error-rate-data.ts'
import { buildRepoPushQueueCostQuery } from '#worker/admin/repo-push-queue-cost-data.ts'
import { onboardingFunnelCountQuery } from '#worker/identity/onboarding-funnel.ts'
import {
	buildDynamicWorkerInvokeReuseQuery,
	buildDynamicWorkerReuseRatioQuery,
	buildMonthToDateAggregateQuery,
	buildUniqueWorkerDayBySurfaceQuery,
} from './aggregate-rollups.ts'
import { buildConnectionUsageDailyQuery } from './connection-usage-rollup.ts'
import {
	buildCreditAttributionDailyQuery,
	buildPackageAppVisitorAttributionDailyQuery,
} from './credit-attribution.ts'
import {
	buildFleetPackageErrorRateConcentrationPackageQuery,
	buildFleetPackageErrorRateConcentrationQuery,
} from './fleet-package-error-rate-concentration.ts'
import { buildFleetPackageErrorRateAnalyticsQuery } from './fleet-package-error-rate.ts'
import {
	buildFleetUsersAffectedActorQuery,
	buildFleetUsersAffectedPackageActorQuery,
} from './fleet-users-affected.ts'
import {
	buildPackageOwnerErrorSpikeAccountQuery,
	buildPackageOwnerErrorSpikePackageQuery,
} from './package-owner-error-spike.ts'

/**
 * Functions Workers Analytics Engine SQL accepts. It is a small ClickHouse
 * subset: `any()`, `concat()`, `uniq()` and friends fail with HTTP 422
 * "unknown function call". Source:
 * https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/
 * (`toDate` is undocumented but accepted by the production API.)
 */
const analyticsEngineSqlFunctions = new Set(
	[
		// Aggregate
		'count',
		'sum',
		'avg',
		'min',
		'max',
		'quantileExactWeighted',
		'argMax',
		'argMin',
		'first_value',
		'last_value',
		'topK',
		'topKWeighted',
		'countIf',
		'sumIf',
		'avgIf',
		// String
		'length',
		'empty',
		'lower',
		'lowerUTF8',
		'upper',
		'upperUTF8',
		'startsWith',
		'endsWith',
		'position',
		'substring',
		'format',
		'extract',
		// Date and time
		'formatDateTime',
		'now',
		'today',
		'toDate',
		'toDateTime',
		'toYear',
		'toMonth',
		'toDayOfWeek',
		'toDayOfMonth',
		'toHour',
		'toMinute',
		'toSecond',
		'toUnixTimestamp',
		'toStartOfInterval',
		'toStartOfYear',
		'toStartOfMonth',
		'toStartOfWeek',
		'toStartOfDay',
		'toStartOfHour',
		'toStartOfFifteenMinutes',
		'toStartOfTenMinutes',
		'toStartOfFiveMinutes',
		'toStartOfMinute',
		'toYYYYMM',
		// Conditional, math, type conversion
		'if',
		'intDiv',
		'log',
		'pow',
		'round',
		'floor',
		'ceil',
		'toUInt8',
		'toUInt32',
	].map((name) => name.toLowerCase()),
)

const sqlKeywordsBeforeParen = new Set(['in', 'and', 'or', 'not'])

function functionCalls(query: string) {
	const names = new Set<string>()
	const withoutStrings = query.replace(/'[^']*'/g, "''")
	for (const match of withoutStrings.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
		const name = match[1]!
		if (!sqlKeywordsBeforeParen.has(name.toLowerCase())) names.add(name)
	}
	return [...names]
}

function required(query: string | null) {
	if (!query) throw new Error('expected a query')
	return query
}

const monthBounds = {
	monthStart: '2026-10-01 00:00:00',
	nextMonthStart: '2026-11-01 00:00:00',
}
const dayBounds = {
	dataset: 'kody_usage_events',
	startDay: '2026-10-01',
	nextDay: '2026-10-02',
}
const windowStart = new Date('2026-10-29T00:00:00.000Z')
const windowEnd = new Date('2026-10-29T01:00:00.000Z')

const queries: Record<string, string> = {
	creditAttributionDaily: buildCreditAttributionDailyQuery(
		'kody_usage_events',
		monthBounds,
	),
	packageAppVisitorAttributionDaily:
		buildPackageAppVisitorAttributionDailyQuery(
			'kody_usage_events',
			monthBounds,
		),
	monthToDateAggregate: buildMonthToDateAggregateQuery(
		'kody_usage_events',
		monthBounds,
	),
	uniqueWorkerDayBySurface: buildUniqueWorkerDayBySurfaceQuery(
		'kody_usage_events',
		monthBounds,
	),
	dynamicWorkerInvokeReuse: buildDynamicWorkerInvokeReuseQuery(
		'kody_usage_events',
		monthBounds,
	),
	dynamicWorkerReuseRatio: buildDynamicWorkerReuseRatioQuery(
		'kody_usage_events',
		monthBounds,
	),
	connectionUsageDaily: buildConnectionUsageDailyQuery('kody_usage_events', {
		startDay: '2026-10-01',
		nextDay: '2026-10-02',
	}),
	fleetUsersAffectedActor: buildFleetUsersAffectedActorQuery({
		dataset: 'kody_usage_events',
		windowStart,
		windowEnd,
		outcomeFilter: 'error',
	}),
	fleetUsersAffectedPackageActor: buildFleetUsersAffectedPackageActorQuery({
		dataset: 'kody_usage_events',
		windowStart,
		windowEnd,
	}),
	fleetPackageErrorRate: buildFleetPackageErrorRateAnalyticsQuery({
		dataset: 'kody_usage_events',
		previousStart: new Date('2026-10-28T23:00:00.000Z'),
		recentStart: windowStart,
		recentEnd: windowEnd,
	}),
	fleetPackageErrorRateConcentration:
		buildFleetPackageErrorRateConcentrationQuery({
			dataset: 'kody_usage_events',
			recentStart: windowStart,
			recentEnd: windowEnd,
		}),
	fleetPackageErrorRateConcentrationPackage: required(
		buildFleetPackageErrorRateConcentrationPackageQuery({
			dataset: 'kody_usage_events',
			recentStart: windowStart,
			recentEnd: windowEnd,
			ownerIds: ['owner-1'],
		}),
	),
	packageOwnerErrorSpikePackage: buildPackageOwnerErrorSpikePackageQuery({
		dataset: 'kody_usage_events',
		windowStart,
		windowEnd,
	}),
	packageOwnerErrorSpikeAccount: buildPackageOwnerErrorSpikeAccountQuery({
		dataset: 'kody_usage_events',
		windowStart,
		windowEnd,
	}),
	adminFleetErrorRateDailyOutcome:
		buildAdminFleetErrorRateDailyOutcomeQuery(dayBounds),
	adminFleetErrorRateDailyUsers:
		buildAdminFleetErrorRateDailyUsersQuery(dayBounds),
	adminFleetErrorRateDailyFailedRunByErrorName:
		buildAdminFleetErrorRateDailyFailedRunByErrorNameQuery(dayBounds),
	adminFleetErrorRateDailyStaticCallByErrorName:
		buildAdminFleetErrorRateDailyStaticCallByErrorNameQuery(dayBounds),
	repoPushQueueCost: buildRepoPushQueueCostQuery(dayBounds),
	onboardingFunnelCount: onboardingFunnelCountQuery({
		dataset: 'kody_onboarding_funnel_events',
		days: 7,
	}),
}

test.each(Object.entries(queries))(
	'%s only calls functions Analytics Engine SQL supports',
	(_name, query) => {
		const unsupported = functionCalls(query).filter(
			(name) => !analyticsEngineSqlFunctions.has(name.toLowerCase()),
		)
		expect(unsupported).toEqual([])
	},
)

test('credit attribution keeps the latest actor and automation source per rollup key', () => {
	const query = queries['creditAttributionDaily']!
	expect(query).toContain('argMax(blob10, timestamp) AS actor_user_id')
	expect(query).toContain('argMax(blob11, timestamp) AS automation_source')
})

test('fleet users affected builds the automation actor key with format()', () => {
	expect(queries['fleetUsersAffectedActor']).toContain(
		"if(blob10 = '', format('automation:{}', blob1), blob10) AS actor_id",
	)
})
