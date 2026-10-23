import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { type AdminInsightsLaunchSignals } from '#universal/loader-data.ts'
import {
	platformPublicOpenedAt,
	platformPublicOpenedDay,
} from '#universal/platform-open.ts'
import {
	adminInsightsRunLogSnapshotKvKey,
	type AggregatedRunLogInsights,
} from '#worker/admin/insights-runlog-snapshot.ts'
import type * as fleetPackageErrorRate from '#worker/usage/fleet-package-error-rate.ts'
import {
	buildAuthDays,
	buildEmailDays,
	buildEmailDeliveryDays,
	buildHeatmapCells,
	buildSignupWeeks,
	buildUsageMonths,
	hoursFromVerifiedToActivation,
	listUtcDayKeys,
	listUtcMonthKeys,
	listUtcWeekStarts,
	loadAdminInsightsData,
	medianOf,
	utcWeekStart,
} from './admin-insights-data.ts'

const now = new Date('2026-07-08T12:00:00.000Z')

const launchSignalMocks = vi.hoisted(() => ({
	loadAdminLaunchSignals: vi.fn(async () => emptyLaunchSignals()),
}))

const fleetUsageMocks = vi.hoisted(() => ({
	loadFleetUsageInsights: vi.fn(async () => ({
		topRuntimeDurationConsumers: [],
		topEventCountConsumers: [],
		topDurationConsumersByMetric: [],
		entitlementPressure: [],
		dynamicWorkerCost: {
			uniqueWorkerDays: 0,
			estimatedGrossUsd: 0,
			usdPerUniqueDay: 0.002,
			includedPerAccountMonth: 1000,
			topConsumers: [],
			riskConsumers: [],
		},
	})),
	loadFleetPackageErrorRateSnapshot: vi.fn<
		typeof fleetPackageErrorRate.loadFleetPackageErrorRateSnapshot
	>(async () => null),
}))

vi.mock('#worker/admin/launch-signals.ts', () => ({
	loadAdminLaunchSignals: launchSignalMocks.loadAdminLaunchSignals,
}))

vi.mock('#worker/admin/fleet-usage-insights.ts', () => ({
	loadFleetUsageInsights: fleetUsageMocks.loadFleetUsageInsights,
}))

vi.mock('#worker/usage/fleet-package-error-rate.ts', () => ({
	loadFleetPackageErrorRateSnapshot:
		fleetUsageMocks.loadFleetPackageErrorRateSnapshot,
}))

function emptyLaunchSignals(): AdminInsightsLaunchSignals {
	const funnel = () =>
		(
			[
				'signed_up',
				'email_verified',
				'first_mcp',
				'first_search',
				'first_execute',
				'first_saved_package',
			] as const
		).map((step) => ({ step, users: 0 }))
	return {
		openedAt: platformPublicOpenedAt,
		openedDay: platformPublicOpenedDay,
		mrrUsdCents: 0,
		paidSubscribers: 0,
		unpricedPaidSubscribers: 0,
		paidSlices: [],
		manualPlans: [],
		stripePlans: [],
		effectivePlans: [],
		overlayPro: 0,
		entitlementLadders: { public: 0, legacy: 0 },
		paidEntitlementLadders: { public: 0, legacy: 0 },
		activeUsers: { hours24: 0, hours48: 0, days7: 0 },
		activation: { overall: funnel(), sinceOpen: funnel() },
		mcpClients: [],
		openPlatformFeedback: 0,
	}
}

function createMemoryKv(snapshot?: AggregatedRunLogInsights) {
	const store = new Map<string, string>()
	if (snapshot) {
		store.set(
			adminInsightsRunLogSnapshotKvKey,
			JSON.stringify({ version: 1, ...snapshot }),
		)
	}
	return {
		async get<T>(key: string, type?: 'json' | 'text') {
			const raw = store.get(key)
			if (raw == null) return null
			return type === 'json' ? (JSON.parse(raw) as T) : raw
		},
		async put(key: string, value: string) {
			store.set(key, value)
		},
	} as unknown as KVNamespace
}

