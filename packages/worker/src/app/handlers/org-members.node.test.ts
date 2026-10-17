import type * as OrgBilling from '#worker/orgs/billing.ts'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	requireAuthenticatedPageUser: vi.fn(),
	syncSeatsAfterMembershipChange: vi.fn(),
	assertCanAcceptFreeOrgOwnership: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))
vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (...args: Array<unknown>) =>
		mocks.requireAuthenticatedPageUser(...args),
}))
vi.mock('#worker/orgs/seat-sync-after-membership.ts', () => ({
	syncSeatsAfterMembershipChange: (...args: Array<unknown>) =>
		mocks.syncSeatsAfterMembershipChange(...args),
}))
vi.mock('#worker/orgs/billing.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof OrgBilling>()
	return {
		...actual,
		assertCanAcceptFreeOrgOwnership: (...args: Array<unknown>) =>
			mocks.assertCanAcceptFreeOrgOwnership(...args),
	}
})

const {
	testOrgMembersInviteRevokePostHandler,
	testOrgMembersApiHandler,
	testOrgMembersInviteLinksPostHandler,
	testOrgMembersInviteLinksRevokePostHandler,
	testOrgMembersInvitePostHandler,
	testOrgMembersRemovePostHandler,
	testOrgMembersRolePostHandler,
} = await import('./org-members.test-support.ts')

const people = {
	ada: { id: 9, personId: 'a'.repeat(64) },
	bob: { id: 10, personId: 'b'.repeat(64) },
	cara: { id: 11, personId: 'c'.repeat(64) },
	dan: { id: 12, personId: 'd'.repeat(64) },
} as const
type Person = keyof typeof people

let sqlite: DatabaseSync
let db: D1Database
let acmeId = ''

async function seed() {
	sqlite = new DatabaseSync(':memory:')
	db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	await ensureUsersTestSchema({ db, columns: ['avatar_key'] })
	const now = '2026-01-01T00:00:00.000Z'
	for (const [username, person] of Object.entries(people)) {
		sqlite
			.prepare(
				`INSERT INTO users (id, username, email, password_hash, stable_user_id, display_name)
				 VALUES (?, ?, ?, 'x', ?, ?)`,
			)
			.run(
				person.id,
				username,
				`${username}@example.com`,
				person.personId,
				username,
			)
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
			personId: people.ada.personId,
			audit: createTestOrgAuditWriter(),
			slug: 'zeta-co',
			displayName: 'Zeta Co',
		},
	)
	if (!created.ok) throw new Error(created.error)
	acmeId = (await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'zeta-co'`)
		.first<{ id: string }>())!.id
	for (const [person, role] of [
		['bob', 'member'],
		['cara', 'billing'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, ?, ?)`,
			)
			.run(acmeId, people[person].personId, role, now)
	}
	sqlite
		.prepare(
			`INSERT INTO grants (
			   id, org_id, resource_type, resource_id, subject_type, subject_id,
			   created_by_user_id, created_at, updated_at
			 ) VALUES ('grant-1', ?, 'package', 'pkg-1', 'user', ?, ?, ?, ?)`,
		)
		.run(acmeId, people.dan.personId, people.ada.personId, now, now)
}

function createEnv() {
	return { APP_DB: db, AUDIT_DB: createAuditTestDb() } as Env
}

async function signIn(person: Person, request: Request) {
	const slug = new URL(request.url).pathname.split('/')[1]?.slice(1) ?? person
	const binding = (await loadOrgBindingForSlug(
		db,
		people[person].personId,
		slug,
	)) ?? {
		org: {
			id: ownerIdFromStored(people[person].personId),
			slug: person,
		},
		role: 'owner' as const,
	}
	const user = {
		userId: people[person].id,
		username: person,
		email: `${person}@example.com`,
		mcpUser: {
			userId: personIdFromStored(people[person].personId),
			username: person,
			email: `${person}@example.com`,
			displayName: person,
		},
		request: deriveRequestContext({
			user: {
				userId: personIdFromStored(people[person].personId),
				username: person,
			},
			source: { kind: 'session' },
			orgBinding: binding,
		}),
	} as AuthenticatedAppUser
	mocks.readAuthenticatedAppUser.mockResolvedValue(user)
	mocks.requireAuthenticatedPageUser.mockResolvedValue(user)
}

beforeEach(async () => {
	mocks.readAuthenticatedAppUser.mockReset()
	mocks.requireAuthenticatedPageUser.mockReset()
	mocks.syncSeatsAfterMembershipChange.mockClear()
	await seed()
})

