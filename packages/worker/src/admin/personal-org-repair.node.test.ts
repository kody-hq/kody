import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { runPersonalOrgRepair } from './personal-org-repair.ts'
import {
	clearAdminUserEmailOutboundPause,
	updateAdminUserPlan,
} from './users-data.ts'

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

async function insertUser(
	sqlite: DatabaseSync,
	db: D1Database,
	input: {
		username: string
		orgId?: string
		passwordHash?: string
		mcpClientName?: string
		provision?: boolean
	},
) {
	const stableUserId = testStableUserIdFromEmail(
		`${input.username}@example.com`,
	)
	const orgId = input.orgId ?? stableUserId
	const createdAt = '2026-10-20T00:00:00.000Z'
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, personal_org_id, mcp_client_name, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.username,
			`${input.username}@example.com`,
			input.passwordHash ?? 'x',
			stableUserId,
			orgId,
			input.mcpClientName ?? null,
			createdAt,
			createdAt,
		)
	if (input.provision !== false) {
		await provisionPersonalOrg(db, {
			stableUserId,
			orgId,
			username: input.username,
			createdAt,
		})
	}
	return { stableUserId, orgId }
}

const env = (db: D1Database) =>
	({ APP_DB: db, SENTRY_ENVIRONMENT: 'test' }) as unknown as Pick<
		Env,
		'APP_DB' | 'AUDIT_DB' | 'SENTRY_ENVIRONMENT'
	>

test('updateAdminUserPlan writes the personal org when its id differs from the person id', async () => {
	const { sqlite, db } = createDb()
	const distinctOrgId = testStableUserIdFromEmail('distinct-org@example.com')
	const { stableUserId } = await insertUser(sqlite, db, {
		username: 'distinctorg',
		orgId: distinctOrgId,
	})

	const updated = await updateAdminUserPlan(db, { stableUserId, plan: 'pro' })

	expect(updated?.manualPlan).toBe('pro')
	expect(
		sqlite.prepare('SELECT plan FROM orgs WHERE id = ?').get(distinctOrgId),
	).toEqual({ plan: 'pro' })
	expect(
		sqlite
			.prepare('SELECT COUNT(*) AS n FROM orgs WHERE id = ?')
			.get(stableUserId),
	).toEqual({ n: 0 })
})

test('clearAdminUserEmailOutboundPause clears the pause on a distinct personal org', async () => {
	const { sqlite, db } = createDb()
	const distinctOrgId = testStableUserIdFromEmail('paused-org@example.com')
	const { stableUserId } = await insertUser(sqlite, db, {
		username: 'pausedorg',
		orgId: distinctOrgId,
	})
	sqlite
		.prepare('UPDATE orgs SET email_outbound_paused_at = ? WHERE id = ?')
		.run('2026-10-21 00:00:00', distinctOrgId)

	await clearAdminUserEmailOutboundPause(db, { stableUserId })

	expect(
		sqlite
			.prepare('SELECT email_outbound_paused_at FROM orgs WHERE id = ?')
			.get(distinctOrgId),
	).toEqual({ email_outbound_paused_at: null })
})

test('updateAdminUserPlan still reports a truly missing personal org', async () => {
	const { sqlite, db } = createDb()
	const { stableUserId } = await insertUser(sqlite, db, {
		username: 'noorg',
		orgId: testStableUserIdFromEmail('no-org@example.com'),
		provision: false,
	})
	await expect(
		updateAdminUserPlan(db, { stableUserId, plan: 'pro' }),
	).rejects.toThrow(/missing personal org/)
})

