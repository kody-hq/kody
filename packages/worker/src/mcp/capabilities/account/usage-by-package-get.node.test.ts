import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { utcDayKey, utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryRepoSessionIndexEnv } from '#worker/test-support/repo-session-index.ts'
import { createInMemoryRunLogUsageEnv } from '#worker/test-support/run-log-usage.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { usageByPackageGetCapability } from './usage-by-package-get.ts'

const email = 'usage-by-package-get@example.com'
const username = 'usage-by-pkg'

function createAttributionEnv() {
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
			 VALUES (?, ?, 'hash', ?)`,
		)
		.run(username, email, stableUserId)
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
			 VALUES (?, ?, 'free', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
		)
		.run(stableUserId, username)
	sqlite
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES ('pkg-alpha', ?, 'Alpha Bot', 'alpha-bot', '', 'src-alpha')`,
		)
		.run(stableUserId)
	const db = createD1FromSqlite(sqlite)
	return {
		stableUserId,
		sqlite,
		env: {
			APP_DB: db,
			...createInMemoryUserMeterEnv().env,
			...createInMemoryRunLogUsageEnv().env,
			REPO_SESSION_INDEX:
				createInMemoryRepoSessionIndexEnv(db).REPO_SESSION_INDEX,
			MAILBOX: {
				idFromName: (name: string) => name as unknown as DurableObjectId,
				get: () => ({ countMessages: async () => ({ total: 0 }) }),
			},
		} as unknown as Env,
	}
}

function callerContext(userId: string) {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://example.com',
		user: {
			userId: personIdFromStored(userId),
			email,
			username,
			displayName: 'Usage By Package',
		},
	})
}

function seedAttributionUnits(input: {
	sqlite: DatabaseSync
	stableUserId: string
	day: string
	packageId: string
	meter: 'unique_worker_days' | 'durable_object_rows_read'
	units: number
}) {
	input.sqlite
		.prepare(
			`INSERT INTO usage_attribution_daily (
				user_id, day, package_id, meter, units, updated_at
			) VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.stableUserId,
			input.day,
			input.packageId,
			input.meter,
			input.units,
			new Date().toISOString(),
		)
}

test('usageByPackageGet attributes past-include Worker compute credits by package', async () => {
	const now = new Date()
	const month = utcMonthKey(now)
	const day = `${month}-01`
	const { env, stableUserId, sqlite } = createAttributionEnv()
	await expect(
		usageByPackageGetCapability.handler(
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
	// Free include is 50 Worker compute days; 55 units → 5 past-include.
	seedAttributionUnits({
		sqlite,
		stableUserId,
		day,
		packageId: 'pkg-alpha',
		meter: 'unique_worker_days',
		units: 55,
	})

	const result = await usageByPackageGetCapability.handler(
		{},
		{
			env,
			callerContext: callerContext(stableUserId),
		},
	)

	expect(result.month).toBe(month)
	expect(result.totalCreditsMicroUsd).toBeGreaterThan(0)
	const alpha = result.rows.find((row) => row.packageId === 'pkg-alpha')
	expect(alpha).toMatchObject({
		name: 'Alpha Bot',
		href: `/@${username}/alpha-bot`,
		isAdHoc: false,
	})
	expect(alpha?.creditsMicroUsd).toBe(result.totalCreditsMicroUsd)
	expect(alpha?.share).toBe(1)
	expect(
		alpha?.meters.some(
			(meter) =>
				meter.meter === 'unique_worker_days' &&
				meter.label === 'Worker compute',
		),
	).toBe(true)
})

test('usageByPackageGet packageId returns that package slice of the period', async () => {
	const now = new Date()
	const day = utcDayKey(now)
	const { env, stableUserId, sqlite } = createAttributionEnv()
	seedAttributionUnits({
		sqlite,
		stableUserId,
		day,
		packageId: 'pkg-alpha',
		meter: 'unique_worker_days',
		units: 55,
	})
	seedAttributionUnits({
		sqlite,
		stableUserId,
		day,
		packageId: 'pkg-other',
		meter: 'unique_worker_days',
		units: 10,
	})

	const full = await usageByPackageGetCapability.handler(
		{},
		{
			env,
			callerContext: callerContext(stableUserId),
		},
	)
	const filtered = await usageByPackageGetCapability.handler(
		{ packageId: 'pkg-alpha' },
		{
			env,
			callerContext: callerContext(stableUserId),
		},
	)
	const missing = await usageByPackageGetCapability.handler(
		{ packageId: 'pkg-missing' },
		{
			env,
			callerContext: callerContext(stableUserId),
		},
	)

	expect(filtered.month).toBe(full.month)
	expect(filtered.totalCreditsMicroUsd).toBe(full.totalCreditsMicroUsd)
	expect(filtered.rows).toHaveLength(1)
	expect(filtered.rows[0]?.packageId).toBe('pkg-alpha')
	expect(filtered.rows[0]?.name).toBe('Alpha Bot')
	expect(missing.rows).toHaveLength(1)
	expect(missing.rows[0]).toMatchObject({
		packageId: 'pkg-missing',
		creditsMicroUsd: 0,
		share: 0,
		isAdHoc: false,
	})

	const unspentOwned = await usageByPackageGetCapability.handler(
		{ packageId: 'pkg-alpha' },
		{
			env: createAttributionEnv().env,
			callerContext: callerContext(testStableUserIdFromEmail(email)),
		},
	)
	expect(unspentOwned.rows).toHaveLength(1)
	expect(unspentOwned.rows[0]).toEqual({
		packageId: 'pkg-alpha',
		name: 'Alpha Bot',
		href: `/@${username}/alpha-bot`,
		creditsMicroUsd: 0,
		share: 0,
		meters: [],
		cumulative: [],
		isAdHoc: false,
	})
})

test('usageByPackageGet on a team-bound connection attributes the team org packages', async () => {
	const { env, stableUserId, sqlite } = createAttributionEnv()
	const teamOrgId = 'c'.repeat(64)
	const teamSlug = 'usage-by-pkg-team'
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
			 VALUES (?, ?, 'free', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
		)
		.run(teamOrgId, teamSlug)
	sqlite
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES ('pkg-team', ?, 'Team Bot', 'team-bot', '', 'src-team')`,
		)
		.run(teamOrgId)
	seedAttributionUnits({
		sqlite,
		stableUserId: teamOrgId,
		day: utcDayKey(new Date()),
		packageId: 'pkg-team',
		meter: 'unique_worker_days',
		units: 55,
	})

	const result = await usageByPackageGetCapability.handler(
		{},
		{
			env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://example.com',
				user: {
					userId: personIdFromStored(stableUserId),
					email,
					username,
					displayName: 'Usage By Package',
				},
				orgBinding: {
					org: { id: ownerIdFromStored(teamOrgId), slug: teamSlug },
					role: 'owner',
				},
			}),
		},
	)
	expect(result.totalCreditsMicroUsd).toBeGreaterThan(0)
	expect(result.rows.find((row) => row.packageId === 'pkg-team')).toMatchObject(
		{ name: 'Team Bot', href: `/@${teamSlug}/team-bot`, share: 1 },
	)
	expect(result.rows.some((row) => row.packageId === 'pkg-alpha')).toBe(false)
})
