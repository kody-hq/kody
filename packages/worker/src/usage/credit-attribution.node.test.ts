import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const queryAnalyticsEngineSql = vi.fn()

vi.mock('./aggregate-rollups.ts', async (importOriginal) => {
	const original = (await importOriginal()) as Record<string, unknown>
	return {
		...original,
		queryAnalyticsEngineSql: (...args: Array<unknown>) =>
			queryAnalyticsEngineSql(...args),
	}
})

const { aggregateCreditAttributionDaily } =
	await import('./credit-attribution.ts')
const { normalizeCreditAttributionAutomationSource } =
	await import('#universal/credit-attribution.ts')

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const now = new Date('2026-10-22T12:00:00.000Z')

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('normalizeCreditAttributionAutomationSource maps empty and invalid to NULL', () => {
	expect(normalizeCreditAttributionAutomationSource('')).toBeNull()
	expect(normalizeCreditAttributionAutomationSource('   ')).toBeNull()
	expect(normalizeCreditAttributionAutomationSource(null)).toBeNull()
	expect(normalizeCreditAttributionAutomationSource(undefined)).toBeNull()
	expect(normalizeCreditAttributionAutomationSource('cron')).toBeNull()
	expect(normalizeCreditAttributionAutomationSource('webhook')).toBe('webhook')
	expect(normalizeCreditAttributionAutomationSource('schedule')).toBe(
		'schedule',
	)
	expect(normalizeCreditAttributionAutomationSource('email')).toBe('email')
	expect(normalizeCreditAttributionAutomationSource('event')).toBe('event')
})

test('aggregateCreditAttributionDaily writes a row when AE returns empty automation_source', async () => {
	const { sqlite, db } = createMigratedDb()
	const userId = ownerIdFromStored(
		testStableUserIdFromEmail('attribution-empty-source@example.com'),
	)
	const createdAt = '2026-10-01T00:00:00.000Z'
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, created_at, updated_at)
			 VALUES ('attruser', 'attribution-empty-source@example.com', 'hash', ?, ?, ?)`,
		)
		.run(userId, createdAt, createdAt)
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
			 VALUES (?, 'attruser', 'free', ?, ?)`,
		)
		.run(userId, createdAt, createdAt)

	// Prove the migrated CHECK still rejects empty string (the production bug).
	expect(() =>
		sqlite
			.prepare(
				`INSERT INTO usage_attribution_daily (
					user_id, day, package_id, meter, units, updated_at,
					actor_user_id, automation_source
				) VALUES (?, '2026-10-10', '', 'unique_worker_days', 1, ?, ?, '')`,
			)
			.run(userId, createdAt, userId),
	).toThrow(/CHECK constraint failed/i)

	queryAnalyticsEngineSql
		.mockResolvedValueOnce([
			{
				user_id: userId,
				day: '2026-10-15',
				package_id: 'pkg-1',
				event_type: 'dynamic_worker_day',
				actor_user_id: userId,
				automation_source: '',
				units: 3,
			},
		])
		.mockResolvedValueOnce([])

	const result = await aggregateCreditAttributionDaily(
		{
			APP_DB: db,
			USAGE_EVENTS: {} as AnalyticsEngineDataset,
			CLOUDFLARE_ACCOUNT_ID: 'account',
			CLOUDFLARE_API_TOKEN: 'token',
		},
		now,
	)

	expect(result).toEqual({ skipped: false, upserted: 1 })
	const row = sqlite
		.prepare(
			`SELECT user_id, day, package_id, meter, units, actor_user_id, automation_source
			 FROM usage_attribution_daily
			 WHERE user_id = ? AND day = '2026-10-15' AND package_id = 'pkg-1'`,
		)
		.get(userId) as {
		user_id: string
		day: string
		package_id: string
		meter: string
		units: number
		actor_user_id: string
		automation_source: string | null
	}
	expect(row).toMatchObject({
		user_id: userId,
		day: '2026-10-15',
		package_id: 'pkg-1',
		meter: 'unique_worker_days',
		units: 3,
		actor_user_id: userId,
		automation_source: null,
	})
})

test('visitor-only AE results do not delete existing credit attribution', async () => {
	const { sqlite, db } = createMigratedDb()
	const userId = ownerIdFromStored(
		testStableUserIdFromEmail('visitor-attribution@example.com'),
	)
	const createdAt = '2026-10-01T00:00:00.000Z'
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, created_at, updated_at)
			 VALUES ('attruser', 'visitor-attribution@example.com', 'hash', ?, ?, ?)`,
		)
		.run(userId, createdAt, createdAt)
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
			 VALUES (?, 'attruser', 'free', ?, ?)`,
		)
		.run(userId, createdAt, createdAt)
	sqlite
		.prepare(
			`INSERT INTO usage_attribution_daily (user_id, day, package_id, meter, units)
			 VALUES (?, '2026-10-15', 'pkg-1', 'unique_worker_days', 3)`,
		)
		.run(userId)

	queryAnalyticsEngineSql.mockResolvedValueOnce([]).mockResolvedValueOnce([
		{
			user_id: userId,
			day: '2026-10-15',
			package_id: 'pkg-1',
			visitor_user_id: '',
			event_type: 'dynamic_worker_day',
			units: 1,
		},
	])

	await aggregateCreditAttributionDaily(
		{
			APP_DB: db,
			USAGE_EVENTS: {} as AnalyticsEngineDataset,
			CLOUDFLARE_ACCOUNT_ID: 'account',
			CLOUDFLARE_API_TOKEN: 'token',
		},
		now,
	)

	const row = sqlite
		.prepare(
			`SELECT units FROM usage_attribution_daily
			 WHERE user_id = ? AND day = '2026-10-15' AND package_id = 'pkg-1'`,
		)
		.get(userId) as { units: number }
	expect(row.units).toBe(3)
})
