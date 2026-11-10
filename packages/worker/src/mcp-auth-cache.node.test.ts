import { DatabaseSync } from 'node:sqlite'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import {
	assignUserRole,
	removeUserRole,
} from '#worker/identity/permissions-db.ts'
import {
	clearMcpAuthCacheForTests,
	mcpAuthCacheSizeForTests,
} from '#worker/mcp-auth-cache.ts'
import { buildMcpAuthContextCached } from '#worker/mcp-auth-user-context.ts'
import {
	addOrgMember,
	addTeamMember,
	createOrg,
	createTeam,
	removeTeamMember,
	softDeleteGrant,
	updateOrgMemberRole,
	upsertGrant,
} from '#worker/orgs/access-writes.ts'
import { redeemOrgInviteLink } from '#worker/orgs/invite-link-redeem.ts'
import {
	createOrgInviteLink,
	getInviteLinkByTokenHash,
} from '#worker/orgs/invite-links.ts'
import { offboardOrgMember } from '#worker/orgs/offboarding.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { restoreOrg } from '#worker/orgs/soft-delete.ts'
import { withAccessEpochWriteGuard } from '#worker/test-support/access-epoch-write-guard.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

vi.mock('#worker/orgs/seat-sync-after-membership.ts', () => ({
	syncSeatsAfterMembershipChange: vi.fn(async () => {}),
}))
vi.mock('#worker/billing/soft-delete-billing.ts', () => ({
	cancelKodySubscriptionsForSoftDelete: vi.fn(async () => {}),
}))
vi.mock('#worker/jobs/jobs-data.ts', () => ({
	jobsData: () => ({
		softDeleteJobsForUser: vi.fn(async () => 0),
		restoreJobsForUser: vi.fn(async () => 0),
	}),
}))
vi.mock('#worker/jobs/manager-client.ts', () => ({
	syncJobManagerAlarm: vi.fn(async () => ({ ok: true })),
}))

beforeEach(() => {
	clearMcpAuthCacheForTests()
})

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../migrations/', import.meta.url))
	// Every access-table write the code under test issues must bump
	// access_epoch in the same batch; the guard turns a missed bump into a
	// failing test. Personal-org provisioning (a brand-new org row, run
	// statement by statement) seeds through the unguarded facade.
	const rawDb = createD1FromSqlite(sqlite)
	const inner = withAccessEpochWriteGuard(rawDb)
	const statements: Array<string> = []
	const db = new Proxy(inner, {
		get(target, property, receiver) {
			if (property === 'prepare') {
				return (sql: string) => {
					statements.push(sql.replace(/\s+/g, ' ').trim())
					return target.prepare(sql)
				}
			}
			return Reflect.get(target, property, receiver)
		},
	}) as D1Database
	const env = { APP_DB: db } as Env

	async function seedUser(id: number, username: string) {
		const email = `${username}@example.com`
		const stableUserId = testStableUserIdFromEmail(email)
		sqlite
			.prepare(
				`INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
				 VALUES (?, ?, ?, ?, 'unused', '2026-01-01T00:00:00.000Z')`,
			)
			.run(id, username, email, stableUserId)
		await provisionPersonalOrg(rawDb, { stableUserId, username })
		return { id, stableUserId, email }
	}
	const founder = await seedUser(1, 'founder')
	const owner = await seedUser(2, 'second-owner')
	const joiner = await seedUser(3, 'joiner')
	const org = await createOrg({
		db,
		env: {} as Env,
		slug: 'rocket-co',
		createdByUserId: founder.stableUserId,
		audit: createTestOrgAuditWriter(),
	})
	await addOrgMember({
		db,
		orgId: org.id,
		userId: owner.stableUserId,
		role: 'owner',
		invitedByUserId: founder.stableUserId,
		audit: createTestOrgAuditWriter(),
	})
	statements.length = 0
	return { db, rawDb, env, sqlite, statements, founder, owner, joiner, org }
}

async function loadBinding(env: Env, grantProps: object, token: string) {
	const result = await buildMcpAuthContextCached(env, {
		grantProps: grantProps as Parameters<
			typeof buildMcpAuthContextCached
		>[1]['grantProps'],
		accessToken: token,
	})
	return result?.orgBinding ?? null
}

function roundTripsSince(statements: Array<string>) {
	// Each D1 batch is one round trip; the loader only issues batches.
	return statements.filter((sql) => /^SELECT .*FROM users/i.test(sql)).length
}

