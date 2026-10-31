import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	buildRepoPushQueueCostQuery,
	foldRepoPushQueueCostRows,
	loadRepoPushQueueCost,
} from './repo-push-queue-cost-data.ts'

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

const now = new Date('2026-10-28T12:00:00.000Z')

function analyticsRow(
	path: string,
	errorName: string,
	pushes: number,
	extra: Partial<Record<string, number>> = {},
) {
	return {
		path,
		error_name: errorName,
		pushes,
		wall_ms: 0,
		max_wall_ms: 0,
		wait_ms: 0,
		max_wait_ms: 0,
		depth_sum: 0,
		max_depth: 0,
		attempts_sum: pushes,
		retried: 0,
		...extra,
	}
}

function migratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('the Analytics Engine query reads only git_push points in the window', () => {
	const query = buildRepoPushQueueCostQuery({
		dataset: 'kody_usage_events',
		startDay: '2026-10-22',
		nextDay: '2026-10-29',
	})
	expect(query).toContain("blob2 = 'git_push'")
	expect(query).toContain("toDateTime('2026-10-22 00:00:00')")
	expect(query).toContain("toDateTime('2026-10-29 00:00:00')")
	expect(query).toContain('GROUP BY blob3, blob13')
	expect(query).not.toMatch(/blob1\b/)
})

test('folds rows into per-path outcomes, rates, and cost numbers', () => {
	const folded = foldRepoPushQueueCostRows([
		analyticsRow('queued', '', 8, {
			wall_ms: 16_000,
			max_wall_ms: 5_000,
			wait_ms: 4_000,
			max_wait_ms: 2_500,
			depth_sum: 12,
			max_depth: 4,
			attempts_sum: 10,
			retried: 2,
		}),
		analyticsRow('queued', 'timeout', 1, {
			wall_ms: 90_000,
			max_wall_ms: 90_000,
			depth_sum: 6,
			max_depth: 6,
		}),
		analyticsRow('queued', 'busy', 1, { depth_sum: 64, max_depth: 64 }),
		analyticsRow('direct', '', 3, { wall_ms: 3_000, max_wall_ms: 1_500 }),
		analyticsRow('direct', 'busy', 1, { wall_ms: 45_000, max_wall_ms: 45_000 }),
		analyticsRow('direct', 'upstream_5xx', 2),
		analyticsRow('other', '', 99),
	])
	const queued = folded.paths.find((row) => row.path === 'queued')!
	expect(queued).toMatchObject({
		pushes: 10,
		ok: 8,
		busy: 1,
		timeout: 1,
		error: 0,
		failureRate: 0.2,
		busyOrTimeoutRate: 0.2,
		avgWallMs: 10_600,
		maxWallMs: 90_000,
		totalWallSeconds: 106,
		avgWaitMs: 400,
		maxWaitMs: 2_500,
		avgQueueDepth: 8.2,
		maxQueueDepth: 64,
		retriedPushes: 2,
	})
	const direct = folded.paths.find((row) => row.path === 'direct')!
	expect(direct).toMatchObject({
		pushes: 6,
		ok: 3,
		busy: 1,
		error: 2,
		failureRate: 0.5,
		busyOrTimeoutRate: 1 / 6,
		avgQueueDepth: 0,
	})
	expect(folded.errors).toEqual([
		{ path: 'direct', errorName: 'upstream_5xx', outcome: 'error', pushes: 2 },
		{ path: 'queued', errorName: 'timeout', outcome: 'timeout', pushes: 1 },
		{ path: 'queued', errorName: 'busy', outcome: 'busy', pushes: 1 },
		{ path: 'direct', errorName: 'busy', outcome: 'busy', pushes: 1 },
	])
})

test('local dev reports the D1 month rollup and no per-path breakdown', async () => {
	const { sqlite, db } = migratedDb()
	sqlite.exec(`
		INSERT INTO usage_rollups (user_id, metric, month, event_count, error_count, total_duration_ms)
		VALUES
			('owner-a', 'git_push', '2026-10', 3, 1, 9000),
			('owner-b', 'git_push', '2026-10', 1, 0, 1000),
			('owner-b', 'execute', '2026-10', 50, 5, 1);
	`)
	const result = await loadRepoPushQueueCost({
		env: { APP_DB: db, WRANGLER_IS_LOCAL_DEV: 'true' },
		now,
	})
	expect(result.available).toBe(false)
	expect(result.reason).toMatch(/local dev/)
	expect(result.paths.map((row) => row.pushes)).toEqual([0, 0])
	expect(result.monthRollup).toEqual({
		month: '2026-10',
		pushes: 4,
		errors: 1,
		failureRate: 0.25,
		avgWallMs: 2500,
	})
	expect(queryMocks.queryAnalyticsEngineSql).not.toHaveBeenCalled()
})

test('production reads Analytics Engine and degrades on query failure', async () => {
	const { db } = migratedDb()
	const env = {
		APP_DB: db,
		USAGE_EVENTS: {} as AnalyticsEngineDataset,
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token',
		SENTRY_ENVIRONMENT: 'preview',
	}
	queryMocks.queryAnalyticsEngineSql.mockResolvedValueOnce([
		analyticsRow('queued', '', 2, { wall_ms: 400 }),
	])
	const ok = await loadRepoPushQueueCost({ env, days: 3, now })
	expect(ok).toMatchObject({
		available: true,
		reason: null,
		days: 3,
		startDay: '2026-10-26',
		endDay: '2026-10-28',
	})
	expect(ok.paths[0]).toMatchObject({
		path: 'queued',
		pushes: 2,
		avgWallMs: 200,
	})
	expect(queryMocks.queryAnalyticsEngineSql.mock.calls[0]![0]).toMatchObject({
		accountId: 'acct',
		baseUrl: 'https://api.cloudflare.com',
	})
	expect(
		String(queryMocks.queryAnalyticsEngineSql.mock.calls[0]![0].query),
	).toContain('FROM kody_usage_events_preview')

	consoleWarn.mockImplementation(() => {})
	queryMocks.queryAnalyticsEngineSql.mockRejectedValueOnce(
		new Error('HTTP 422'),
	)
	const failed = await loadRepoPushQueueCost({ env, now })
	expect(failed.available).toBe(false)
	expect(failed.reason).toContain('HTTP 422')
	expect(consoleWarn).toHaveBeenCalledWith(
		'repo-push-queue-cost-query-failed',
		expect.any(Error),
	)
})
