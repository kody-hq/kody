import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import {
	createOrgInviteLink,
	generateInviteLinkToken,
	hashInviteLinkToken,
} from '#worker/orgs/invite-links.ts'
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

const {
	acceptWebsiteInviteLink,
	declineWebsiteInviteLink,
	loadJoinPageData,
	joinWebsiteOrganization,
} = await import('./org-invite-join.ts')

const owner = { id: 1, personId: 'a'.repeat(64) }
const joiner = { id: 2, personId: 'b'.repeat(64) }

let sqlite: DatabaseSync
let db: D1Database
let auditDb: D1Database
let orgId = ''
let token = ''

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
	for (const [username, person, email] of [
		['ada', owner, 'ada@example.com'],
		['bob', joiner, 'bob@example.com'],
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
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: owner.personId,
			audit: createTestOrgAuditWriter({ db: auditDb }),
			slug: 'join-co',
			displayName: 'Join Co',
		},
	)
	if (!created.ok) throw new Error(created.error)
	orgId = (await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'join-co'`)
		.first<{ id: string }>())!.id
	token = generateInviteLinkToken()
	await createOrgInviteLink({
		db,
		orgId,
		target: { kind: 'membership', role: 'member' },
		createdByUserId: owner.personId,
		tokenHash: await hashInviteLinkToken(token),
		audit: createTestOrgAuditWriter({ db: auditDb }),
	})
}

function createEnv() {
	return { APP_DB: db, AUDIT_DB: auditDb } as Env
}

function signInJoiner(emailVerified = true) {
	const personId = personIdFromStored(joiner.personId)
	const user = {
		userId: joiner.id,
		username: 'bob',
		email: 'bob@example.com',
		emailVerified,
		mcpUser: {
			userId: personId,
			username: 'bob',
			email: 'bob@example.com',
			displayName: 'bob',
		},
		request: deriveRequestContext({
			user: { userId: personId, username: 'bob' },
			source: { kind: 'session' },
			orgBinding: {
				org: { id: ownerIdFromStored(joiner.personId), slug: 'bob' },
				role: 'owner',
			},
		}),
	} as AuthenticatedAppUser
	mocks.readAuthenticatedAppUser.mockResolvedValue(user)
}

beforeEach(async () => {
	mocks.readAuthenticatedAppUser.mockReset()
	mocks.syncSeatsAfterMembershipChange.mockClear()
	await seed()
})

test('join page shows org confirmation without members for a valid link', async () => {
	mocks.readAuthenticatedAppUser.mockResolvedValue(null)
	const response = await readJoin({
		env: createEnv(),
		user: await mocks.readAuthenticatedAppUser(),
		request: new Request(`https://kody.test/join/${token}`),
		token,
	})
	expect(response.status).toBe(200)
	const body = response.data as {
		orgInviteJoin: {
			ok: true
			org: { slug: string; displayName: string | null }
			authenticated: boolean
			alreadyMember: boolean
		}
	}
	expect(body.orgInviteJoin).toMatchObject({
		ok: true,
		org: { slug: 'join-co', displayName: 'Join Co' },
		authenticated: false,
		alreadyMember: false,
	})
	expect(JSON.stringify(body)).not.toContain(owner.personId)
	expect(JSON.stringify(body)).not.toContain('ada@example.com')
})

test('join post adds the member and returns the org redirect', async () => {
	signInJoiner(true)
	const response = await joinWebsiteOrganization({
		env: createEnv(),
		user: await mocks.readAuthenticatedAppUser(),
		request: new Request(`https://kody.test/join/${token}`, {
			method: 'POST',
		}),
		token,
	})
	expect(response.status).toBe(200)
	expect(response.data).toMatchObject({
		ok: true,
		alreadyMember: false,
		orgSlug: 'join-co',
		redirectTo: '/@join-co',
	})
	expect(mocks.syncSeatsAfterMembershipChange).toHaveBeenCalled()
})

test('expired links show a clear error on the join page', async () => {
	sqlite
		.prepare(
			`UPDATE org_invite_links SET expires_at = '2020-01-01T00:00:00.000Z'`,
		)
		.run()
	mocks.readAuthenticatedAppUser.mockResolvedValue(null)
	const response = await readJoin({
		env: createEnv(),
		user: await mocks.readAuthenticatedAppUser(),
		request: new Request(`https://kody.test/join/${token}`),
		token,
	})
	expect(response.status).toBe(400)
	expect(response.data).toMatchObject({
		orgInviteJoin: {
			ok: false,
			reason: 'expired',
			error: 'This invite link has expired.',
		},
	})
})

