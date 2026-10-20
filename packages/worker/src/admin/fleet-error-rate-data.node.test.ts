import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	adminFleetErrorRateDefaultDays,
	adminFleetErrorRateMaxDays,
	buildAdminFleetErrorRateDailyOutcomeQuery,
	buildAdminFleetErrorRateDailyUsersQuery,
	foldAdminFleetErrorRateDailyRows,
	loadAdminFleetErrorRateData,
	resolveAdminFleetErrorRateWindow,
	toAdminInsightsPackageErrorRate,
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
	expect(adminFleetErrorRateDefaultDays).toBe(7)
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
		billingOwnerIds: ['abc123', 'org-xyz'],
	})
	expect(users).toContain("blob4 = 'error'")
	expect(users).toContain('count(DISTINCT blob1)')
	expect(users).toContain("blob1 IN ('abc123', 'org-xyz')")
	expect(users).not.toContain('caught')
	expect(users).not.toContain('username')
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
			return [{ day: '2026-10-20', users_with_errors: 2 }]
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
	expect(JSON.stringify(data.daily)).not.toMatch(/@[a-z]|username|handle/i)
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
			if (input.query.includes('caught_count')) {
				return [{ day: '2026-10-20', error_count: 1, caught_count: 3 }]
			}
			return [{ day: '2026-10-20', users_with_errors: 1 }]
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
	expect(data.daily).toEqual([
		{
			day: '2026-10-20',
			errorCount: 1,
			caughtCount: 3,
			usersWithErrors: 1,
		},
	])
	expect(data).not.toHaveProperty('username')
	expect(JSON.stringify(data)).not.toMatch(/@[a-z]/i)
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
	expect(data.daily).toEqual([
		{
			day: '2026-10-20',
			errorCount: 0,
			caughtCount: 0,
			usersWithErrors: 0,
		},
	])
})