test('member reads are 404 for collaborators and readable by billing', async () => {
	const env = createEnv()
	const collab = new Request('https://kody.test/@zeta-co/-/members')
	await signIn('dan', collab)
	expect(
		(
			await testOrgMembersApiHandler(env).execute({
				request: collab,
			} as never)
		).status,
	).toBe(404)

	const billing = new Request('https://kody.test/@zeta-co/-/members')
	await signIn('cara', billing)
	const readable = await testOrgMembersApiHandler(env).execute({
		request: billing,
	} as never)
	expect(readable.status).toBe(200)
	const payload = readable.data as {
		canManage: boolean
		members: Array<{ username: string; role: string }>
	}
	expect(payload.canManage).toBe(false)
	expect(
		payload.members.map((member) => [member.username, member.role]),
	).toEqual([
		['ada', 'owner'],
		['bob', 'member'],
		['cara', 'billing'],
	])
})

test('member cannot change roles, invite, or remove; owner can; last owner is protected', async () => {
	const env = createEnv()
	const roleReq = new Request('https://kody.test/@zeta-co/-/members', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ userId: people.bob.personId, role: 'billing' }),
	})
	await signIn('bob', roleReq)
	expect(
		(
			await testOrgMembersRolePostHandler(env).execute({
				request: roleReq,
			} as never)
		).status,
	).toBe(403)

	const billingInvite = new Request('https://kody.test/@zeta-co/-/members', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ invitee: 'eve@example.com', role: 'member' }),
	})
	await signIn('cara', billingInvite)
	expect(
		(
			await testOrgMembersInvitePostHandler(env).execute({
				request: billingInvite,
			} as never)
		).status,
	).toBe(403)

	const invalidRoleInvite = new Request(
		'https://kody.test/@zeta-co/-/members',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ invitee: 'eve@example.com', role: 'admin' }),
		},
	)
	await signIn('ada', invalidRoleInvite)
	const rejectedRole = await testOrgMembersInvitePostHandler(env).execute({
		request: invalidRoleInvite,
	} as never)
	expect(rejectedRole.status).toBe(400)
	expect(rejectedRole.data).toMatchObject({
		ok: false,
		error: 'Choose a valid role.',
	})

	const ownerInvite = new Request('https://kody.test/@zeta-co/-/members', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ invitee: 'eve@example.com', role: 'member' }),
	})
	await signIn('ada', ownerInvite)
	const invited = await testOrgMembersInvitePostHandler(env).execute({
		request: ownerInvite,
	} as never)
	expect(invited.status).toBe(200)
	expect(invited.data).toMatchObject({
		ok: true,
		invite: { prompt: expect.stringContaining('inviteAccept') },
	})

	const ownerRole = new Request('https://kody.test/@zeta-co/-/members', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ userId: people.bob.personId, role: 'billing' }),
	})
	await signIn('ada', ownerRole)
	expect(
		(
			await testOrgMembersRolePostHandler(env).execute({
				request: ownerRole,
			} as never)
		).status,
	).toBe(200)

	const lastOwner = new Request('https://kody.test/@zeta-co/-/members', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ userId: people.ada.personId }),
	})
	await signIn('ada', lastOwner)
	const blocked = await testOrgMembersRemovePostHandler(env).execute({
		request: lastOwner,
	} as never)
	expect(blocked.status).toBe(400)
	expect(blocked.data).toMatchObject({
		error: 'The last Owner cannot be removed.',
	})
})