function runLogSnapshot(
	overrides: Partial<AggregatedRunLogInsights> = {},
): AggregatedRunLogInsights {
	return {
		usersAttempted: 0,
		usersLoaded: 0,
		complete: true,
		snapshotUpdatedAt: '2026-07-08T11:00:00.000Z',
		workflowStatuses: [],
		workflowRuns: 0,
		jobSuccessRuns: 0,
		jobErrorRuns: 0,
		packageRunSucceededUsers: 0,
		packageActivatedUsers: 0,
		medianHoursToActivation: null,
		...overrides,
	}
}

test('admin insights pure helpers bucket, zero-fill, fold, and take medians', () => {
	// 2026-07-08 is a Wednesday; 2026-07-06 is the Monday before.
	expect(utcWeekStart(new Date('2026-07-08T12:00:00.000Z'))).toBe('2026-07-06')
	expect(utcWeekStart(new Date('2026-07-06T00:00:00.000Z'))).toBe('2026-07-06')
	// Sunday belongs to the week that started the previous Monday.
	expect(utcWeekStart(new Date('2026-07-05T23:59:59.000Z'))).toBe('2026-06-29')

	expect(listUtcWeekStarts(now, 3)).toEqual([
		'2026-06-22',
		'2026-06-29',
		'2026-07-06',
	])
	expect(listUtcDayKeys(now, 3)).toEqual([
		'2026-07-06',
		'2026-07-07',
		'2026-07-08',
	])
	expect(listUtcMonthKeys(now, 3)).toEqual(['2026-05', '2026-06', '2026-07'])

	expect(
		buildSignupWeeks({
			dayRows: [
				{ day: '2026-06-23', n: 2 },
				{ day: '2026-06-29', n: 1 },
				{ day: '2026-07-04', n: 3 },
				{ day: '2026-07-08', n: 5 },
			],
			usersBeforeWindow: 10,
			now,
			weeks: 3,
		}),
	).toEqual([
		{ weekStart: '2026-06-22', signups: 2, cumulativeUsers: 12 },
		{ weekStart: '2026-06-29', signups: 4, cumulativeUsers: 16 },
		{ weekStart: '2026-07-06', signups: 5, cumulativeUsers: 21 },
	])

	const usageMonths = buildUsageMonths(
		[
			{ month: '2026-06', metric: 'execute', events: 7, errors: 1 },
			{ month: '2026-06', metric: 'job_run', events: 3, errors: 0 },
			{ month: '2026-07', metric: 'not_a_metric', events: 99, errors: 9 },
		],
		now,
		2,
	)
	expect(usageMonths.map((month) => month.month)).toEqual([
		'2026-06',
		'2026-07',
	])
	expect(usageMonths[0]?.events.execute).toBe(7)
	expect(usageMonths[0]?.events.job_run).toBe(3)
	expect(usageMonths[0]?.errorCount).toBe(1)
	expect(usageMonths[1]?.errorCount).toBe(0)
	expect(
		Object.values(usageMonths[1]?.events ?? {}).filter((n) => n !== 0),
	).toEqual([])

	expect(
		buildEmailDays(
			[
				{ day: '2026-07-07', resource: 'email_sends_per_day', n: 4 },
				{ day: '2026-07-07', resource: 'email_receives_per_day', n: 6 },
			],
			now,
			2,
		),
	).toEqual([
		{ day: '2026-07-07', sends: 4, receives: 6 },
		{ day: '2026-07-08', sends: 0, receives: 0 },
	])

	const noDeliveries = {
		delivered: 0,
		deferred: 0,
		bounced: 0,
		failed: 0,
		rejected: 0,
		complained: 0,
	}
	expect(
		buildEmailDeliveryDays(
			[
				{ day: '2026-07-07', event_type: 'delivered', n: 4 },
				{ day: '2026-07-07', event_type: 'bounced', n: 2 },
				{ day: '2026-07-08', event_type: 'complained', n: 1 },
				{ day: '2026-07-08', event_type: 'not-an-outcome', n: 9 },
			],
			now,
			2,
		),
	).toEqual([
		{ ...noDeliveries, day: '2026-07-07', delivered: 4, bounced: 2 },
		{ ...noDeliveries, day: '2026-07-08', complained: 1 },
	])

	const authDays = buildAuthDays(
		[
			{ day: '2026-07-08', result: 'success', n: 9 },
			{ day: '2026-07-08', result: 'failure', n: 2 },
			{ day: '2026-07-08', result: 'rate_limited', n: 1 },
		],
		now,
		2,
	)
	expect(authDays[1]).toEqual({
		day: '2026-07-08',
		success: 9,
		failure: 2,
		rateLimited: 1,
	})

	// 2026-07-01 and 2026-07-08 are both Wednesdays (weekday 3).
	expect(
		buildHeatmapCells([
			{ day: '2026-07-01', hour: '09', n: 2 },
			{ day: '2026-07-08', hour: '09', n: 3 },
			{ day: '2026-07-05', hour: '23', n: 1 },
			{ day: '2026-07-05', hour: 'xx', n: 5 },
		]),
	).toEqual([
		{ weekday: 0, hour: 23, count: 1 },
		{ weekday: 3, hour: 9, count: 5 },
	])

	// Activation latency excludes unverified and pre-verify activations.
	expect(
		hoursFromVerifiedToActivation(
			'2026-07-01T00:00:00.000Z',
			'2026-07-03T00:00:00.000Z',
		),
	).toBe(48)
	expect(
		hoursFromVerifiedToActivation(
			'2026-07-02T00:00:00.000Z',
			'2026-07-01T00:00:00.000Z',
		),
	).toBeNull()
	expect(
		hoursFromVerifiedToActivation(null, '2026-07-05T00:00:00.000Z'),
	).toBeNull()

	// medianOf averages the middle pair and ignores non-finite values.
	expect(medianOf([])).toBeNull()
	expect(medianOf([5])).toBe(5)
	expect(medianOf([1, 3])).toBe(2)
	expect(medianOf([1, 2, 3])).toBe(2)
	expect(medianOf([1, Number.NaN, 3])).toBe(2)
})