test('runPersonalOrgRepair counts on dry run, repairs only missing rows, and is idempotent', async () => {
	const { sqlite, db } = createDb()
	await insertUser(sqlite, db, { username: 'healthy' })
	await insertUser(sqlite, db, {
		username: 'healthydistinct',
		orgId: testStableUserIdFromEmail('healthy-distinct-org@example.com'),
	})
	const missingOrgId = testStableUserIdFromEmail('missing-org@example.com')
	const missing = await insertUser(sqlite, db, {
		username: 'missingorg',
		orgId: missingOrgId,
		passwordHash: 'oauth_created_no_usable_password',
		mcpClientName: 'codex-mcp-client',
		provision: false,
	})

	const dry = await runPersonalOrgRepair({ env: env(db), dryRun: true })
	expect(dry.counts).toMatchObject({
		scanned: 3,
		distinctOrgId: 2,
		missingOrg: 1,
		missingMembership: 1,
		missingHandle: 1,
		needsRepair: 1,
		repaired: 1,
		failed: 0,
	})
	expect(dry.bySignupPath).toEqual([
		{ signupPath: 'oauth:codex-mcp-client', count: 1 },
	])
	expect(
		sqlite
			.prepare('SELECT COUNT(*) AS n FROM orgs WHERE id = ?')
			.get(missingOrgId),
	).toEqual({ n: 0 })

	const applied = await runPersonalOrgRepair({ env: env(db), dryRun: false })
	expect(applied.counts.repaired).toBe(1)
	expect(applied.outcomes).toEqual([
		{ stableUserId: missing.stableUserId, outcome: 'repaired' },
	])
	expect(
		sqlite
			.prepare(
				'SELECT plan, admin_credits_eligible, slug FROM orgs WHERE id = ?',
			)
			.get(missingOrgId),
	).toMatchObject({ plan: 'free', slug: 'missingorg' })
	expect(
		sqlite
			.prepare(
				'SELECT role FROM org_memberships WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL',
			)
			.get(missingOrgId, missing.stableUserId),
	).toEqual({ role: 'owner' })

	const again = await runPersonalOrgRepair({ env: env(db), dryRun: false })
	expect(again.counts.needsRepair).toBe(0)
	expect(again.counts.repaired).toBe(0)
})

test('runPersonalOrgRepair skips soft-deleted orgs and pages with a cursor', async () => {
	const { sqlite, db } = createDb()
	const deleted = await insertUser(sqlite, db, { username: 'deletedorg' })
	sqlite
		.prepare('UPDATE orgs SET deleted_at = ? WHERE id = ?')
		.run('2026-10-22T00:00:00.000Z', deleted.orgId)
	await insertUser(sqlite, db, { username: 'second' })

	const page = await runPersonalOrgRepair({
		env: env(db),
		dryRun: false,
		limit: 1,
	})
	expect(page.counts.skippedOrgSoftDeleted).toBe(1)
	expect(page.counts.repaired).toBe(0)
	expect(page.nextCursor).not.toBeNull()
	const next = await runPersonalOrgRepair({
		env: env(db),
		dryRun: true,
		cursor: page.nextCursor,
	})
	expect(next.counts.scanned).toBe(1)
	expect(next.nextCursor).toBeNull()
})

test('runPersonalOrgRepair reports a handle conflict as failed and writes nothing', async () => {
	const { sqlite, db } = createDb()
	const other = await insertUser(sqlite, db, { username: 'other' })
	const orgId = testStableUserIdFromEmail('conflict-org@example.com')
	await insertUser(sqlite, db, {
		username: 'conflicted',
		orgId,
		provision: false,
	})
	sqlite
		.prepare(
			'INSERT INTO handles (handle, user_id, org_id, created_at) VALUES (?, ?, ?, ?)',
		)
		.run(
			'conflicted',
			other.stableUserId,
			other.orgId,
			'2026-10-20T00:00:00.000Z',
		)

	const result = await runPersonalOrgRepair({ env: env(db), dryRun: false })

	expect(result.counts.failed).toBe(1)
	expect(result.counts.repaired).toBe(0)
	expect(
		sqlite.prepare('SELECT COUNT(*) AS n FROM orgs WHERE id = ?').get(orgId),
	).toEqual({ n: 0 })
	expect(
		sqlite
			.prepare('SELECT COUNT(*) AS n FROM org_memberships WHERE org_id = ?')
			.get(orgId),
	).toEqual({ n: 0 })
})