test('a warm entry skips the roles and binding reads but a just-demoted owner is never served the stale role', async () => {
	const { env, statements, owner, org } = await setup()
	const grantProps = { userId: owner.stableUserId, orgId: org.id }
	const token = 'token-owner'

	const first = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(first?.orgBinding?.role).toBe('owner')
	expect(first?.orgBinding?.org.id).toBe(org.id)
	expect(mcpAuthCacheSizeForTests()).toBe(1)
	const missStatements = statements.length
	expect(statements.some((sql) => /FROM org_memberships/i.test(sql))).toBe(true)
	expect(statements.some((sql) => /FROM user_roles/i.test(sql))).toBe(true)

	statements.length = 0
	const second = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(second?.orgBinding?.role).toBe('owner')
	expect(roundTripsSince(statements)).toBe(1)
	expect(statements.length).toBeLessThan(missStatements)
	expect(statements.some((sql) => /FROM org_memberships/i.test(sql))).toBe(
		false,
	)
	expect(statements.some((sql) => /FROM user_roles/i.test(sql))).toBe(false)

	await updateOrgMemberRole({
		db: env.APP_DB,
		orgId: org.id,
		userId: owner.stableUserId,
		role: 'member',
		audit: createTestOrgAuditWriter(),
	})
	const demoted = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(demoted?.orgBinding?.role).toBe('member')

	// The recomputed entry is warm again and still correct.
	statements.length = 0
	const again = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(again?.orgBinding?.role).toBe('member')
	expect(statements.some((sql) => /FROM org_memberships/i.test(sql))).toBe(
		false,
	)
})

test('a just-removed owner loses the org binding on the very next request with the same token', async () => {
	const { env, owner, org } = await setup()
	const grantProps = { userId: owner.stableUserId, orgId: org.id }
	const token = 'token-removed-owner'

	const warm = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(warm?.orgBinding?.role).toBe('owner')

	const result = await offboardOrgMember({
		appDb: env.APP_DB,
		env,
		orgId: ownerIdFromStored(String(org.id)),
		memberUserId: owner.stableUserId,
		memberLeftVoluntarily: false,
	})
	expect(result.membershipSoftDeleted).toBe(true)

	const removed = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(removed?.context.user.userId).toBe(owner.stableUserId)
	expect(removed?.orgBinding).toBeNull()
})

test('global role changes invalidate the cached roles immediately', async () => {
	const { env, owner } = await setup()
	const grantProps = { userId: owner.stableUserId, orgId: owner.stableUserId }
	const token = 'token-roles'

	const before = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(before?.context.user.roles ?? []).not.toContain('admin')

	await assignUserRole({ db: env.APP_DB, userId: owner.id, roleName: 'admin' })
	const promoted = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(promoted?.context.user.roles).toContain('admin')

	await removeUserRole({ db: env.APP_DB, userId: owner.id, roleName: 'admin' })
	const demoted = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(demoted?.context.user.roles ?? []).not.toContain('admin')
})

test('suspension and deletion flags are read fresh on every request and evict the entry', async () => {
	const { env, sqlite, owner, org } = await setup()
	const grantProps = { userId: owner.stableUserId, orgId: org.id }
	const token = 'token-flags'

	const warm = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(warm?.context.suspended).toBe(false)

	sqlite
		.prepare(`UPDATE users SET suspended_at = ? WHERE id = ?`)
		.run('2026-10-11T00:00:00.000Z', owner.id)
	const suspended = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(suspended?.context.suspended).toBe(true)

	sqlite
		.prepare(`UPDATE users SET deleting_at = ? WHERE id = ?`)
		.run('2026-10-11T00:00:01.000Z', owner.id)
	const deleting = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken: token,
	})
	expect(deleting).toBeNull()
	expect(mcpAuthCacheSizeForTests()).toBe(0)
})

test('entries are keyed by token, so another token for the same user is derived on its own', async () => {
	const { env, statements, owner, org } = await setup()
	const grantProps = { userId: owner.stableUserId, orgId: org.id }

	await buildMcpAuthContextCached(env, { grantProps, accessToken: 'a' })
	statements.length = 0
	await buildMcpAuthContextCached(env, { grantProps, accessToken: 'b' })
	expect(statements.some((sql) => /FROM org_memberships/i.test(sql))).toBe(true)
	expect(mcpAuthCacheSizeForTests()).toBe(2)
})

test('an invite-link join shows up on the very next request and leaving removes the binding immediately', async () => {
	const { db, env, founder, joiner, org } = await setup()
	const grantProps = { userId: joiner.stableUserId, orgId: org.id }
	const token = 'token-joiner'
	const audit = createTestOrgAuditWriter()

	// Warm a "not a member" decision for the joiner's token first.
	expect(await loadBinding(env, grantProps, token)).toBeNull()
	expect(mcpAuthCacheSizeForTests()).toBe(1)

	const tokenHash = 'invite-link-token-hash'
	await createOrgInviteLink({
		db,
		orgId: org.id,
		target: { kind: 'membership', role: 'member' },
		createdByUserId: founder.stableUserId,
		tokenHash,
		audit,
	})
	const link = await getInviteLinkByTokenHash(db, tokenHash)
	if (!link) throw new Error('invite link missing')
	const redeemed = await redeemOrgInviteLink({
		db,
		env,
		link,
		user: {
			userId: joiner.stableUserId,
			email: joiner.email,
			emailVerified: true,
		},
		audit,
	})
	expect(redeemed).toMatchObject({ ok: true, alreadyMember: false })

	const joined = await loadBinding(env, grantProps, token)
	expect(joined?.role).toBe('member')
	expect(joined?.org.id).toBe(org.id)

	const left = await offboardOrgMember({
		appDb: db,
		env,
		orgId: ownerIdFromStored(String(org.id)),
		memberUserId: joiner.stableUserId,
		memberLeftVoluntarily: true,
	})
	expect(left.membershipSoftDeleted).toBe(true)
	expect(await loadBinding(env, grantProps, token)).toBeNull()
})