async function createPackageLink(options: { maxUses?: number } = {}) {
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
	const packageToken = generateInviteLinkToken()
	const created = await createOrgInviteLink({
		db,
		orgId: owner.personId,
		target: {
			kind: 'resource',
			resourceType: 'package',
			resourceId: 'pkg-weather',
			preset: 'contribute',
		},
		createdByUserId: owner.personId,
		tokenHash: await hashInviteLinkToken(packageToken),
		maxUses: options.maxUses ?? null,
		audit: createTestOrgAuditWriter({ db: auditDb }),
	})
	return { token: packageToken, id: created.id }
}

async function pendingRows() {
	return (
		await db
			.prepare(`SELECT link_id FROM org_invite_link_pending WHERE user_id = ?`)
			.bind(joiner.personId)
			.all<{ link_id: string }>()
	).results?.map((row) => row.link_id)
}

test('a package link page describes the access and waits for the viewer', async () => {
	const link = await createPackageLink()
	signInJoiner(true)
	const response = await readJoin({
		env: createEnv(),
		user: await mocks.readAuthenticatedAppUser(),
		request: new Request(`https://kody.test/join/${link.token}`, {
			headers: { Accept: 'application/json' },
		}),
		token: link.token,
	})
	expect(response.status).toBe(200)
	const body = response.data as { orgInviteJoin: unknown }
	expect(body.orgInviteJoin).toMatchObject({
		ok: true,
		org: { slug: 'ada', personal: true },
		offer: {
			kind: 'resource',
			packageName: 'Weather',
			packageHref: '/@ada/weather',
			preset: 'contribute',
			presetLabel: 'Contribute',
			outsideCollaborator: true,
		},
		invitedBy: 'ada',
		alreadyMember: false,
		authenticated: true,
	})
	expect(JSON.stringify(body)).not.toContain('pkg-weather')
	expect(await pendingRows()).toEqual([link.id])
	const grantsBefore = await db
		.prepare(`SELECT COUNT(*) AS count FROM grants WHERE subject_id = ?`)
		.bind(joiner.personId)
		.first<{ count: number }>()
	expect(grantsBefore?.count).toBe(0)
})

test('accepting from the Organizations page grants the package and clears the wait', async () => {
	const link = await createPackageLink()
	signInJoiner(true)
	await readJoin({
		env: createEnv(),
		user: await mocks.readAuthenticatedAppUser(),
		request: new Request(`https://kody.test/join/${link.token}`),
		token: link.token,
	})
	const response = await acceptWebsiteInviteLink({
		env: createEnv(),
		user: await mocks.readAuthenticatedAppUser(),
		request: new Request(
			`https://kody.test/account/organizations/invite-links/${link.id}/accept.json`,
			{ method: 'POST' },
		),
		linkId: link.id,
	})
	expect(response.status).toBe(200)
	expect(response.data).toMatchObject({
		ok: true,
		kind: 'resource',
		redirectTo: '/@ada/weather',
	})
	const grant = await db
		.prepare(
			`SELECT preset FROM grants WHERE subject_id = ? AND resource_id = 'pkg-weather'`,
		)
		.bind(joiner.personId)
		.first<{ preset: string }>()
	expect(grant?.preset).toBe('contribute')
	expect(await pendingRows()).toEqual([])
})

test('accepting by link id needs a pending row from opening the link', async () => {
	const link = await createPackageLink()
	signInJoiner(true)
	const response = await acceptWebsiteInviteLink({
		env: createEnv(),
		user: await mocks.readAuthenticatedAppUser(),
		request: new Request(
			`https://kody.test/account/organizations/invite-links/${link.id}/accept.json`,
			{ method: 'POST' },
		),
		linkId: link.id,
	})
	expect(response.status).toBe(400)
	expect(response.data).toMatchObject({ ok: false, reason: 'invalid' })
})

