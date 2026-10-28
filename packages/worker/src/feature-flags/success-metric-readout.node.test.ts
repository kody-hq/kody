import { expect, test, vi } from 'vitest'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'
import { type FeatureFlagSuccessMetric } from '#universal/feature-flags/registry.ts'
import {
	attachFeatureFlagMetricReadouts,
	loadFeatureFlagSuccessMetricReadout,
} from './success-metric-readout.ts'
import { type AdminFeatureFlag } from '#universal/feature-flags/types.ts'

const successMetric: FeatureFlagSuccessMetric = {
	eventType: 'execute',
	measure: 'error_rate',
	goal: 'decrease',
	hypothesis: 'Fewer execute errors.',
}

const now = new Date('2026-07-15T12:00:00.000Z')

type ExposureRow = {
	user_id: string
	enabled: number
	source: string
	last_day: string
	last_updated: string | null
}
type UsageRow = {
	user_id: string
	event_count: number
	error_count: number
	total_duration_ms: number
}

function createReadoutTestDb(input: {
	exposures: Array<ExposureRow>
	usage: Array<UsageRow>
}) {
	const queries: Array<{ query: string; params: Array<unknown> }> = []
	const db = {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async all() {
							queries.push({ query, params })
							if (query.includes('feature_flag_exposure_rollups')) {
								return { results: input.exposures }
							}
							if (query.includes('usage_rollups')) {
								return { results: input.usage }
							}
							throw new Error(`Unsupported query: ${query}`)
						},
					}
				},
			}
		},
	}
	return { db: db as unknown as D1Database, queries }
}

type ReadoutEnv = Parameters<typeof loadFeatureFlagSuccessMetricReadout>[0]

const load = (env: ReadoutEnv) =>
	loadFeatureFlagSuccessMetricReadout(
		env,
		{ flagKey: 'metric-test-flag', successMetric },
		now,
	)

const analyticsEnv = {
	APP_DB: {} as D1Database,
	FLAG_EXPOSURES: {} as AnalyticsEngineDataset,
	CLOUDFLARE_ACCOUNT_ID: 'account',
	CLOUDFLARE_API_TOKEN: 'token',
}

const exposure = (
	user_id: string,
	enabled: number,
	source: string,
	last_day: string,
): ExposureRow => ({
	user_id,
	enabled,
	source,
	last_day,
	last_updated: `${last_day}T00:00:00.000Z`,
})

const usageRow = (
	user_id: string,
	event_count: number,
	error_count: number,
	total_duration_ms: number,
): UsageRow => ({ user_id, event_count, error_count, total_duration_ms })

function stubFetch(handler: (query: string) => Response) {
	const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) =>
		handler(String(init?.body)),
	)
	vi.stubGlobal('fetch', fetchMock)
	return Object.assign(fetchMock, {
		[Symbol.dispose]: () => vi.unstubAllGlobals(),
	})
}

test('D1 readout excludes mixed users from on/off and surfaces override usage', async () => {
	const { db, queries } = createReadoutTestDb({
		exposures: [
			exposure('user-on', 1, 'rollout', '2026-07-10'),
			exposure('user-on-quiet', 1, 'rollout', '2026-07-10'),
			exposure('user-off', 0, 'rollout', '2026-07-10'),
			exposure('user-override', 1, 'override', '2026-07-12'),
			exposure('user-mixed', 0, 'rollout', '2026-07-05'),
			exposure('user-mixed', 1, 'rollout', '2026-07-12'),
		],
		usage: [
			usageRow('user-on', 10, 2, 1000),
			usageRow('user-off', 8, 4, 400),
			usageRow('user-override', 100, 0, 0),
			usageRow('user-mixed', 20, 1, 200),
			usageRow('user-unexposed', 50, 50, 0),
		],
	})

	expect(await load({ APP_DB: db })).toEqual({
		status: 'ok',
		windowStart: '2026-07-01T00:00:00.000Z',
		windowEnd: '2026-07-15T12:00:00.000Z',
		on: {
			users: 2,
			eventCount: 10,
			errorCount: 2,
			errorRate: 0.2,
			avgDurationMs: 100,
		},
		off: {
			users: 1,
			eventCount: 8,
			errorCount: 4,
			errorRate: 0.5,
			avgDurationMs: 50,
		},
		override: {
			users: 1,
			eventCount: 100,
			errorCount: 0,
			errorRate: 0,
			avgDurationMs: 0,
		},
		orgOverride: {
			users: 0,
			eventCount: 0,
			errorCount: 0,
			errorRate: null,
			avgDurationMs: null,
		},
		overrideUsers: 1,
		orgOverrideUsers: 0,
		mixedUsers: 1,
	})
	expect(queries.map((entry) => entry.params)).toEqual([
		['metric-test-flag', '2026-07-01', '2026-07-15'],
		['execute', '2026-07'],
	])
})

