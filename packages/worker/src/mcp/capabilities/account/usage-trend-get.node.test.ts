import {
	personIdFromStored,
	ownerIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { utcDayKey, utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { userMeterDailyCounterRetentionDays } from '#worker/entitlements/user-meter-do.ts'
import {
	readAccountUsageTrend,
	usageTrendMonthHistoryMonths,
} from '#worker/entitlements/usage-trend.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryRepoSessionIndexEnv } from '#worker/test-support/repo-session-index.ts'
import { createInMemoryRunLogUsageEnv } from '#worker/test-support/run-log-usage.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { usageTrendGetCapability } from './usage-trend-get.ts'

const email = 'usage-trend-get@example.com'

function createTrendEnv() {
	const stableUserId = testStableUserIdFromEmail(email)
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	applyAllMigrations(
		sqlite,
		new URL('../../../../../jobs-worker/migrations/', import.meta.url),
	)
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			 VALUES ('usage-trend', ?, 'hash', ?)`,
		)
		.run(email, stableUserId)
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
			 VALUES (?, 'usage-trend', 'pro', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
		)
		.run(stableUserId)
	const db = createD1FromSqlite(sqlite)
	const userMeter = createInMemoryUserMeterEnv()
	return {
		stableUserId,
		sqlite,
		env: {
			APP_DB: db,
			...userMeter.env,
			...createInMemoryRunLogUsageEnv().env,
			REPO_SESSION_INDEX:
				createInMemoryRepoSessionIndexEnv(db).REPO_SESSION_INDEX,
		} as unknown as Env,
		userMeter,
	}
}

function callerContext(userId: string) {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://example.com',
		user: {
			userId: personIdFromStored(userId),
			email,
			displayName: 'Usage Trend',
		},
	})
}

function shiftUtcDays(base: Date, deltaDays: number) {
	const next = new Date(base)
	next.setUTCDate(next.getUTCDate() + deltaDays)
	return next
}

function meterStub(env: Env, userId: string) {
	return env.USER_METER.get(env.USER_METER.idFromName(userId)) as {
		claimDynamicWorkerDay: (input: {
			workerId: string
			day: string
			createdAt: string
		}) => Promise<{ created: boolean }>
		admitExecuteCall: (input: {
			nowMs: number
			limitPerMinute: number
		}) => Promise<unknown>
	}
}

test('usageTrendGet requires a signed-in user', async () => {
	const { env } = createTrendEnv()
	await expect(
		usageTrendGetCapability.handler(
			{},
			{
				env,
				callerContext: createMcpCallerContext({
					source: { kind: 'mcp-oauth' },
					baseUrl: 'https://example.com',
				}),
			},
		),
	).rejects.toThrow(/Authenticated MCP user/)
})

test('usageTrendGet returns a zero-filled retention window when empty', async () => {
	const { env, stableUserId } = createTrendEnv()
	const result = await usageTrendGetCapability.handler(
		{},
		{
			env,
			callerContext: callerContext(stableUserId),
		},
	)

	expect(result.retentionDays).toBe(userMeterDailyCounterRetentionDays)
	expect(result.days).toHaveLength(userMeterDailyCounterRetentionDays)
	expect(result.days.every((day) => day.execute === 0)).toBe(true)
	expect(result.days.every((day) => day.uniqueWorkerDays === 0)).toBe(true)
	expect(result.days.every((day) => day.jobRuns === undefined)).toBe(true)
	expect(
		result.days.every((day) => day.automationInvocations === undefined),
	).toBe(true)
	expect(result.months).toHaveLength(usageTrendMonthHistoryMonths)
	expect(result.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/)
	expect(result.days[0]!.day < result.days.at(-1)!.day).toBe(true)
})

async function admitExecuteCalls(
	env: Env,
	stableUserId: string,
	at: Date,
	calls: number,
) {
	const meter = meterStub(env, stableUserId)
	for (let index = 0; index < calls; index += 1) {
		await meter.admitExecuteCall({ nowMs: at.getTime(), limitPerMinute: 300 })
	}
}

test('usageTrendGet maps partial days and monthly rollups for the signed-in user', async () => {
	const now = new Date('2026-10-07T15:30:00.000Z')
	const today = utcDayKey(now)
	const yesterday = utcDayKey(shiftUtcDays(now, -1))
	const twoDaysAgo = utcDayKey(shiftUtcDays(now, -2))
	const { env, stableUserId, sqlite, userMeter } = createTrendEnv()

	await admitExecuteCalls(env, stableUserId, shiftUtcDays(now, -2), 4)
	await admitExecuteCalls(env, stableUserId, shiftUtcDays(now, -1), 11)
	// The unique-worker cap counter is not the execute call series.
	await userMeter.seed({
		userId: stableUserId,
		resource: 'execute_unique_workers_per_day',
		day: yesterday,
		count: 3,
	})
	await userMeter.seed({
		userId: stableUserId,
		resource: 'job_runs_per_day',
		day: yesterday,
		count: 2,
	})
	await userMeter.seed({
		userId: stableUserId,
		resource: 'automation_invocations_per_day',
		day: today,
		count: 3,
	})

	const meter = meterStub(env, stableUserId)
	await meter.claimDynamicWorkerDay({
		workerId: 'worker-a',
		day: yesterday,
		createdAt: now.toISOString(),
	})
	await meter.claimDynamicWorkerDay({
		workerId: 'worker-b',
		day: yesterday,
		createdAt: now.toISOString(),
	})
	await meter.claimDynamicWorkerDay({
		workerId: 'worker-a',
		day: today,
		createdAt: now.toISOString(),
	})

	const currentMonth = utcMonthKey(now)
	const priorMonth = utcMonthKey(
		new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
	)
	sqlite
		.prepare(
			`INSERT INTO usage_rollups (user_id, metric, month, event_count)
			 VALUES (?, 'execute', ?, 90),
			        (?, 'dynamic_worker_day', ?, 7),
			        (?, 'execute', ?, 40)`,
		)
		.run(
			stableUserId,
			currentMonth,
			stableUserId,
			currentMonth,
			stableUserId,
			priorMonth,
		)

	const trend = await readAccountUsageTrend({
		db: env.APP_DB,
		env,
		userId: ownerIdFromStored(stableUserId),
		now,
	})

	expect(trend.days).toHaveLength(userMeterDailyCounterRetentionDays)
	expect(trend.days.find((day) => day.day === twoDaysAgo)).toMatchObject({
		execute: 4,
	})
	expect(trend.days.find((day) => day.day === yesterday)).toMatchObject({
		execute: 11,
		uniqueWorkerDays: 2,
	})
	expect(trend.days.find((day) => day.day === today)).toMatchObject({
		execute: 0,
		uniqueWorkerDays: 1,
	})
	expect(trend.months.find((row) => row.month === priorMonth)).toMatchObject({
		execute: 40,
	})
	expect(trend.months.find((row) => row.month === currentMonth)).toMatchObject({
		execute: 90,
		uniqueWorkerDays: 7,
	})
	expect(trend.months.at(-1)?.month).toBe(currentMonth)

	// Capability path (wall clock): seed relative to today and assert shape.
	const liveNow = new Date()
	const liveToday = utcDayKey(liveNow)
	const liveYesterday = utcDayKey(shiftUtcDays(liveNow, -1))
	const liveEnv = createTrendEnv()
	await admitExecuteCalls(
		liveEnv.env,
		liveEnv.stableUserId,
		shiftUtcDays(liveNow, -1),
		5,
	)
	await admitExecuteCalls(liveEnv.env, liveEnv.stableUserId, liveNow, 8)
	await meterStub(liveEnv.env, liveEnv.stableUserId).claimDynamicWorkerDay({
		workerId: 'live-worker',
		day: liveToday,
		createdAt: liveNow.toISOString(),
	})

	const capabilityResult = await usageTrendGetCapability.handler(
		{},
		{
			env: liveEnv.env,
			callerContext: callerContext(liveEnv.stableUserId),
		},
	)
	expect(
		capabilityResult.days.find((day) => day.day === liveYesterday),
	).toMatchObject({
		execute: 5,
	})
	expect(
		capabilityResult.days.find((day) => day.day === liveToday),
	).toMatchObject({
		execute: 8,
		uniqueWorkerDays: 1,
	})
})

test('usageTrendGet on a team-bound connection reads the team org meter', async () => {
	const { env, stableUserId } = createTrendEnv()
	const teamOrgId = 'b'.repeat(64)
	const now = new Date()
	await admitExecuteCalls(env, stableUserId, now, 2)
	await admitExecuteCalls(env, teamOrgId, now, 6)

	const result = await usageTrendGetCapability.handler(
		{},
		{
			env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://example.com',
				user: {
					userId: personIdFromStored(stableUserId),
					email,
					displayName: 'Usage Trend',
				},
				orgBinding: {
					org: { id: ownerIdFromStored(teamOrgId), slug: 'usage-trend-team' },
					role: 'owner',
				},
			}),
		},
	)
	expect(result.days.find((day) => day.day === utcDayKey(now))?.execute).toBe(6)
})
