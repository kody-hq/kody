import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { withAccessEpochWriteGuard } from '#worker/test-support/access-epoch-write-guard.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

const mocks = vi.hoisted(() => ({
	syncSeatsAfterMembershipChange: vi.fn(),
}))

vi.mock('#worker/orgs/seat-sync-after-membership.ts', () => ({
	syncSeatsAfterMembershipChange: (...args: Array<unknown>) =>
		mocks.syncSeatsAfterMembershipChange(...args),
}))

const {
	createOrgInviteLink,
	generateInviteLinkToken,
	getInviteLinkByTokenHash,
	hashInviteLinkToken,
	listActiveOrgInviteLinks,
	revokeOrgInviteLink,
} = await import('./invite-links.ts')
const {
	inviteLinkAlreadySatisfied,
	inviteLinkTargetBlock,
	redeemOrgInviteLink,
} = await import('./invite-link-redeem.ts')
const { listPendingInviteLinksForPerson, recordInviteLinkPending } =
	await import('./invite-link-pending.ts')
const { upsertGrant } = await import('./access-writes.ts')

type Target = Parameters<typeof createOrgInviteLink>[0]['target']

const owner = { id: 1, personId: 'a'.repeat(64) }
const joiner = { id: 2, personId: 'b'.repeat(64) }
const now = '2026-01-01T00:00:00.000Z'

let sqlite: DatabaseSync
let db: D1Database
let auditDb: D1Database
let teamOrgId = ''