test('a direct grant binds an outside collaborator on the next request, revoking it unbinds, and team writes invalidate too', async () => {
	const { db, env, founder, joiner, org } = await setup()
	const grantProps = { userId: joiner.stableUserId, orgId: org.id }
	const token = 'token-collaborator'
	const audit = createTestOrgAuditWriter()

	expect(await loadBinding(env, grantProps, token)).toBeNull()

	const grant = await upsertGrant({
		db,
		orgId: org.id,
		resourceType: 'package',
		resourceId: crypto.randomUUID(),
		subject: { type: 'user', id: joiner.stableUserId },
		preset: 'use',
		permissions: null,
		createdByUserId: founder.stableUserId,
		audit,
	})
	const bound = await loadBinding(env, grantProps, token)
	expect(bound?.org.id).toBe(org.id)
	expect(bound?.role).toBeNull()

	await softDeleteGrant({
		db,
		orgId: org.id,
		grantId: grant.id,
		audit,
	})
	expect(await loadBinding(env, grantProps, token)).toBeNull()

	// Team membership is only open to live members; the write guard on `db`
	// fails this test if createTeam / addTeamMember / removeTeamMember stop
	// bumping access_epoch in their batch.
	await addOrgMember({
		db,
		orgId: org.id,
		userId: joiner.stableUserId,
		role: 'member',
		invitedByUserId: founder.stableUserId,
		audit,
	})
	const team = await createTeam({
		db,
		orgId: org.id,
		slug: 'contractors',
		name: 'Contractors',
		createdByUserId: founder.stableUserId,
		audit,
	})
	await addTeamMember({
		db,
		orgId: org.id,
		teamId: team.id,
		userId: joiner.stableUserId,
		addedByUserId: founder.stableUserId,
		audit,
	})
	expect((await loadBinding(env, grantProps, token))?.role).toBe('member')
	await removeTeamMember({
		db,
		orgId: org.id,
		teamId: team.id,
		userId: joiner.stableUserId,
		audit,
	})
	expect((await loadBinding(env, grantProps, token))?.role).toBe('member')
})

test('org soft-delete unbinds on the next request and restore does not revive the pre-delete entry', async () => {
	const { db, rawDb, env, sqlite, statements, founder, owner, org } =
		await setup()
	const grantProps = { userId: owner.stableUserId, orgId: org.id }
	const token = 'token-restore'

	expect((await loadBinding(env, grantProps, token))?.role).toBe('owner')
	const epochBefore = await db
		.prepare(`SELECT access_epoch FROM orgs WHERE id = ?`)
		.bind(org.id)
		.first<{ access_epoch: number }>()

	// The rows softDeleteOrg leaves behind: the org tombstone is stamped first,
	// then the membership graph is swept at the same deleted_at (no bump).
	const deletedAt = '2026-10-11T00:00:00.000Z'
	sqlite
		.prepare(`UPDATE orgs SET deleted_at = ? WHERE id = ?`)
		.run(deletedAt, org.id)
	sqlite
		.prepare(`UPDATE org_memberships SET deleted_at = ? WHERE org_id = ?`)
		.run(deletedAt, org.id)
	expect(await loadBinding(env, grantProps, token)).toBeNull()

	// restoreOrg revives teams/grants row by row after the org row (and bumps
	// again afterwards), so it runs outside the same-batch guard.
	await restoreOrg({
		env: { APP_DB: rawDb, AUDIT_DB: createAuditTestDb() } as Env,
		orgId: ownerIdFromStored(String(org.id)),
		actorUserId: founder.stableUserId,
		now: new Date('2026-10-12T00:00:00.000Z'),
	})
	const epochAfter = await db
		.prepare(`SELECT access_epoch FROM orgs WHERE id = ?`)
		.bind(org.id)
		.first<{ access_epoch: number }>()
	expect(Number(epochAfter?.access_epoch)).toBeGreaterThan(
		Number(epochBefore?.access_epoch),
	)

	statements.length = 0
	expect((await loadBinding(env, grantProps, token))?.role).toBe('owner')
	// Recomputed from the normalized tables, not served from the old entry.
	expect(statements.some((sql) => /FROM org_memberships/i.test(sql))).toBe(true)
})
