import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	adminFleetErrorRateMaxDays,
	buildAdminFleetErrorRateDailyFailedRunByErrorNameQuery,
	buildAdminFleetErrorRateDailyOutcomeQuery,
	buildAdminFleetErrorRateDailyStaticCallByErrorNameQuery,
	buildAdminFleetErrorRateDailyUsersQuery,
	foldAdminFleetErrorRateDailyErrorNameRows,
	foldAdminFleetErrorRateDailyRows,
	loadAdminFleetErrorRateData,
	resolveAdminFleetErrorRateWindow,
	toAdminInsightsPackageErrorRate,
	usersWithErrorsForFilteredDay,
} from './fleet-error-rate-data.ts'

const queryMocks = vi.hoisted(() => ({
	queryAnalyticsEngineSql: vi.fn(),
}))

vi.mock('#worker/usage/aggregate-rollups.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#worker/usage/aggregate-rollups.ts')>()
	return {
		...actual,
		queryAnalyticsEngineSql: (...args: Array<unknown>) =>
			queryMocks.queryAnalyticsEngineSql(...args),
	}
})

const sampleSnapshot = {
	version: 1 as const,
	updatedAt: '2026-10-20T12:00:00.000Z',
	environment: 'production',
	day: {
		kind: 'day' as const,
		recent: {
			start: '2026-10-19T12:00:00.000Z',
			end: '2026-10-20T12:00:00.000Z',
			combined: { events: 100, errors: 5, rate: 0.05 },
			by_metric: [
				{
					metric: 'package_export' as const,
					events: 100,
					errors: 5,
					rate: 0.05,
				},
				{
					metric: 'package_static_call' as const,
					events: 0,
					errors: 0,
					rate: null,
				},
				{ metric: 'job_run' as const, events: 0, errors: 0, rate: null },
				{
					metric: 'workflow_run' as const,
					events: 0,
					errors: 0,
					rate: null,
				},
			],
		},
		previous: {
			start: '2026-10-18T12:00:00.000Z',
			end: '2026-10-19T12:00:00.000Z',
			combined: { events: 80, errors: 2, rate: 0.025 },
			by_metric: [
				{
					metric: 'package_export' as const,
					events: 80,
					errors: 2,
					rate: 0.025,
				},
				{
					metric: 'package_static_call' as const,
					events: 0,
					errors: 0,
					rate: null,
				},
				{ metric: 'job_run' as const, events: 0, errors: 0, rate: null },
				{
					metric: 'workflow_run' as const,
					events: 0,
					errors: 0,
					rate: null,
				},
			],
		},
	},
	hour: {
		kind: 'hour' as const,
		recent: {
			start: '2026-10-20T11:00:00.000Z',
			end: '2026-10-20T12:00:00.000Z',
			combined: { events: 10, errors: 1, rate: 0.1 },
			by_metric: [
				{
					metric: 'package_export' as const,
					events: 10,
					errors: 1,
					rate: 0.1,
				},
				{
					metric: 'package_static_call' as const,
					events: 0,
					errors: 0,
					rate: null,
				},
				{ metric: 'job_run' as const, events: 0, errors: 0, rate: null },
				{
					metric: 'workflow_run' as const,
					events: 0,
					errors: 0,
					rate: null,
				},
			],
		},
		previous: {
			start: '2026-10-20T10:00:00.000Z',
			end: '2026-10-20T11:00:00.000Z',
			combined: { events: 10, errors: 0, rate: 0 },
			by_metric: [
				{
					metric: 'package_export' as const,
					events: 10,
					errors: 0,
					rate: 0,
				},
				{
					metric: 'package_static_call' as const,
					events: 0,
					errors: 0,
					rate: null,
				},
				{ metric: 'job_run' as const, events: 0, errors: 0, rate: null },
				{
					metric: 'workflow_run' as const,
					events: 0,
					errors: 0,
					rate: null,
				},
			],
		},
	},
	lastAlertAt: null,
	lastAlertEventId: null,
	concentration: null,
}

test('toAdminInsightsPackageErrorRate mirrors insights availability', () => {
	expect(toAdminInsightsPackageErrorRate(null)).toEqual({
		available: false,
		updatedAt: null,
		environment: null,
		day: null,
		hour: null,
		lastAlertAt: null,
		concentration: null,
	})
	expect(toAdminInsightsPackageErrorRate(sampleSnapshot)).toEqual({
		available: true,
		updatedAt: sampleSnapshot.updatedAt,
		environment: 'production',
		day: sampleSnapshot.day,
		hour: sampleSnapshot.hour,
		lastAlertAt: null,
		concentration: null,
	})
})

test('window clamps days and ends on today inclusive', () => {
	const now = new Date('2026-10-20T15:30:00.000Z')
	expect(resolveAdminFleetErrorRateWindow({ days: 7, now })).toEqual({
		days: 7,
		startDay: '2026-10-14',
		endDay: '2026-10-20',
		nextDay: '2026-10-21',
	})
	expect(resolveAdminFleetErrorRateWindow({ days: 0, now }).days).toBe(1)
	expect(
		resolveAdminFleetErrorRateWindow({
			days: adminFleetErrorRateMaxDays + 10,
			now,
		}).days,
	).toBe(adminFleetErrorRateMaxDays)
})

