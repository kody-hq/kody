import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

vi.unmock('#worker/audit-log.ts')
import { adminFeatureFlagListCapability } from './admin-feature-flag-list.ts'
import { adminFeatureFlagOrgOverrideCapability } from './admin-feature-flag-org-override.ts'
import { adminFeatureFlagOverrideCapability } from './admin-feature-flag-override.ts'
import { adminFeatureFlagSetCapability } from './admin-feature-flag-set.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

function createFeatureFlagCapabilityTest() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	sqlite.exec(
		readFileSync(
			new URL(
				'../../../../audit-migrations/0001-audit-events.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
	const insertUser = sqlite.prepare(
		`INSERT INTO users (id, username, email, password_hash, stable_user_id)
		 VALUES (?, ?, ?, 'hash', ?)`,
	)
	for (const [id, username] of [
		[1, 'admin'],
		[2, 'jane'],
	] as const) {
		const email = `${username}@example.com`
		insertUser.run(id, username, email, testStableUserIdFromEmail(email))
	}
	const db = createD1FromSqlite(sqlite)
	return {
		sqlite,
		ctx: {
			env: { APP_DB: db, AUDIT_DB: db } as Env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://example.com',
				user: {
					userId: personIdFromStored(
						testStableUserIdFromEmail('admin@example.com'),
					),
					email: 'admin@example.com',
					displayName: 'admin',
					roles: ['admin'],
				},
			}),
		},
	}
}

test('admin feature flag MCP capabilities: list, set, override, and audit wiring', async () => {
	const { sqlite, ctx } = createFeatureFlagCapabilityTest()
	const row = (query: string) => sqlite.prepare(query).get()

	const listResult = await adminFeatureFlagListCapability.handler({}, ctx)
	expect(listResult.flags).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				key: 'demo-indicator',
				description: expect.any(String),
				defaultEnabled: false,
				stale: false,
				global: null,
				overrides: [],
				successMetric: null,
			}),
		]),
	)
	const demoFlag = listResult.flags.find(
		(flag) => flag.key === 'demo-indicator',
	)
	expect(demoFlag?.description).not.toHaveLength(0)

	const setResult = await adminFeatureFlagSetCapability.handler(
		{
			key: 'demo-indicator',
			enabled: true,
			rolloutPercent: 25,
			note: 'gradual rollout',
		},
		ctx,
	)
	expect(setResult.flag).toMatchObject({
		key: 'demo-indicator',
		global: {
			enabled: true,
			rolloutPercent: 25,
			audience: 'everyone',
			note: 'gradual rollout',
			updatedByStableUserId: testStableUserIdFromEmail('admin@example.com'),
		},
	})
	expect(
		row(
			`SELECT enabled, rollout_percent, audience, updated_by FROM feature_flags WHERE key = 'demo-indicator'`,
		),
	).toEqual({
		enabled: 1,
		rollout_percent: 25,
		audience: 'everyone',
		updated_by: 1,
	})

	await expect(
		adminFeatureFlagSetCapability.handler(
			{ key: 'not-a-real-flag', enabled: true },
			ctx,
		),
	).rejects.toThrow(/Unknown feature flag key/)

	const setByUsername = await adminFeatureFlagOverrideCapability.handler(
		{ key: 'demo-indicator', username: 'JANE', enabled: true },
		ctx,
	)
	expect(setByUsername).toMatchObject({
		cleared: false,
		flag: {
			key: 'demo-indicator',
			overrides: [
				expect.objectContaining({
					stableUserId: testStableUserIdFromEmail('jane@example.com'),
					username: 'jane',
					enabled: true,
				}),
			],
		},
	})
	const overrideQuery = `SELECT enabled, updated_by FROM feature_flag_user_overrides WHERE flag_key = 'demo-indicator' AND user_id = 2`
	expect(row(overrideQuery)).toEqual({ enabled: 1, updated_by: 1 })

	const cleared = await adminFeatureFlagOverrideCapability.handler(
		{
			key: 'demo-indicator',
			stableUserId: testStableUserIdFromEmail('jane@example.com'),
			clear: true,
		},
		ctx,
	)
	expect(cleared.cleared).toBe(true)
	expect(cleared.flag.overrides).toEqual([])
	expect(row(overrideQuery)).toBeUndefined()

	expect(
		sqlite
			.prepare('SELECT result FROM audit_events ORDER BY id')
			.all()
			.map((event) => event.result),
	).toEqual(['success', 'success', 'failure', 'success', 'success'])
})

test('adminFeatureFlagOrgOverride sets and clears org rows by id or slug', async () => {
	const { sqlite, ctx } = createFeatureFlagCapabilityTest()
	sqlite.exec(
		`INSERT INTO orgs (id, slug, display_name, plan, created_at, updated_at)
		 VALUES ('org-team', 'team', 'Team', 'free', '2026-10-20', '2026-10-20')`,
	)
	const orgRow = () =>
		sqlite
			.prepare(
				`SELECT enabled, note, updated_by FROM feature_flag_org_overrides
				 WHERE flag_key = 'demo-indicator' AND org_id = 'org-team'`,
			)
			.get()

	const setBySlug = await adminFeatureFlagOrgOverrideCapability.handler(
		{ key: 'demo-indicator', orgSlug: '@Team', enabled: true, note: 'pilot' },
		ctx,
	)
	expect(setBySlug).toMatchObject({
		cleared: false,
		flag: {
			key: 'demo-indicator',
			orgOverrides: [
				expect.objectContaining({
					orgId: 'org-team',
					slug: 'team',
					personal: false,
					enabled: true,
					note: 'pilot',
					updatedByStableUserId: testStableUserIdFromEmail('admin@example.com'),
				}),
			],
		},
	})
	expect(orgRow()).toEqual({
		enabled: 1,
		note: 'pilot',
		updated_by: testStableUserIdFromEmail('admin@example.com'),
	})

	await adminFeatureFlagOrgOverrideCapability.handler(
		{ key: 'demo-indicator', orgId: 'org-team', enabled: false },
		ctx,
	)
	expect(orgRow()).toMatchObject({ enabled: 0, note: 'pilot' })

	await expect(
		adminFeatureFlagOrgOverrideCapability.handler(
			{ key: 'demo-indicator', orgSlug: 'missing-org', enabled: true },
			ctx,
		),
	).rejects.toThrow()

	const cleared = await adminFeatureFlagOrgOverrideCapability.handler(
		{ key: 'demo-indicator', orgSlug: 'team', clear: true },
		ctx,
	)
	expect(cleared.cleared).toBe(true)
	expect(cleared.flag.orgOverrides).toEqual([])
	expect(orgRow()).toBeUndefined()
	await expect(
		adminFeatureFlagOrgOverrideCapability.handler(
			{ key: 'demo-indicator', orgId: 'org-team', clear: true },
			ctx,
		),
	).rejects.toThrow(/No org row/)

	expect(
		sqlite
			.prepare('SELECT result FROM audit_events ORDER BY id')
			.all()
			.map((event) => event.result),
	).toEqual(['success', 'success', 'failure', 'success', 'failure'])
})