test('declining removes the waiting invite without using the link', async () => {
	const link = await createPackageLink()
	signInJoiner(true)
	await readJoin({
		env: createEnv(),
		user: await mocks.readAuthenticatedAppUser(),
		request: new Request(`https://kody.test/join/${link.token}`),
		token: link.token,
	})
	const response = await declineWebsiteInviteLink({
		env: createEnv(),
		user: await mocks.readAuthenticatedAppUser(),
		request: new Request(
			`https://kody.test/account/organizations/invite-links/${link.id}/decline.json`,
			{ method: 'POST' },
		),
		linkId: link.id,
	})
	expect(response.status).toBe(200)
	expect(await pendingRows()).toEqual([])
	const used = await db
		.prepare(`SELECT use_count FROM org_invite_links WHERE id = ?`)
		.bind(link.id)
		.first<{ use_count: number }>()
	expect(used?.use_count).toBe(0)
})

test('a spent package link says so instead of offering it again', async () => {
	const link = await createPackageLink()
	signInJoiner(true)
	await joinWebsiteOrganization({
		env: createEnv(),
		user: await mocks.readAuthenticatedAppUser(),
		request: new Request(`https://kody.test/join/${link.token}`, {
			method: 'POST',
		}),
		token: link.token,
	})
	sqlite
		.prepare(`UPDATE grants SET deleted_at = ? WHERE subject_id = ?`)
		.run('2026-02-01T00:00:00.000Z', joiner.personId)
	const response = await readJoin({
		env: createEnv(),
		user: await mocks.readAuthenticatedAppUser(),
		request: new Request(`https://kody.test/join/${link.token}`),
		token: link.token,
	})
	expect(response.status).toBe(400)
	expect(response.data).toMatchObject({
		orgInviteJoin: { ok: false, reason: 'already_used' },
	})
})

test('reopening a used-up package link you accepted shows your access', async () => {
	const link = await createPackageLink({ maxUses: 1 })
	signInJoiner(true)
	await joinWebsiteOrganization({
		env: createEnv(),
		user: await mocks.readAuthenticatedAppUser(),
		request: new Request(`https://kody.test/join/${link.token}`, {
			method: 'POST',
		}),
		token: link.token,
	})
	const reopen = async () =>
		readJoin({
			env: createEnv(),
			user: await mocks.readAuthenticatedAppUser(),
			request: new Request(`https://kody.test/join/${link.token}`),
			token: link.token,
		})
	const accepted = await reopen()
	expect(accepted.status).toBe(200)
	expect(accepted.data).toMatchObject({
		orgInviteJoin: { ok: true, alreadyMember: true },
	})
	expect(await pendingRows()).toEqual([])

	sqlite
		.prepare(`UPDATE grants SET deleted_at = ? WHERE subject_id = ?`)
		.run('2026-02-01T00:00:00.000Z', joiner.personId)
	const removed = await reopen()
	expect(removed.status).toBe(400)
	expect(removed.data).toMatchObject({
		orgInviteJoin: { ok: false, reason: 'already_used' },
	})

	mocks.readAuthenticatedAppUser.mockResolvedValue(null)
	const stranger = await reopen()
	expect(stranger.data).toMatchObject({
		orgInviteJoin: { ok: false, reason: 'exhausted' },
	})
})

test('reopening an accepted link after its creator lost access shows your access', async () => {
	const link = await createPackageLink()
	signInJoiner(true)
	await joinWebsiteOrganization({
		env: createEnv(),
		user: await mocks.readAuthenticatedAppUser(),
		request: new Request(`https://kody.test/join/${link.token}`, {
			method: 'POST',
		}),
		token: link.token,
	})
	sqlite
		.prepare(
			`UPDATE org_memberships SET role = 'member' WHERE org_id = ? AND user_id = ?`,
		)
		.run(owner.personId, owner.personId)
	sqlite
		.prepare(`UPDATE orgs SET access_epoch = access_epoch + 1 WHERE id = ?`)
		.run(owner.personId)
	const reopen = async () =>
		readJoin({
			env: createEnv(),
			user: await mocks.readAuthenticatedAppUser(),
			request: new Request(`https://kody.test/join/${link.token}`),
			token: link.token,
		})
	expect((await reopen()).data).toMatchObject({
		orgInviteJoin: { ok: true, alreadyMember: true },
	})

	mocks.readAuthenticatedAppUser.mockResolvedValue(null)
	expect((await reopen()).data).toMatchObject({
		orgInviteJoin: { ok: false, reason: 'inviter_gone' },
	})
})

async function readJoin(input: {
	env: Env
	request: Request
	token: string
	user: unknown
}) {
	const data = await loadJoinPageData(input)
	return { status: data.ok ? 200 : 400, data: { orgInviteJoin: data } }
}
