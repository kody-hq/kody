import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { createInvite } from '#worker/orgs/access-writes.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	syncSeatsAfterMembershipChange: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))
vi.mock('#worker/orgs/seat-sync-after-membership.ts', () => ({
	syncSeatsAfterMembershipChange: (...args: Array<unknown>) =>
		mocks.syncSeatsAfterMembershipChange(...args),
}))

const { acceptWebsiteInvite, declineWebsiteInvite } =
	await import('./account-invites.ts')
const { listPendingInvitesForViewer } =
	await import('#app/account-organizations-data.ts')

const owner = { id: 1, personId: 'a'.repeat(64), username: 'ada' }
const joiner = { id: 2, personId: 'b'.repeat(64), username: 'bob' }

let sqlite: DatabaseSync
let db: D1Database
let auditDb: D1Database
let teamOrgId = ''

function createEnv() {
	return { APP_DB: db, AUDIT_DB: auditDb } as Env
}

function audit() {
	return createTestOrgAuditWriter({ db: auditDb })
}

async function seed() {
	sqlite = new DatabaseSync(':memory:')
	db = createD1FromSqlite(sqlite)
	auditDb = createAuditTestDb()
	await ensureOrgsTestSchema(db)
	await ensureUsersTestSchema({
		db,
		columns: ['email_verified_at', 'avatar_key'],
	})
	const now = '2026-01-01T00:00:00.000Z'
	for (const person of [owner, joiner]) {
		sqlite
			.prepare(
				`INSERT INTO users (
					id, username, email, password_hash, stable_user_id,
					display_name, email_verified_at
				 ) VALUES (?, ?, ?, 'x', ?, ?, ?)`,
			)
			.run(
				person.id,
				person.username,
				`${person.username}@example.com`,
				person.personId,
				person.username,
				now,
			)
		await provisionPersonalOrg(db, {
			stableUserId: person.personId,
			username: person.username,
			createdAt: now,
		})
	}
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: owner.personId,
			audit: audit(),
			slug: 'zeta-works',
			displayName: 'Zeta Works',
		},
	)
	if (!created.ok) throw new Error(created.error)
	teamOrgId = (await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'zeta-works'`)
		.first<{ id: string }>())!.id
	sqlite.exec(
		`CREATE TABLE IF NOT EXISTS saved_packages (
			id TEXT PRIMARY KEY NOT NULL,
			name TEXT,
			kody_id TEXT,
			user_id TEXT,
			deleted_at TEXT
		)`,
	)
	sqlite
		.prepare(
			`INSERT INTO saved_packages (id, name, kody_id, user_id)
			 VALUES ('pkg-weather', 'Weather', 'weather', ?)`,
		)
		.run(owner.personId)
}

async function inviteJoinerToTeamOrg(options: { byEmail?: boolean } = {}) {
	const created = await createInvite({
		db,
		orgId: teamOrgId,
		kind: 'membership',
		role: 'member',
		inviteeEmail: options.byEmail === false ? null : 'bob@example.com',
		inviteeUsername: options.byEmail === false ? 'bob' : null,
		invitedByUserId: owner.personId,
		tokenHash: crypto.randomUUID(),
		audit: audit(),
	})
	return created.id
}

async function inviteJoinerToPackage() {
	const created = await createInvite({
		db,
		orgId: owner.personId,
		kind: 'grant',
		resourceType: 'package',
		resourceId: 'pkg-weather',
		preset: 'contribute',
		inviteeUsername: 'bob',
		invitedByUserId: owner.personId,
		tokenHash: crypto.randomUUID(),
		audit: audit(),
	})
	return created.id
}

function signIn(
	person: typeof owner,
	options: { emailVerified?: boolean } = {},
) {
	const personId = personIdFromStored(person.personId)
	const email = `${person.username}@example.com`
	const user = {
		userId: person.id,
		username: person.username,
		email,
		emailVerified: options.emailVerified ?? true,
		mcpUser: {
			userId: personId,
			username: person.username,
			email,
			displayName: person.username,
		},
		request: deriveRequestContext({
			user: { userId: personId, username: person.username },
			source: { kind: 'session' },
			orgBinding: {
				org: {
					id: ownerIdFromStored(person.personId),
					slug: person.username,
				},
				role: 'owner',
			},
		}),
	} as AuthenticatedAppUser
	mocks.readAuthenticatedAppUser.mockResolvedValue(user)
	return user
}

async function post(
	action: 'accept' | 'decline',
	inviteId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const create =
		action === 'accept' ? acceptWebsiteInvite : declineWebsiteInvite
	const response = await create({
		env: createEnv(),
		user: await mocks.readAuthenticatedAppUser(),
		request: new Request(
			`https://kody.test/account/organizations/invites/${inviteId}/${action}.json`,
			{ method: 'POST' },
		),
		inviteId,
	})
	return {
		status: response.status,
		body: response.data,
	}
}

