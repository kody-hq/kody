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
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))
vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (...args: Array<unknown>) =>
		mocks.requireAuthenticatedPageUser(...args),
}))

const {
	testOrgTeamsApiHandler,
	testOrgTeamsCreatePostHandler,
	testOrgTeamsMemberAddPostHandler,
	testOrgTeamsMemberRemovePostHandler,
} = await import('./org-teams.test-support.ts')

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
	await seed()
})

test('teams data is 404 for collaborators, 403 for billing, readable by members', async () => {
	const env = createEnv()
	const collab = new Request('https://kody.test/@zeta-co/-/teams')
	await signIn('dan', collab)
	expect(
		(
			await testOrgTeamsApiHandler(env).execute({
				request: collab,
			} as never)
		).status,
	).toBe(404)

	const billing = new Request('https://kody.test/@zeta-co/-/teams')
	await signIn('cara', billing)
	expect(
		(
			await testOrgTeamsApiHandler(env).execute({
				request: billing,
			} as never)
		).status,
	).toBe(403)

	const member = new Request('https://kody.test/@zeta-co/-/teams')
	await signIn('bob', member)
	const readable = await testOrgTeamsApiHandler(env).execute({
		request: member,
	} as never)
	expect(readable.status).toBe(200)
	const payload = readable.data as {
		canManage: boolean
		teams: Array<unknown>
	}
	expect(payload.canManage).toBe(false)
	expect(payload.teams).toEqual([])
})

test('owner can create a team and add a member', async () => {
	const env = createEnv()
	const createReq = new Request('https://kody.test/@zeta-co/-/teams', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ slug: 'platform', name: 'Platform' }),
	})
	await signIn('ada', createReq)
	const created = await testOrgTeamsCreatePostHandler(env).execute({
		request: createReq,
	} as never)
	expect(created.status).toBe(200)
	expect(created.data).toEqual({ ok: true })
	const createdPayload = (
		await testOrgTeamsApiHandler(env).execute({ request: createReq } as never)
	).data as {
		ok: boolean
		teams: Array<{ id: string; slug: string; memberCount: number }>
		canManage: boolean
	}
	expect(createdPayload.ok).toBe(true)
	expect(createdPayload.canManage).toBe(true)
	expect(createdPayload.teams).toHaveLength(1)
	const teamId = createdPayload.teams[0]!.id

	const addReq = new Request('https://kody.test/@zeta-co/-/teams', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ teamId, userId: people.bob.personId }),
	})
	await signIn('ada', addReq)
	const added = await testOrgTeamsMemberAddPostHandler(env).execute({
		request: addReq,
	} as never)
	expect(added.status).toBe(200)
	expect(added.data).toEqual({ ok: true })
	const addedPayload = (
		await testOrgTeamsApiHandler(env).execute({ request: addReq } as never)
	).data as {
		teams: Array<{ memberCount: number; members: Array<{ username: string }> }>
	}
	expect(addedPayload.teams[0]?.memberCount).toBe(1)
	expect(addedPayload.teams[0]?.members.map((m) => m.username)).toEqual(['bob'])
})

test('team member remove rejects a team id from another organization', async () => {
	const env = createEnv()
	// Bob creates the foreign org so Ada stays under the free-org ownership cap.
	const other = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: people.bob.personId,
			audit: createTestOrgAuditWriter(),
			slug: 'other-co',
			displayName: 'Other Co',
		},
	)
	if (!other.ok) throw new Error(other.error)
	const otherId = (await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'other-co'`)
		.first<{ id: string }>())!.id
	const { createTeam, addTeamMember } =
		await import('#worker/orgs/access-writes.ts')
	const foreign = await createTeam({
		db,
		orgId: otherId,
		slug: 'foreign',
		name: 'Foreign',
		createdByUserId: people.bob.personId,
		audit: createTestOrgAuditWriter(),
	})
	await addTeamMember({
		db,
		orgId: otherId,
		teamId: foreign.id,
		userId: people.bob.personId,
		addedByUserId: people.bob.personId,
		audit: createTestOrgAuditWriter(),
	})

	const removeReq = new Request('https://kody.test/@zeta-co/-/teams', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			teamId: foreign.id,
			userId: people.bob.personId,
		}),
	})
	await signIn('ada', removeReq)
	const removed = await testOrgTeamsMemberRemovePostHandler(env).execute({
		request: removeReq,
	} as never)
	expect(removed.status).toBe(400)
	const stillThere = await db
		.prepare(
			`SELECT user_id FROM team_members
			 WHERE team_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(foreign.id, people.bob.personId)
		.first()
	expect(stillThere).toEqual({ user_id: people.bob.personId })
})