test('daily AE queries count caught and error and exclude handles', () => {
	const outcome = buildAdminFleetErrorRateDailyOutcomeQuery({
		dataset: 'kody_usage_events',
		startDay: '2026-10-14',
		nextDay: '2026-10-21',
	})
	expect(outcome).toContain("blob4 = 'error'")
	expect(outcome).toContain("blob4 = 'caught'")
	expect(outcome).toContain(
		"blob2 IN ('package_export', 'package_static_call', 'job_run', 'workflow_run')",
	)
	expect(outcome).not.toContain('username')
	expect(outcome).not.toContain('blob10')

	const users = buildAdminFleetErrorRateDailyUsersQuery({
		dataset: 'kody_usage_events',
		startDay: '2026-10-14',
		nextDay: '2026-10-21',
	})
	expect(users).toContain("blob4 = 'error'")
	expect(users).toContain('count(DISTINCT blob1)')
	expect(users).not.toContain('blob1 IN')
	expect(users).not.toContain('caught')
	expect(users).not.toContain('username')

	const failedRuns = buildAdminFleetErrorRateDailyFailedRunByErrorNameQuery({
		dataset: 'kody_usage_events',
		startDay: '2026-10-14',
		nextDay: '2026-10-21',
	})
	expect(failedRuns).toContain('blob13 AS error_name')
	expect(failedRuns).toContain(
		"blob2 IN ('package_export', 'job_run', 'workflow_run')",
	)
	expect(failedRuns).not.toContain('package_static_call')
	expect(failedRuns).not.toContain('username')

	const staticCalls = buildAdminFleetErrorRateDailyStaticCallByErrorNameQuery({
		dataset: 'kody_usage_events',
		startDay: '2026-10-14',
		nextDay: '2026-10-21',
	})
	expect(staticCalls).toContain("blob2 = 'package_static_call'")
	expect(staticCalls).toContain('blob13 AS error_name')
	expect(staticCalls).not.toContain('username')
})

test('fold error-name rows keeps aggregates without handles', () => {
	expect(
		foldAdminFleetErrorRateDailyErrorNameRows(
			[
				{
					day: '2026-10-18',
					error_name: 'credential_need_undeclared',
					error_count: 12,
				},
				{ day: '2026-10-18', error_name: '', error_count: 3 },
				{ day: '2026-10-17', error_name: 'TimeoutError', error_count: '1' },
			],
			{ startDay: '2026-10-18', endDay: '2026-10-18' },
		),
	).toEqual([
		{
			day: '2026-10-18',
			errorName: 'credential_need_undeclared',
			count: 12,
		},
		{ day: '2026-10-18', errorName: '', count: 3 },
	])
})

test('fold fills every day and merges outcome with distinct users', () => {
	const daily = foldAdminFleetErrorRateDailyRows({
		outcomeRows: [
			{ day: '2026-10-18', error_count: 4, caught_count: 9 },
			{ day: '2026-10-20', error_count: '2', caught_count: '1' },
		],
		userRows: [
			{ day: '2026-10-18', users_with_errors: 3 },
			{ day: '2026-10-19', users_with_errors: 1 },
		],
		startDay: '2026-10-18',
		endDay: '2026-10-20',
	})
	expect(daily).toEqual([
		{
			day: '2026-10-18',
			errorCount: 4,
			caughtCount: 9,
			usersWithErrors: 3,
		},
		{
			day: '2026-10-19',
			errorCount: 0,
			caughtCount: 0,
			usersWithErrors: 1,
		},
		{
			day: '2026-10-20',
			errorCount: 2,
			caughtCount: 1,
			usersWithErrors: 0,
		},
	])
})