function inviteStatus(inviteId: string) {
	return (
		sqlite.prepare(`SELECT status FROM invites WHERE id = ?`).get(inviteId) as {
			status: string
		}
	).status
}

beforeEach(async () => {
	mocks.readAuthenticatedAppUser.mockReset()
	mocks.syncSeatsAfterMembershipChange.mockClear()
	await seed()
})

test('addressed invites wait on the recipient with plain labels', async () => {
	const membershipId = await inviteJoinerToTeamOrg()
	const packageId = await inviteJoinerToPackage()
	const user = signIn(joiner)
	const pending = await listPendingInvitesForViewer(createEnv(), user)
	expect(pending).toEqual(
		expect.arrayContaining([
			{
				source: 'invite',
				id: membershipId,
				orgSlug: 'zeta-works',
				orgDisplayName: 'Zeta Works',
				orgPersonal: false,
				label: 'Join as Member',
				expiresAt: expect.any(String),
			},
			{
				source: 'invite',
				id: packageId,
				orgSlug: 'ada',
				orgDisplayName: null,
				orgPersonal: true,
				label: 'Contribute access to Weather',
				expiresAt: expect.any(String),
			},
		]),
	)
	expect(pending).toHaveLength(2)
	expect(await listPendingInvitesForViewer(createEnv(), signIn(owner))).toEqual(
		[],
	)
})

test('accepting an addressed membership invite joins the org', async () => {
	const inviteId = await inviteJoinerToTeamOrg()
	signIn(joiner)
	expect(await post('accept', inviteId)).toEqual({
		status: 200,
		body: { ok: true, redirectTo: '/@zeta-works' },
	})
	expect(inviteStatus(inviteId)).toBe('accepted')
	expect(
		sqlite
			.prepare(
				`SELECT role FROM org_memberships
				 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
			)
			.get(teamOrgId, joiner.personId),
	).toEqual({ role: 'member' })
	expect(mocks.syncSeatsAfterMembershipChange).toHaveBeenCalled()
	expect((await post('accept', inviteId)).body).toMatchObject({
		ok: false,
		error: 'This invite was already accepted.',
	})
})

test('accepting a package invite grants the preset and opens the package', async () => {
	const inviteId = await inviteJoinerToPackage()
	signIn(joiner)
	expect(await post('accept', inviteId)).toEqual({
		status: 200,
		body: { ok: true, redirectTo: '/@ada/weather' },
	})
	expect(
		sqlite
			.prepare(
				`SELECT preset FROM grants
				 WHERE resource_id = 'pkg-weather' AND subject_id = ?`,
			)
			.get(joiner.personId),
	).toEqual({ preset: 'contribute' })
})

test('declining closes the invite and records who declined', async () => {
	const inviteId = await inviteJoinerToTeamOrg()
	const user = signIn(joiner)
	expect(await post('decline', inviteId)).toEqual({
		status: 200,
		body: { ok: true },
	})
	expect(inviteStatus(inviteId)).toBe('revoked')
	expect(await listPendingInvitesForViewer(createEnv(), user)).toEqual([])
	expect(
		await auditDb
			.prepare(
				`SELECT action, target_user_id FROM org_audit_events
				 WHERE resource_id = ? ORDER BY created_at, rowid`,
			)
			.bind(inviteId)
			.all(),
	).toMatchObject({
		results: [
			{ action: 'invite.created' },
			{ action: 'invite.declined', target_user_id: joiner.personId },
		],
	})
	expect((await post('accept', inviteId)).body).toMatchObject({
		ok: false,
		error: 'This invite was revoked.',
	})
})

test('only the recipient can answer, and an email invite needs a verified email', async () => {
	const emailInvite = await inviteJoinerToTeamOrg()
	signIn(owner)
	expect(await post('accept', emailInvite)).toMatchObject({
		status: 400,
		body: {
			ok: false,
			error: 'This invite is addressed to a different email or username.',
		},
	})
	expect(await post('decline', emailInvite)).toMatchObject({ status: 400 })

	signIn(joiner, { emailVerified: false })
	expect(await post('accept', emailInvite)).toEqual({
		status: 403,
		body: { ok: false, error: 'Verify your email to answer this invite.' },
	})
	expect(inviteStatus(emailInvite)).toBe('pending')

	const usernameInvite = await inviteJoinerToTeamOrg({ byEmail: false })
	expect((await post('decline', usernameInvite)).status).toBe(200)

	expect(await post('accept', 'missing-invite')).toMatchObject({
		status: 404,
	})
})