async function seed() {
	sqlite = new DatabaseSync(':memory:')
	db = createD1FromSqlite(sqlite)
	auditDb = createAuditTestDb()
	await ensureOrgsTestSchema(db)
	await ensureUsersTestSchema({
		db,
		columns: ['email_verified_at', 'avatar_key'],
	})
	sqlite.exec(
		`CREATE TABLE IF NOT EXISTS saved_packages (
			id TEXT PRIMARY KEY NOT NULL,
			name TEXT,
			kody_id TEXT,
			user_id TEXT,
			deleted_at TEXT
		)`,
	)
	for (const [username, person, email] of [
		['ada', owner, 'ada@example.com'],
		['bob', joiner, 'bob@partner.org'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO users (
					id, username, email, password_hash, stable_user_id,
					display_name, email_verified_at
				 ) VALUES (?, ?, ?, 'x', ?, ?, ?)`,
			)
			.run(person.id, username, email, person.personId, username, now)
		await provisionPersonalOrg(db, {
			stableUserId: person.personId,
			username,
			createdAt: now,
		})
	}
	db = withAccessEpochWriteGuard(db)
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: owner.personId,
			audit: createTestOrgAuditWriter({ db: auditDb }),
			slug: 'agency-co',
			displayName: 'Agency Co',
		},
	)
	if (!created.ok) throw new Error(created.error)
	teamOrgId = (await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'agency-co'`)
		.first<{ id: string }>())!.id
	sqlite
		.prepare(
			`INSERT INTO teams (id, org_id, slug, name, created_at, updated_at)
			 VALUES ('team-design', ?, 'design', 'Design', ?, ?)`,
		)
		.run(teamOrgId, now, now)
	sqlite
		.prepare(
			`INSERT INTO saved_packages (id, name, kody_id, user_id)
			 VALUES ('pkg-weather', 'Weather', 'weather', ?)`,
		)
		.run(owner.personId)
	sqlite
		.prepare(
			`INSERT INTO saved_packages (id, name, kody_id, user_id)
			 VALUES ('pkg-team', 'Team Tool', 'team-tool', ?)`,
		)
		.run(teamOrgId)
}

function audit(actorUserId = owner.personId) {
	return createTestOrgAuditWriter({ db: auditDb, appDb: db, actorUserId })
}

async function createLink(orgId: string, target: Target, maxUses?: number) {
	const token = generateInviteLinkToken()
	const tokenHash = await hashInviteLinkToken(token)
	const created = await createOrgInviteLink({
		db,
		orgId,
		target,
		createdByUserId: owner.personId,
		tokenHash,
		maxUses,
		audit: audit(),
	})
	const link = (await getInviteLinkByTokenHash(db, tokenHash))!
	return { ...created, token, tokenHash, link }
}

async function redeemAsJoiner(tokenHash: string) {
	const link = (await getInviteLinkByTokenHash(db, tokenHash))!
	return await redeemOrgInviteLink({
		db,
		env: { APP_DB: db } as Env,
		link,
		user: {
			userId: joiner.personId,
			email: 'bob@partner.org',
			emailVerified: true,
		},
		audit: audit(joiner.personId),
	})
}

async function joinerGrant(orgId: string, packageId: string) {
	const grant = await db
		.prepare(
			`SELECT id, preset FROM grants
			 WHERE org_id = ? AND resource_id = ? AND subject_id = ?
			   AND deleted_at IS NULL`,
		)
		.bind(orgId, packageId, joiner.personId)
		.first<{ id: string; preset: string | null }>()
	if (!grant) return null
	const permissions = await db
		.prepare(
			`SELECT permission FROM grant_permissions WHERE grant_id = ? ORDER BY permission`,
		)
		.bind(grant.id)
		.all<{ permission: string }>()
	return {
		preset: grant.preset,
		permissions: (permissions.results ?? []).map((row) => row.permission),
	}
}

async function joinerMembership(orgId: string) {
	return await db
		.prepare(
			`SELECT role FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(orgId, joiner.personId)
		.first<{ role: string }>()
}

beforeEach(async () => {
	mocks.syncSeatsAfterMembershipChange.mockClear()
	await seed()
})

test('a team link adds the person to the org as Member and to the team', async () => {
	const { tokenHash, link } = await createLink(teamOrgId, {
		kind: 'team',
		teamId: 'team-design',
	})
	expect(link.target).toEqual({ kind: 'team', teamId: 'team-design' })
	expect(await redeemAsJoiner(tokenHash)).toMatchObject({
		ok: true,
		alreadyMember: false,
		role: 'member',
		target: { kind: 'team', teamId: 'team-design' },
	})
	expect((await joinerMembership(teamOrgId))?.role).toBe('member')
	const onTeam = await db
		.prepare(
			`SELECT 1 AS ok FROM team_members
			 WHERE team_id = 'team-design' AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(joiner.personId)
		.first<{ ok: number }>()
	expect(onTeam?.ok).toBe(1)
	expect(mocks.syncSeatsAfterMembershipChange).toHaveBeenCalled()
	expect(await inviteLinkAlreadySatisfied(db, link, joiner.personId)).toBe(true)
	expect(await redeemAsJoiner(tokenHash)).toMatchObject({
		ok: true,
		alreadyMember: true,
	})
	const joined = await auditDb
		.prepare(
			`SELECT details_json FROM org_audit_events
			 WHERE org_id = ? AND action = 'invite_link.joined'`,
		)
		.bind(teamOrgId)
		.first<{ details_json: string }>()
	expect(JSON.parse(joined?.details_json ?? '{}')).toMatchObject({
		kind: 'team',
		teamId: 'team-design',
		joinedOrg: true,
	})
})

test('a team link is spent once per person', async () => {
	const { tokenHash } = await createLink(teamOrgId, {
		kind: 'team',
		teamId: 'team-design',
	})
	expect(await redeemAsJoiner(tokenHash)).toMatchObject({ ok: true })
	sqlite
		.prepare(
			`UPDATE team_members SET deleted_at = ? WHERE team_id = 'team-design' AND user_id = ?`,
		)
		.run(now, joiner.personId)
	expect(await redeemAsJoiner(tokenHash)).toMatchObject({
		ok: false,
		reason: 'already_used',
	})
})

test('personal orgs cannot make team links but can share a package', async () => {
	await expect(
		createLink(owner.personId, { kind: 'team', teamId: 'team-design' }),
	).rejects.toThrow(/personal organization/)
	const { tokenHash, link } = await createLink(owner.personId, {
		kind: 'resource',
		resourceType: 'package',
		resourceId: 'pkg-weather',
		preset: 'use',
	})
	expect(await inviteLinkTargetBlock(db, link)).toBeNull()
	expect(await redeemAsJoiner(tokenHash)).toMatchObject({
		ok: true,
		alreadyMember: false,
		role: null,
	})
	expect(await joinerGrant(owner.personId, 'pkg-weather')).toMatchObject({
		preset: 'use',
	})
	expect(await joinerMembership(owner.personId)).toBeNull()
	const joined = await auditDb
		.prepare(
			`SELECT details_json FROM org_audit_events
			 WHERE org_id = ? AND action = 'invite_link.joined'`,
		)
		.bind(owner.personId)
		.first<{ details_json: string }>()
	expect(JSON.parse(joined?.details_json ?? '{}')).toMatchObject({
		kind: 'resource',
		resourceId: 'pkg-weather',
		preset: 'use',
		outsideCollaborator: true,
	})
})

test('a package link never lowers access the person already has', async () => {
	await upsertGrant({
		db,
		orgId: teamOrgId,
		resourceType: 'package',
		resourceId: 'pkg-team',
		family: 'package',
		subject: { type: 'user', id: joiner.personId },
		preset: 'manage',
		permissions: null,
		createdByUserId: owner.personId,
		audit: audit(),
	})
	const before = await joinerGrant(teamOrgId, 'pkg-team')
	const { tokenHash, link } = await createLink(teamOrgId, {
		kind: 'resource',
		resourceType: 'package',
		resourceId: 'pkg-team',
		preset: 'use',
	})
	expect(await inviteLinkAlreadySatisfied(db, link, joiner.personId)).toBe(true)
	expect(await redeemAsJoiner(tokenHash)).toMatchObject({
		ok: true,
		alreadyMember: true,
	})
	expect(await joinerGrant(teamOrgId, 'pkg-team')).toEqual(before)
	expect((await getInviteLinkByTokenHash(db, tokenHash))?.useCount).toBe(0)
})

test('a package link raises a lower grant to its preset', async () => {
	await upsertGrant({
		db,
		orgId: teamOrgId,
		resourceType: 'package',
		resourceId: 'pkg-team',
		family: 'package',
		subject: { type: 'user', id: joiner.personId },
		preset: 'use',
		permissions: null,
		createdByUserId: owner.personId,
		audit: audit(),
	})
	const { tokenHash } = await createLink(teamOrgId, {
		kind: 'resource',
		resourceType: 'package',
		resourceId: 'pkg-team',
		preset: 'contribute',
	})
	expect(await redeemAsJoiner(tokenHash)).toMatchObject({
		ok: true,
		alreadyMember: false,
	})
	expect(await joinerGrant(teamOrgId, 'pkg-team')).toMatchObject({
		preset: 'contribute',
	})
})

test('links for a missing or deleted package stop working', async () => {
	await expect(
		createLink(teamOrgId, {
			kind: 'resource',
			resourceType: 'package',
			resourceId: 'pkg-weather',
			preset: 'use',
		}),
	).rejects.toThrow(/package was not found/)
	const { tokenHash, link } = await createLink(teamOrgId, {
		kind: 'resource',
		resourceType: 'package',
		resourceId: 'pkg-team',
		preset: 'use',
	})
	sqlite
		.prepare(`UPDATE saved_packages SET deleted_at = ? WHERE id = 'pkg-team'`)
		.run(now)
	expect(await inviteLinkTargetBlock(db, link)).toBe('target_gone')
	expect(await redeemAsJoiner(tokenHash)).toMatchObject({
		ok: false,
		reason: 'target_gone',
	})
})

test('each management page lists and revokes only its own links', async () => {
	const membership = await createLink(teamOrgId, {
		kind: 'membership',
		role: 'member',
	})
	const team = await createLink(teamOrgId, {
		kind: 'team',
		teamId: 'team-design',
	})
	const pkg = await createLink(
		teamOrgId,
		{
			kind: 'resource',
			resourceType: 'package',
			resourceId: 'pkg-team',
			preset: 'use',
		},
		1,
	)
	expect(
		(await listActiveOrgInviteLinks(db, teamOrgId)).map((link) => link.id),
	).toEqual([membership.id])
	expect(
		(
			await listActiveOrgInviteLinks(db, teamOrgId, undefined, {
				kind: 'team',
			})
		).map((link) => link.id),
	).toEqual([team.id])
	const packageScope = {
		kind: 'resource',
		resourceType: 'package',
		resourceId: 'pkg-team',
	} as const
	expect(
		(
			await listActiveOrgInviteLinks(db, teamOrgId, undefined, packageScope)
		).map((link) => link.id),
	).toEqual([pkg.id])
	await expect(
		revokeOrgInviteLink({
			db,
			orgId: teamOrgId,
			linkId: pkg.id,
			audit: audit(),
		}),
	).rejects.toThrow(/could not be revoked/)
	await revokeOrgInviteLink({
		db,
		orgId: teamOrgId,
		linkId: pkg.id,
		scope: packageScope,
		audit: audit(),
	})
	expect(
		await listActiveOrgInviteLinks(db, teamOrgId, undefined, packageScope),
	).toEqual([])
})

test('opened links wait for the person until they stop working', async () => {
	const pkg = await createLink(teamOrgId, {
		kind: 'resource',
		resourceType: 'package',
		resourceId: 'pkg-team',
		preset: 'contribute',
	})
	const team = await createLink(teamOrgId, {
		kind: 'team',
		teamId: 'team-design',
	})
	await recordInviteLinkPending({
		db,
		linkId: pkg.id,
		userId: joiner.personId,
	})
	await recordInviteLinkPending({
		db,
		linkId: team.id,
		userId: joiner.personId,
	})
	const pending = await listPendingInviteLinksForPerson(db, {
		userId: joiner.personId,
		now: new Date().toISOString(),
	})
	expect(pending).toHaveLength(2)
	expect(pending.find((row) => row.linkId === pkg.id)).toMatchObject({
		orgSlug: 'agency-co',
		orgPersonal: false,
		packageName: 'Team Tool',
		target: { kind: 'resource', preset: 'contribute' },
	})
	expect(pending.find((row) => row.linkId === team.id)).toMatchObject({
		teamName: 'Design',
	})
	await revokeOrgInviteLink({
		db,
		orgId: teamOrgId,
		linkId: team.id,
		scope: { kind: 'team' },
		audit: audit(),
	})
	expect(
		(
			await listPendingInviteLinksForPerson(db, {
				userId: joiner.personId,
				now: new Date().toISOString(),
			})
		).map((row) => row.linkId),
	).toEqual([pkg.id])
})

function demoteOwnerToMember() {
	sqlite
		.prepare(
			`UPDATE org_memberships SET role = 'member' WHERE org_id = ? AND user_id = ?`,
		)
		.run(teamOrgId, owner.personId)
}

test('links stop working when their creator can no longer share', async () => {
	const team = await createLink(teamOrgId, {
		kind: 'team',
		teamId: 'team-design',
	})
	const pkg = await createLink(teamOrgId, {
		kind: 'resource',
		resourceType: 'package',
		resourceId: 'pkg-team',
		preset: 'use',
	})
	for (const linkId of [team.id, pkg.id]) {
		await recordInviteLinkPending({ db, linkId, userId: joiner.personId })
	}
	demoteOwnerToMember()

	expect(await redeemAsJoiner(team.tokenHash)).toMatchObject({
		ok: false,
		reason: 'inviter_gone',
	})
	expect(await redeemAsJoiner(pkg.tokenHash)).toMatchObject({
		ok: false,
		reason: 'inviter_gone',
	})
	expect(
		await listPendingInviteLinksForPerson(db, {
			userId: joiner.personId,
			now: new Date().toISOString(),
		}),
	).toEqual([])

	await upsertGrant({
		db,
		orgId: teamOrgId,
		resourceType: 'package',
		resourceId: 'pkg-team',
		family: 'package',
		subject: { type: 'user', id: owner.personId },
		preset: 'manage',
		permissions: null,
		createdByUserId: owner.personId,
		audit: audit(),
	})
	expect(
		(
			await listPendingInviteLinksForPerson(db, {
				userId: joiner.personId,
				now: new Date().toISOString(),
			})
		).map((row) => row.linkId),
	).toEqual([pkg.id])
	expect(await redeemAsJoiner(pkg.tokenHash)).toMatchObject({ ok: true })
	expect(await redeemAsJoiner(team.tokenHash)).toMatchObject({
		ok: false,
		reason: 'inviter_gone',
	})
})

test('a failed access write gives the link use back', async () => {
	const { tokenHash } = await createLink(
		teamOrgId,
		{
			kind: 'resource',
			resourceType: 'package',
			resourceId: 'pkg-team',
			preset: 'use',
		},
		1,
	)
	sqlite.exec(
		`CREATE TRIGGER fail_grants BEFORE INSERT ON grants
		 BEGIN SELECT RAISE(ABORT, 'grant write failed'); END`,
	)
	await expect(redeemAsJoiner(tokenHash)).rejects.toThrow(/grant write failed/)
	expect((await getInviteLinkByTokenHash(db, tokenHash))?.useCount).toBe(0)
	sqlite.exec(`DROP TRIGGER fail_grants`)
	expect(await redeemAsJoiner(tokenHash)).toMatchObject({
		ok: true,
		alreadyMember: false,
	})
	expect(await joinerGrant(teamOrgId, 'pkg-team')).toMatchObject({
		preset: 'use',
	})
})

test('a package link with the Read preset grants package:read only', async () => {
	const { tokenHash, link } = await createLink(owner.personId, {
		kind: 'resource',
		resourceType: 'package',
		resourceId: 'pkg-weather',
		preset: 'read',
	})
	expect(await inviteLinkTargetBlock(db, link)).toBeNull()
	expect(await redeemAsJoiner(tokenHash)).toMatchObject({ ok: true })
	expect(await joinerGrant(owner.personId, 'pkg-weather')).toMatchObject({
		preset: 'read',
	})
})
