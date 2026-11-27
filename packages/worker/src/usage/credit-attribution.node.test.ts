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

const {
	aggregateCreditAttributionDaily,
	buildPackageAppVisitorAttributionDailyQuery,
	loadPackageAppVisitorAttribution,
	selectPackageAppVisitorIds,
} = await import('./credit-attribution.ts')
const { normalizeCreditAttributionAutomationSource } =
	await import('#universal/credit-attribution.ts')

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const now = new Date('2026-10-22T12:00:00.000Z')

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('package app visitor limits rank credits and break ties by visitor id', () => {
	expect(
		selectPackageAppVisitorIds(
			[
				{ visitorId: 'visitor-b', creditsMicroUsd: 10 },
				{ visitorId: 'visitor-a', creditsMicroUsd: 10 },
				{ visitorId: 'visitor-c', creditsMicroUsd: 2 },
			],
			2,
		),
	).toEqual(['visitor-a', 'visitor-b'])
})

test('package app visitor name lookups only cover retained rows with bounded concurrency', async () => {
	const attributionRows = Array.from({ length: 501 }, (_, index) => ({
		day: '2026-10-01',
		package_id: 'pkg-1',
		visitor_user_id: `visitor-${String(index).padStart(3, '0')}`,
		meter: 'unique_worker_days',
		units: 1,
	}))
	const nameIds: Array<string> = []
	let activeLookups = 0
	let maxActiveLookups = 0
	const db = {
		prepare(sql: string) {
			return {
				bind(...args: Array<unknown>) {
					return {
						async all() {
							if (sql.includes('FROM package_app_visitor_attribution_daily')) {
								return { results: attributionRows }
							}
							nameIds.push(...(args as Array<string>))
							activeLookups += 1
							maxActiveLookups = Math.max(maxActiveLookups, activeLookups)
							await new Promise((resolve) => setTimeout(resolve, 0))
							activeLookups -= 1
							return { results: [] }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	const result = await loadPackageAppVisitorAttribution({
		db,
		stableUserId: 'owner-1',
		month: '2026-10',
		dailyUnits: [
			{
				packageId: 'pkg-1',
				day: '2026-10-01',
				meter: 'unique_worker_days',
				units: 501,
			},
		],
		includes: [{ meter: 'unique_worker_days', include: 0 }],
	})

	expect(result.get('pkg-1')).toMatchObject({
		total: 501,
		truncated: true,
	})
	expect(result.get('pkg-1')?.rows).toHaveLength(500)
	expect(nameIds).toHaveLength(500)
	expect(nameIds).not.toContain('visitor-500')
	expect(maxActiveLookups).toBeLessThanOrEqual(4)
})

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

test('a cross-org visit stays in the publisher Visitors list with no publisher credits for its metered work', async () => {
	const { sqlite, db } = createMigratedDb()
	const ownerId = ownerIdFromStored(
		testStableUserIdFromEmail('billed-owner@example.com'),
	)
	const visitorOrgId = ownerIdFromStored(
		testStableUserIdFromEmail('billed-visitor@example.com'),
	)
	const createdAt = '2026-10-01T00:00:00.000Z'
	for (const [id, name] of [
		[ownerId, 'billedowner'],
		[visitorOrgId, 'billedvisitor'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO users (username, email, password_hash, stable_user_id, created_at, updated_at)
				 VALUES (?, ?, 'hash', ?, ?, ?)`,
			)
			.run(name, `${name}@example.com`, id, createdAt, createdAt)
		sqlite
			.prepare(
				`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
				 VALUES (?, ?, 'free', ?, ?)`,
			)
			.run(id, name, createdAt, createdAt)
	}
	queryAnalyticsEngineSql
		.mockResolvedValueOnce([
			{
				user_id: ownerId,
				day: '2026-10-15',
				package_id: 'pkg-1',
				event_type: 'dynamic_worker_day',
				actor_user_id: visitorOrgId,
				automation_source: '',
				units: 1,
			},
			{
				user_id: visitorOrgId,
				day: '2026-10-15',
				package_id: 'pkg-1',
				event_type: 'durable_object_rows_read',
				actor_user_id: visitorOrgId,
				automation_source: '',
				units: 40,
			},
		])
		.mockResolvedValueOnce([
			{
				user_id: ownerId,
				billed_org_id: '',
				day: '2026-10-15',
				package_id: 'pkg-1',
				visitor_user_id: visitorOrgId,
				event_type: 'dynamic_worker_day',
				units: 1,
			},
			{
				user_id: ownerId,
				billed_org_id: visitorOrgId,
				day: '2026-10-15',
				package_id: 'pkg-1',
				visitor_user_id: visitorOrgId,
				event_type: 'durable_object_rows_read',
				units: 40,
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
	// The visiting org is the one charged for the rows it read.
	expect(
		sqlite
			.prepare(
				`SELECT user_id, meter, units FROM usage_attribution_daily
				 WHERE package_id = 'pkg-1' ORDER BY meter`,
			)
			.all(),
	).toEqual([
		{ user_id: visitorOrgId, meter: 'durable_object_rows_read', units: 40 },
		{ user_id: ownerId, meter: 'unique_worker_days', units: 1 },
	])
	// Both visitor rows stay under the publisher, the metered one tagged.
	expect(
		sqlite
			.prepare(
				`SELECT user_id, billed_org_id, meter FROM package_app_visitor_attribution_daily
				 ORDER BY meter`,
			)
			.all(),
	).toEqual([
		{
			user_id: ownerId,
			billed_org_id: visitorOrgId,
			meter: 'durable_object_rows_read',
		},
		{ user_id: ownerId, billed_org_id: '', meter: 'unique_worker_days' },
	])

	const visitors = await loadPackageAppVisitorAttribution({
		db,
		stableUserId: ownerId,
		month: '2026-10',
		dailyUnits: [
			{
				packageId: 'pkg-1',
				day: '2026-10-15',
				meter: 'unique_worker_days',
				units: 1,
			},
		],
		includes: [
			{ meter: 'unique_worker_days', include: 0 },
			{ meter: 'durable_object_rows_read', include: 0 },
		],
	})
	const [visitor] = visitors.get('pkg-1')?.rows ?? []
	expect(visitor).toMatchObject({
		displayName: 'billedvisitor',
		billedToVisitorOrg: true,
	})
	const rowsRead = visitor?.meters.find(
		(meter) => meter.meter === 'durable_object_rows_read',
	)
	expect(rowsRead).toEqual(
		expect.objectContaining({
			units: 40,
			creditsMicroUsd: 0,
			billedToVisitorOrg: true,
		}),
	)
	const workerDays = visitor?.meters.find(
		(meter) => meter.meter === 'unique_worker_days',
	)
	expect(workerDays?.billedToVisitorOrg).toBeUndefined()
	expect(visitor?.creditsMicroUsd).toBe(workerDays?.creditsMicroUsd)
})

test('another org app shows up in the visiting org usage named as shared by its owner', async () => {
	const { loadPackageAttributionLabels } =
		await import('./credit-attribution.ts')
	const db = {
		prepare(sql: string) {
			return {
				bind: () => ({
					async all() {
						if (sql.includes('INNER JOIN orgs')) {
							return {
								results: [
									{
										id: 'pkg-shared',
										kody_id: 'tracker',
										name: '@publisher/tracker',
										owner_slug: 'publisher',
									},
								],
							}
						}
						return { results: [] }
					},
				}),
			}
		},
	} as unknown as D1Database
	const labels = await loadPackageAttributionLabels({
		db,
		stableUserId: 'org-visitor',
		username: 'visitor',
		packageIds: ['pkg-shared'],
	})
	expect(labels.names.get('pkg-shared')).toBe(
		'@publisher/tracker (app shared by @publisher)',
	)
	expect(labels.hrefs.get('pkg-shared')).toContain('publisher')
})

test("an agent profile's visits stay under the person in Visitors and name the profile", async () => {
	const { sqlite, db } = createMigratedDb()
	const ownerId = ownerIdFromStored(
		testStableUserIdFromEmail('profile-owner@example.com'),
	)
	const visitorId = ownerIdFromStored(
		testStableUserIdFromEmail('profile-visitor@example.com'),
	)
	const createdAt = '2026-10-01T00:00:00.000Z'
	for (const [id, name] of [
		[ownerId, 'profileowner'],
		[visitorId, 'profilevisitor'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO users (username, email, password_hash, stable_user_id, created_at, updated_at)
				 VALUES (?, ?, 'hash', ?, ?, ?)`,
			)
			.run(name, `${name}@example.com`, id, createdAt, createdAt)
		sqlite
			.prepare(
				`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
				 VALUES (?, ?, 'free', ?, ?)`,
			)
			.run(id, name, createdAt, createdAt)
	}
	// The profile lives in the visitor's org, not the publisher's.
	sqlite
		.prepare(
			`INSERT INTO profiles (
				id, org_id, acting_user_id, name, depth, created_by_user_id,
				created_at, updated_at
			) VALUES ('prf_research', ?, ?, 'Research bot', 1, ?, ?, ?)`,
		)
		.run(visitorId, visitorId, visitorId, createdAt, createdAt)
	const visitorRow = {
		user_id: ownerId,
		billed_org_id: '',
		day: '2026-10-15',
		package_id: 'pkg-1',
		visitor_user_id: visitorId,
		event_type: 'dynamic_worker_day',
	}
	const analytics = (profileUnits: number) => {
		queryAnalyticsEngineSql
			.mockResolvedValueOnce([
				{
					user_id: ownerId,
					day: '2026-10-15',
					package_id: 'pkg-1',
					event_type: 'dynamic_worker_day',
					actor_user_id: visitorId,
					automation_source: '',
					units: 1 + profileUnits,
				},
			])
			.mockResolvedValueOnce([
				{ ...visitorRow, visitor_profile_id: '', units: 1 },
				...(profileUnits
					? [
							{
								...visitorRow,
								visitor_profile_id: 'prf_research',
								units: profileUnits,
							},
							{
								...visitorRow,
								visitor_profile_id: 'prf_gone',
								units: profileUnits,
							},
						]
					: []),
			])
	}
	const env = {
		APP_DB: db,
		USAGE_EVENTS: {} as AnalyticsEngineDataset,
		CLOUDFLARE_ACCOUNT_ID: 'account',
		CLOUDFLARE_API_TOKEN: 'token',
	}
	const storedRows = () =>
		sqlite
			.prepare(
				`SELECT visitor_user_id, visitor_profile_id, units
				 FROM package_app_visitor_attribution_daily
				 ORDER BY visitor_profile_id`,
			)
			.all()
	analytics(2)
	await aggregateCreditAttributionDaily(env, now)
	const query = buildPackageAppVisitorAttributionDailyQuery('usage', {
		monthStart: '2026-10-01 00:00:00',
		nextMonthStart: '2026-11-01 00:00:00',
	})
	expect(query).toContain('blob17 AS visitor_profile_id')
	expect(query).toContain('visitor_user_id, visitor_profile_id, event_type')
	// One row per person and profile, all under the same person.
	expect(storedRows()).toEqual([
		{ visitor_user_id: visitorId, visitor_profile_id: '', units: 1 },
		{ visitor_user_id: visitorId, visitor_profile_id: 'prf_gone', units: 2 },
		{
			visitor_user_id: visitorId,
			visitor_profile_id: 'prf_research',
			units: 2,
		},
	])

	const visitors = await loadPackageAppVisitorAttribution({
		db,
		stableUserId: ownerId,
		month: '2026-10',
		dailyUnits: [
			{
				packageId: 'pkg-1',
				day: '2026-10-15',
				meter: 'unique_worker_days',
				units: 5,
			},
		],
		includes: [
			{ meter: 'unique_worker_days', include: 0 },
			{ meter: 'durable_object_rows_read', include: 0 },
		],
	})
	// Still one visitor: the person, with the profiles that acted for them.
	expect(visitors.get('pkg-1')).toMatchObject({ total: 1 })
	const [visitor] = visitors.get('pkg-1')?.rows ?? []
	expect(visitor).toMatchObject({
		displayName: 'profilevisitor',
		agentProfiles: ['Deleted profile', 'Research bot'],
	})
	expect(visitor?.meters).toEqual([
		expect.objectContaining({ meter: 'unique_worker_days', units: 5 }),
	])

	// A later recompute without the profile's units drops only those rows.
	analytics(0)
	await aggregateCreditAttributionDaily(env, now)
	expect(storedRows()).toEqual([
		{ visitor_user_id: visitorId, visitor_profile_id: '', units: 1 },
	])
})