test('owner can create invite links; member and billing cannot; owner role is rejected', async () => {
	const env = createEnv()
	const billingCreate = new Request('https://kody.test/@zeta-co/-/members', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ role: 'member' }),
	})
	await signIn('cara', billingCreate)
	expect(
		(
			await testOrgMembersInviteLinksPostHandler(env).execute({
				request: billingCreate,
			} as never)
		).status,
	).toBe(403)

	const memberCreate = new Request('https://kody.test/@zeta-co/-/members', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ role: 'member' }),
	})
	await signIn('bob', memberCreate)
	expect(
		(
			await testOrgMembersInviteLinksPostHandler(env).execute({
				request: memberCreate,
			} as never)
		).status,
	).toBe(403)

	const ownerRole = new Request('https://kody.test/@zeta-co/-/members', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ role: 'owner' }),
	})
	await signIn('ada', ownerRole)
	const rejectedOwner = await testOrgMembersInviteLinksPostHandler(env).execute(
		{ request: ownerRole } as never,
	)
	expect(rejectedOwner.status).toBe(400)
	expect(rejectedOwner.data).toMatchObject({
		ok: false,
		error: 'Invite links cannot grant the Owner role.',
	})

	const create = new Request('https://kody.test/@zeta-co/-/members', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			role: 'member',
			allowedEmailDomains: 'example.com',
			maxUses: 3,
			expiresInDays: 7,
		}),
	})
	await signIn('ada', create)
	const created = await testOrgMembersInviteLinksPostHandler(env).execute({
		request: create,
	} as never)
	expect(created.status).toBe(200)
	const payload = created.data as {
		ok: boolean
		inviteLink: { id: string; url: string; token: string }
	}
	expect(payload.ok).toBe(true)
	expect(payload.inviteLink.url).toContain('/join/')
	expect(payload.inviteLink.url).toContain(payload.inviteLink.token)
	expect(created.data).not.toHaveProperty('inviteLinks')
	expect(
		(await testOrgMembersApiHandler(env).execute({ request: create } as never))
			.data,
	).toMatchObject({
		inviteLinks: [expect.objectContaining({ id: payload.inviteLink.id })],
	})

	const revoke = new Request('https://kody.test/@zeta-co/-/members', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ linkId: payload.inviteLink.id }),
	})
	await signIn('ada', revoke)
	const revoked = await testOrgMembersInviteLinksRevokePostHandler(env).execute(
		{ request: revoke } as never,
	)
	expect(revoked.status).toBe(200)
	expect(revoked.data).toEqual({ ok: true })
	expect(
		(await testOrgMembersApiHandler(env).execute({ request: revoke } as never))
			.data,
	).toMatchObject({ inviteLinks: [] })
})

test('signup org membership writes stay off the web even for a second owner', async () => {
	const env = createEnv()
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', ?)`,
		)
		.run(people.ada.personId, people.bob.personId, '2026-01-02T00:00:00.000Z')

	const list = new Request('https://kody.test/@ada/-/members')
	await signIn('bob', list)
	expect(
		await (
			await testOrgMembersApiHandler(env).execute({ request: list } as never)
		).data,
	).toMatchObject({
		ok: true,
		org: { personal: true },
		canManage: false,
	})

	const invite = new Request('https://kody.test/@ada/-/members', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ invitee: 'eve@example.com', role: 'member' }),
	})
	await signIn('bob', invite)
	const invited = await testOrgMembersInvitePostHandler(env).execute({
		request: invite,
	} as never)
	expect(invited.status).toBe(400)
	expect(invited.data).toMatchObject({
		error: expect.stringMatching(/personal organization/),
	})

	const link = new Request('https://kody.test/@ada/-/members', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ role: 'member' }),
	})
	await signIn('bob', link)
	const linked = await testOrgMembersInviteLinksPostHandler(env).execute({
		request: link,
	} as never)
	expect(linked.status).toBe(400)
	expect(linked.data).toMatchObject({
		error: expect.stringMatching(/personal organization/),
	})
})

function postJson(body: Record<string, unknown>) {
	return new Request('https://kody.test/@zeta-co/-/members', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
}

test('pending invites list as Pending and an owner can revoke them', async () => {
	const env = createEnv()
	const invite = postJson({
		invitee: 'eve@example.com',
		role: 'member',
	})
	await signIn('ada', invite)
	await testOrgMembersInvitePostHandler(env).execute({
		request: invite,
	} as never)
	const listed = await testOrgMembersApiHandler(env).execute({
		request: new Request('https://kody.test/@zeta-co/-/members'),
	} as never)
	const { invites } = listed.data as {
		invites: Array<{ id: string; inviteeEmail: string | null }>
	}
	expect(invites).toMatchObject([{ inviteeEmail: 'eve@example.com' }])
	const inviteId = invites[0]!.id

	const asMember = postJson({ inviteId })
	await signIn('bob', asMember)
	expect(
		(
			await testOrgMembersInviteRevokePostHandler(env).execute({
				request: asMember,
			} as never)
		).status,
	).toBe(403)

	const asOwner = postJson({ inviteId })
	await signIn('ada', asOwner)
	const revoked = await testOrgMembersInviteRevokePostHandler(env).execute({
		request: asOwner,
	} as never)
	expect(revoked.status).toBe(200)
	expect(revoked.data).toEqual({ ok: true })
	expect(
		sqlite.prepare(`SELECT status FROM invites WHERE id = ?`).get(inviteId),
	).toEqual({ status: 'revoked' })

	const again = postJson({ inviteId })
	await signIn('ada', again)
	expect(
		(
			await testOrgMembersInviteRevokePostHandler(env).execute({
				request: again,
			} as never)
		).status,
	).toBe(400)
	const missing = postJson({ inviteId: 'nope' })
	await signIn('ada', missing)
	expect(
		(
			await testOrgMembersInviteRevokePostHandler(env).execute({
				request: missing,
			} as never)
		).status,
	).toBe(404)
})