test('Analytics Engine readout joins exposures and usage; mixed stay excluded', async () => {
	const aeExposure = (
		user_id: string,
		state: string,
		source: string,
		day: string,
	) => ({ user_id, state, source, last_ts: `${day} 00:00:00` })
	using fetchMock = stubFetch((query) =>
		Response.json({
			data: query.includes('kody_flag_exposures')
				? [
						aeExposure('user-on', 'on', 'global', '2026-07-10'),
						aeExposure('user-off', 'off', 'global', '2026-07-10'),
						aeExposure('user-override', 'on', 'override', '2026-07-12'),
						aeExposure('user-switched', 'off', 'global', '2026-07-02'),
						aeExposure('user-switched', 'on', 'global', '2026-07-14'),
					]
				: [
						usageRow('user-on', 4, 1, 800),
						usageRow('user-off', 5, 5, 500),
						usageRow('user-switched', 6, 0, 60),
						usageRow('user-override', 50, 0, 0),
					],
		}),
	)

	const readout = await load(analyticsEnv)

	expect(fetchMock).toHaveBeenCalledTimes(2)
	const exposuresQuery = fetchMock.mock.calls
		.map(([, init]) => String(init?.body))
		.find((query) => query.includes('kody_flag_exposures'))
	// Analytics Engine rejects max() over String columns with HTTP 422.
	expect(exposuresQuery).toContain('max(timestamp) AS last_ts')
	expect(exposuresQuery).not.toMatch(/max\(blob\d+\)/)
	expect(readout).toMatchObject({
		status: 'ok',
		on: { users: 1, eventCount: 4, errorCount: 1 },
		off: { users: 1, eventCount: 5, errorCount: 5, errorRate: 1 },
		override: { users: 1, eventCount: 50, errorCount: 0 },
		overrideUsers: 1,
		mixedUsers: 1,
	})
})

test('selects D1 locally, stays unavailable without credentials, and degrades on failure', async () => {
	const local = createReadoutTestDb({ exposures: [], usage: [] })
	await expect(
		load({ ...analyticsEnv, APP_DB: local.db, WRANGLER_IS_LOCAL_DEV: 'true' }),
	).resolves.toMatchObject({ status: 'ok' })
	expect(local.queries).toHaveLength(2)

	// Falling back to empty D1 tables would present confident zero cohorts
	// even though exposures were written to Analytics Engine.
	const missingCredentials = createReadoutTestDb({ exposures: [], usage: [] })
	await expect(
		load({
			APP_DB: missingCredentials.db,
			FLAG_EXPOSURES: {} as AnalyticsEngineDataset,
		}),
	).resolves.toEqual({
		status: 'unavailable',
		reason: expect.stringContaining('credentials'),
	})
	expect(missingCredentials.queries).toHaveLength(0)

	silenceExpectedConsoleWarns(['flag-metric-readout-failed'])
	const failingDb = {
		prepare() {
			throw new Error('d1 down')
		},
	} as unknown as D1Database
	await expect(load({ APP_DB: failingDb })).resolves.toEqual({
		status: 'unavailable',
		reason: expect.stringContaining('failed'),
	})

	const aeError =
		'Input was invalid: cannot use the String type as argument 1 in max("blob5")'
	using _fetch = stubFetch(() => new Response(aeError, { status: 422 }))
	await expect(load(analyticsEnv)).resolves.toEqual({
		status: 'unavailable',
		reason: expect.stringContaining(`(422): ${aeError}`),
	})
})

test('attachFeatureFlagMetricReadouts only fills measured non-stale flags', async () => {
	const { db } = createReadoutTestDb({ exposures: [], usage: [] })
	const flag = (overrides: Partial<AdminFeatureFlag>): AdminFeatureFlag => ({
		key: 'demo-indicator',
		description: null,
		defaultEnabled: false,
		defaultAudience: 'everyone',
		stale: false,
		successMetric: null,
		global: null,
		overrides: [],
		orgOverrides: [],
		...overrides,
	})
	const flags = [
		flag({ successMetric }),
		flag({}),
		flag({
			key: 'retired-flag',
			defaultEnabled: null,
			defaultAudience: null,
			stale: true,
		}),
	]
	await attachFeatureFlagMetricReadouts({ APP_DB: db }, flags, now)
	expect(flags.map((entry) => entry.metricReadout)).toEqual([
		expect.objectContaining({ status: 'ok' }),
		undefined,
		undefined,
	])
})