function normalizeQuery(query: string) {
	return query.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Ordered `[query substring, row]` pairs: the first match wins. */
const firstRows: Array<[string, object]> = [
	['sum(enabled) as enabled', { total: 4, enabled: 3 }],
	['from users where created_at < ?', { n: 6 }],
	['count(*) as n from users where email_verified_at', { n: 5 }],
	['count(*) as n from users', { n: 8 }],
	['from saved_packages', { n: 11 }],
	['from mcp_memories', { n: 13 }],
	['from email_messages', { n: 15 }],
	['from secret_entries', { n: 7 }],
	['from community_listings', { n: 2 }],
	['from passkeys', { n: 3 }],
	['from oauth_connections', { n: 4 }],
	['from mcp_agent_sessions', { n: 4 }],
	['from community_forks', { n: 3 }],
]

/** Ordered `[query substrings, rows]` pairs: the first full match wins. */
const allRows: Array<[Array<string>, Array<object>]> = [
	[['from users', 'group by day'], [{ day: '2026-07-07', n: 2 }]],
	[
		['from community_forks'],
		[
			{ actor: 'human', n: 2 },
			{ actor: 'agent', n: 1 },
			{ actor: 'unknown', n: 4 },
		],
	],
	[
		['from usage_rollups'],
		[{ month: '2026-07', metric: 'execute', events: 12, errors: 1 }],
	],
	[
		['from email_delivery_events'],
		[
			{ day: '2026-07-08', event_type: 'delivered', n: 5 },
			{ day: '2026-07-08', event_type: 'bounced', n: 1 },
		],
	],
	[
		['from orgs', 'group by plan'],
		[
			{ plan: 'pro', n: 2 },
			{ plan: 'free', n: 6 },
		],
	],
	[
		['from audit_events', 'result'],
		[{ day: '2026-07-08', result: 'success', n: 4 }],
	],
	[['from audit_events', 'group by category'], [{ category: 'auth', n: 4 }]],
	[['substr(timestamp, 12, 2)'], [{ day: '2026-07-08', hour: '09', n: 4 }]],
]

function createInsightsTestDb() {
	const seenQueries: Array<string> = []
	const db = {
		prepare(query: string) {
			seenQueries.push(query)
			const normalized = normalizeQuery(query)
			const createStatement = (params: Array<unknown>) => ({
				async first<T>() {
					const row = firstRows.find(([needle]) => normalized.includes(needle))
					if (!row) throw new Error(`Unsupported first query: ${query}`)
					return row[1] as T
				},
				async all<T>() {
					const match = allRows.find(([needles]) =>
						needles.every((needle) => normalized.includes(needle)),
					)
					if (!match) throw new Error(`Unsupported all query: ${query}`)
					if (normalized.includes('from usage_rollups')) {
						expect(params[0]).toBe('2025-08')
					}
					return { results: match[1] as Array<T> }
				},
				async run() {
					throw new Error(`Unsupported run query: ${query}`)
				},
			})
			return {
				...createStatement([]),
				bind(...params: Array<unknown>) {
					return createStatement(params)
				},
			}
		},
		seenQueries,
	} as unknown as D1Database & { seenQueries: Array<string> }
	return db
}

function createPartialEnv(bindings: { [Key in keyof Env]?: unknown }) {
	return bindings as Env
}

function loadLocalInsights(env: Partial<Env> = {}) {
	const db = createInsightsTestDb()
	return {
		db,
		data: loadAdminInsightsData(
			{
				APP_DB: db,
				AUDIT_DB: db,
				WRANGLER_IS_LOCAL_DEV: 'true',
				...env,
			} as Env,
			now,
		),
	}
}

const emailQuotaUnavailable = 'admin-insights-email-quota-aggregate-unavailable'

test('loadAdminInsightsData assembles the dashboard payload from D1 plus the RunLog snapshot', async () => {
	consoleWarn.mockImplementation(() => {})
	const loaded = loadLocalInsights({
		EMAIL_EVENTS: {} as AnalyticsEngineDataset,
		BUNDLE_ARTIFACTS_KV: createMemoryKv(
			runLogSnapshot({
				usersAttempted: 2,
				usersLoaded: 2,
				complete: true,
				workflowStatuses: [
					{ status: 'complete', count: 8 },
					{ status: 'errored', count: 1 },
				],
				workflowRuns: 9,
				jobSuccessRuns: 20,
				jobErrorRuns: 2,
				packageRunSucceededUsers: 2,
				packageActivatedUsers: 1,
				medianHoursToActivation: 36,
			}),
		),
	})
	const data = await loaded.data

	expect(data.ok).toBe(true)
	expect(consoleWarn).toHaveBeenCalledWith(emailQuotaUnavailable, {
		reason: 'entitlement-daily-counters-retired-local-dev',
	})
	expect(consoleWarn).not.toHaveBeenCalledWith(emailQuotaUnavailable, {
		reason: 'missing-email-events-binding',
	})
	expect(data.totals).toEqual({
		users: 8,
		verifiedUsers: 5,
		savedPackages: 11,
		scheduledJobs: 4,
		enabledJobs: 3,
		workflowRuns: 9,
		activeMemories: 13,
		storedEmailMessages: null,
		secrets: 7,
		activeCommunityListings: 2,
		passkeys: 3,
		oauthConnections: 4,
	})
	expect(data.signupsByWeek).toHaveLength(12)
	expect(data.signupsByWeek.at(-1)).toEqual({
		weekStart: '2026-07-06',
		signups: 2,
		cumulativeUsers: 8,
	})
	expect(data.usageByMonth).toHaveLength(12)
	expect(data.usageByMonth.at(-1)?.events.execute).toBe(12)
	expect(data.emailByDay).toHaveLength(28)
	expect(data.emailByDay.at(-1)).toEqual({
		day: '2026-07-08',
		sends: 0,
		receives: 0,
	})
	expect(data.emailDeliveryByDay).toHaveLength(28)
	expect(data.emailDeliveryByDay.at(-1)).toEqual({
		day: '2026-07-08',
		delivered: 0,
		deferred: 0,
		bounced: 0,
		failed: 0,
		rejected: 0,
		complained: 0,
	})
	expect(data.authByDay.at(-1)?.success).toBe(4)
	expect(data.authByCategory).toEqual([{ category: 'auth', count: 4 }])
	expect(data.authHeatmap).toEqual([{ weekday: 3, hour: 9, count: 4 }])
	expect(data.plans).toEqual([
		{ plan: 'pro', count: 2 },
		{ plan: 'free', count: 6 },
	])
	expect(
		loaded.db.seenQueries
			.map(normalizeQuery)
			.filter((query) => query.includes('from orgs')),
	).toEqual([
		'select plan as plan, count(*) as n from orgs where deleted_at is null group by plan order by n desc',
	])
	expect(data.workflowStatuses).toEqual([
		{ status: 'complete', count: 8 },
		{ status: 'errored', count: 1 },
	])
	expect(data.jobHealth).toEqual({
		totalJobs: 4,
		enabledJobs: 3,
		successRuns: 20,
		errorRuns: 2,
	})
	expect(
		loaded.db.seenQueries
			.map(normalizeQuery)
			.filter((query) => query.includes('from jobs')),
	).toEqual(['select count(*) as total, sum(enabled) as enabled from jobs'])
	expect(data.activation.steps).toEqual([
		{ step: 'signed_up', users: 8 },
		{ step: 'email_verified', users: 5 },
		{ step: 'agent_connected', users: 4 },
		{ step: 'package_forked', users: 3 },
		{ step: 'package_run_succeeded', users: 2 },
		{ step: 'package_activated', users: 1 },
	])
	expect(data.activation.forksByActor).toEqual({
		human: 2,
		agent: 1,
		unknown: 4,
	})
	expect(data.activation.medianHoursToActivation).toBe(36)
	expect(data.runLogCompleteness).toEqual({
		usersAttempted: 2,
		usersLoaded: 2,
		complete: true,
		snapshotUpdatedAt: '2026-07-08T11:00:00.000Z',
	})
	expect(data.dynamicWorkerCost).toEqual({
		uniqueWorkerDays: 0,
		estimatedGrossUsd: 0,
		usdPerUniqueDay: 0.002,
		includedPerAccountMonth: 1000,
		topConsumers: [],
		riskConsumers: [],
	})
	// No fleet error-rate snapshot yet.
	expect(data.packageErrorRate).toEqual({
		available: false,
		updatedAt: null,
		environment: null,
		day: null,
		hour: null,
		lastAlertAt: null,
		concentration: null,
	})
})

test('a missing RunLog snapshot zeros run-derived charts without failing the page', async () => {
	consoleWarn.mockImplementation(() => {})
	const data = await loadLocalInsights().data

	expect(data.ok).toBe(true)
	expect(data.totals.workflowRuns).toBe(0)
	expect(data.workflowStatuses).toEqual([])
	expect(data.jobHealth).toEqual({
		totalJobs: 4,
		enabledJobs: 3,
		successRuns: 0,
		errorRuns: 0,
	})
	expect(data.activation.steps).toEqual([
		{ step: 'signed_up', users: 8 },
		{ step: 'email_verified', users: 5 },
		{ step: 'agent_connected', users: 4 },
		{ step: 'package_forked', users: 3 },
		{ step: 'package_run_succeeded', users: 0 },
		{ step: 'package_activated', users: 0 },
	])
	expect(data.activation.medianHoursToActivation).toBeNull()
	expect(data.activation.forksByActor).toEqual({
		human: 2,
		agent: 1,
		unknown: 4,
	})
	expect(data.runLogCompleteness).toEqual({
		usersAttempted: 0,
		usersLoaded: 0,
		complete: false,
		snapshotUpdatedAt: null,
	})

	// Present snapshots report their own completeness through the JSON
	// payload, including an empty snapshot that finished.
	const cases: Array<
		[Partial<AggregatedRunLogInsights>, number, number, boolean]
	> = [
		[{}, 0, 0, true],
		[{ usersAttempted: 2, usersLoaded: 1, complete: false }, 2, 1, false],
	]
	for (const [overrides, usersAttempted, usersLoaded, complete] of cases) {
		const loaded = await loadLocalInsights({
			BUNDLE_ARTIFACTS_KV: createMemoryKv(runLogSnapshot(overrides)),
		}).data
		expect(JSON.parse(JSON.stringify(loaded)).runLogCompleteness).toEqual({
			usersAttempted,
			usersLoaded,
			complete,
			snapshotUpdatedAt: '2026-07-08T11:00:00.000Z',
		})
	}
})

test('admin insights reads email reporting from Analytics Engine and degrades when it is unavailable', async () => {
	const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
		Response.json({
			data: [
				{ day: '2026-07-08', event_type: 'email_send', outcome: '', n: '7' },
				{ day: '2026-07-08', event_type: 'email_receive', outcome: '', n: 4 },
				{
					day: '2026-07-08',
					event_type: 'email_delivery',
					outcome: 'delivered',
					n: '6',
				},
			],
		}),
	)
	const env = createPartialEnv({
		APP_DB: createInsightsTestDb(),
		EMAIL_EVENTS: {} as AnalyticsEngineDataset,
		CLOUDFLARE_ACCOUNT_ID: 'account-1',
		CLOUDFLARE_API_TOKEN: 'token-1',
		SENTRY_ENVIRONMENT: 'preview',
	})
	env.AUDIT_DB = env.APP_DB

	const data = await loadAdminInsightsData(env, now)
	expect(data.emailByDay.at(-1)).toEqual({
		day: '2026-07-08',
		sends: 7,
		receives: 4,
	})
	expect(data.emailDeliveryByDay.at(-1)).toMatchObject({ delivered: 6 })
	expect(fetchSpy).toHaveBeenCalledTimes(1)
	const request = fetchSpy.mock.calls[0]
	expect(request?.[0]).toBe(
		'https://api.cloudflare.com/client/v4/accounts/account-1/analytics_engine/sql',
	)
	expect(String(request?.[1]?.body)).toContain('FROM kody_email_events_preview')
	expect(String(request?.[1]?.body)).toContain('sum(_sample_interval)')

	consoleWarn.mockImplementation(() => {})
	fetchSpy.mockResolvedValueOnce(new Response('query failed', { status: 400 }))
	const degraded = await loadAdminInsightsData(env, now)
	expect(degraded.ok).toBe(true)
	expect(degraded.emailByDay.filter((day) => day.sends !== 0)).toEqual([])
	expect(degraded.emailDeliveryByDay.filter((day) => day.failed !== 0)).toEqual(
		[],
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-insights-email-analytics-unavailable',
		{ error: expect.any(Error) },
	)
	fetchSpy.mockRestore()
})

/**
 * Regression for KODY-94: after migration 0100 dropped `users.plan`, the
 * plan-breakdown query must read `orgs.plan` against the real migrated
 * schema (mocked D1 cannot catch dropped-column SQL).
 */