test('loadAdminFleetErrorRateData reuses snapshot and returns daily aggregates', async () => {
	const kv = {
		get: vi.fn(async () => sampleSnapshot),
	}
	queryMocks.queryAnalyticsEngineSql.mockImplementation(
		async (input: { query: string }) => {
			if (input.query.includes('caught_count')) {
				return [{ day: '2026-10-20', error_count: 5, caught_count: 12 }]
			}
			if (input.query.includes('users_with_errors')) {
				return [{ day: '2026-10-20', users_with_errors: 2 }]
			}
			if (input.query.includes("blob2 = 'package_static_call'")) {
				return [
					{
						day: '2026-10-20',
						error_name: 'credential_need_undeclared',
						error_count: 40,
					},
				]
			}
			if (input.query.includes('blob13 AS error_name')) {
				return [
					{
						day: '2026-10-20',
						error_name: 'credential_need_undeclared',
						error_count: 7,
					},
					{ day: '2026-10-20', error_name: '', error_count: 1 },
				]
			}
			return []
		},
	)

	const data = await loadAdminFleetErrorRateData({
		env: {
			BUNDLE_ARTIFACTS_KV: kv as unknown as KVNamespace,
			USAGE_EVENTS: {} as AnalyticsEngineDataset,
			CLOUDFLARE_ACCOUNT_ID: 'acct',
			CLOUDFLARE_API_TOKEN: 'token',
			SENTRY_ENVIRONMENT: 'production',
		},
		days: 2,
		now: new Date('2026-10-20T12:00:00.000Z'),
	})

	expect(data.snapshot.available).toBe(true)
	expect(data.snapshot.day?.recent.combined).toEqual({
		events: 100,
		errors: 5,
		rate: 0.05,
	})
	expect(data.days).toBe(2)
	expect(data.startDay).toBe('2026-10-19')
	expect(data.endDay).toBe('2026-10-20')
	expect(data.dailyAvailable).toBe(true)
	expect(data.filter).toBeNull()
	expect(data.daily).toEqual([
		{
			day: '2026-10-19',
			errorCount: 0,
			caughtCount: 0,
			usersWithErrors: 0,
		},
		{
			day: '2026-10-20',
			errorCount: 5,
			caughtCount: 12,
			usersWithErrors: 2,
		},
	])
	expect(data.byErrorName.available).toBe(true)
	expect(data.byErrorName.failedRuns).toEqual([
		{
			day: '2026-10-20',
			errorName: 'credential_need_undeclared',
			count: 7,
		},
		{ day: '2026-10-20', errorName: '', count: 1 },
	])
	expect(data.byErrorName.staticCalls).toEqual([
		{
			day: '2026-10-20',
			errorName: 'credential_need_undeclared',
			count: 40,
		},
	])
	expect(JSON.stringify(data.daily)).not.toMatch(/@[a-z]|username|handle/i)
	expect(JSON.stringify(data.byErrorName)).not.toMatch(
		/@[a-z]|username|handle/i,
	)
})

test('loadAdminFleetErrorRateData filters by billing owner without listing handles', async () => {
	const personId = 'a'.repeat(64)
	const orgId = 'b'.repeat(64)
	const db = {
		prepare() {
			const statement = {
				bind() {
					return statement
				},
				async first() {
					return {
						personal_org_id: orgId,
						stable_user_id: personId,
					}
				},
			}
			return statement
		},
	}
	queryMocks.queryAnalyticsEngineSql.mockImplementation(
		async (input: { query: string }) => {
			expect(input.query).toContain(`blob1 IN ('${personId}', '${orgId}')`)
			expect(input.query).not.toContain('users_with_errors')
			if (input.query.includes('caught_count')) {
				return [{ day: '2026-10-20', error_count: 1, caught_count: 3 }]
			}
			if (input.query.includes('blob13 AS error_name')) {
				return [
					{
						day: '2026-10-20',
						error_name: 'credential_need_undeclared',
						error_count: 1,
					},
				]
			}
			return []
		},
	)

	const data = await loadAdminFleetErrorRateData({
		env: {
			APP_DB: db as unknown as D1Database,
			USAGE_EVENTS: {} as AnalyticsEngineDataset,
			CLOUDFLARE_ACCOUNT_ID: 'acct',
			CLOUDFLARE_API_TOKEN: 'token',
		},
		days: 1,
		stableUserId: personId,
		now: new Date('2026-10-20T12:00:00.000Z'),
	})

	expect(data.filter).toEqual({ stableUserId: personId })
	// Outcome + failed-run by name + static-call by name (no users query).
	expect(queryMocks.queryAnalyticsEngineSql).toHaveBeenCalledTimes(3)
	expect(data.daily).toEqual([
		{
			day: '2026-10-20',
			errorCount: 1,
			caughtCount: 3,
			// One account filter: never inflate to 2 from person+org blob1s.
			usersWithErrors: 1,
		},
	])
	expect(data.byErrorName.available).toBe(true)
	expect(data).not.toHaveProperty('username')
	expect(JSON.stringify(data)).not.toMatch(/@[a-z]/i)
})

test('filtered usersWithErrors is 0 or 1 even when outcomes span two billing ids', () => {
	expect(usersWithErrorsForFilteredDay(0)).toBe(0)
	expect(usersWithErrorsForFilteredDay(7)).toBe(1)
})

test('loadAdminFleetErrorRateData degrades when AE is unavailable', async () => {
	consoleWarn.mockImplementation(() => {})
	const data = await loadAdminFleetErrorRateData({
		env: {},
		days: 1,
		now: new Date('2026-10-20T12:00:00.000Z'),
	})
	expect(data.snapshot.available).toBe(false)
	expect(data.dailyAvailable).toBe(false)
	expect(data.byErrorName).toEqual({
		available: false,
		failedRuns: [],
		staticCalls: [],
	})
	expect(data.daily).toEqual([
		{
			day: '2026-10-20',
			errorCount: 0,
			caughtCount: 0,
			usersWithErrors: 0,
		},
	])
})
