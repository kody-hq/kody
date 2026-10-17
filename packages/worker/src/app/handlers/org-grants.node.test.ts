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

const { loadOrgCollaboratorsData } = await import('./org-collaborators.ts')
const { testOrgGrantsApiHandler, testOrgGrantsRevokePostHandler } =
	await import('./org-grants.test-support.ts')

async function readCollaborators(env: Env, { request }: { request: Request }) {
	const { resolveOrgManagementAccess } =
		await import('#app/org-management-access.ts')
	const user = await mocks.readAuthenticatedAppUser(request, env)
	const access = await resolveOrgManagementAccess({
		env,
		request,
		user,
		orgSlug: 'zeta-co',
		permission: 'member:read',
	})
	return access.ok
		? {
				status: 200,
				data: await loadOrgCollaboratorsData({ env, user, org: access.org }),
			}
		: { status: access.status, data: { ok: false, error: access.error } }
}
const people = {
	ada: { id: 9, personId: 'a'.repeat(64) },
	bob: { id: 10, personId: 'b'.repeat(64) },
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
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.run(acmeId, people.bob.personId, now)
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
			 VALUES ('pkg-1', 'Demo Package', 'demo-package', ?)`,
		)
		.run(people.ada.personId)
	sqlite
		.prepare(
			`INSERT INTO grants (
			   id, org_id, resource_type, resource_id, subject_type, subject_id,
			   preset, created_by_user_id, created_at, updated_at
			 ) VALUES ('grant-1', ?, 'package', 'pkg-1', 'user', ?, 'use', ?, ?, ?)`,
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

test('grants list includes outside collaborator grants; collaborators page lists them', async () => {
	const env = createEnv()
	const grantsReq = new Request('https://kody.test/@zeta-co/-/grants')
	await signIn('ada', grantsReq)
	const grantsRes = await testOrgGrantsApiHandler(env).execute({
		request: grantsReq,
	} as never)
	expect(grantsRes.status).toBe(200)
	const grantsPayload = grantsRes.data as {
		canManage: boolean
		grants: Array<{ id: string; subjectLabel: string; presetLabel: string }>
	}
	expect(grantsPayload.canManage).toBe(true)
	expect(grantsPayload.grants).toHaveLength(1)
	expect(grantsPayload.grants[0]?.subjectLabel).toBe('@dan')
	expect(grantsPayload.grants[0]?.presetLabel).toBe('Use')
	expect(grantsPayload.grants[0]).toMatchObject({ canRevoke: true })

	const collabReq = new Request('https://kody.test/@zeta-co/-/collaborators')
	await signIn('ada', collabReq)
	const collabRes = await readCollaborators(env, {
		request: collabReq,
	} as never)
	expect(collabRes.status).toBe(200)
	const collabPayload = collabRes.data as {
		collaborators: Array<{ username: string; grants: Array<{ id: string }> }>
	}
	expect(collabPayload.collaborators).toHaveLength(1)
	expect(collabPayload.collaborators[0]).toMatchObject({
		userId: people.dan.personId,
		username: 'dan',
		displayName: 'dan',
		grants: [
			expect.objectContaining({
				id: 'grant-1',
				presetLabel: 'Use',
				resourceLabel: 'Demo Package',
			}),
		],
	})
})

test('member:write without manage access on the resource cannot revoke; owner can', async () => {
	const env = createEnv()
	const now = '2026-01-01T00:00:00.000Z'
	sqlite
		.prepare(
			`INSERT INTO grants (
			   id, org_id, resource_type, resource_id, subject_type, subject_id,
			   created_by_user_id, created_at, updated_at
			 ) VALUES ('grant-bob-member-write', ?, 'org', ?, 'user', ?, ?, ?, ?)`,
		)
		.run(acmeId, acmeId, people.bob.personId, people.ada.personId, now, now)
	sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission)
			 VALUES ('grant-bob-member-write', 'member:write')`,
		)
		.run()

	const listReq = new Request('https://kody.test/@zeta-co/-/grants')
	await signIn('bob', listReq)
	const listed = await testOrgGrantsApiHandler(env).execute({
		request: listReq,
	} as never)
	expect(listed.status).toBe(200)
	const listedPayload = listed.data as {
		canManage: boolean
		grants: Array<{ id: string; canRevoke: boolean }>
	}
	expect(listedPayload.canManage).toBe(true)
	expect(listedPayload.grants).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ id: 'grant-1', canRevoke: false }),
			expect.objectContaining({
				id: 'grant-bob-member-write',
				canRevoke: true,
			}),
		]),
	)

	const revokeReq = new Request('https://kody.test/@zeta-co/-/grants', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ grantId: 'grant-1' }),
	})
	await signIn('bob', revokeReq)
	const denied = await testOrgGrantsRevokePostHandler(env).execute({
		request: revokeReq,
	} as never)
	expect(denied.status).toBe(403)
	const deniedPayload = denied.data as { ok: false; error: string }
	expect(deniedPayload.ok).toBe(false)
	expect(deniedPayload.error).toMatch(/package:manage_access/)
	const stillLive = await db
		.prepare(
			`SELECT deleted_at FROM grants WHERE id = 'grant-1' AND org_id = ?`,
		)
		.bind(acmeId)
		.first<{ deleted_at: string | null }>()
	expect(stillLive?.deleted_at).toBeNull()

	const ownerReq = new Request('https://kody.test/@zeta-co/-/grants', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ grantId: 'grant-1' }),
	})
	await signIn('ada', ownerReq)
	const revoked = await testOrgGrantsRevokePostHandler(env).execute({
		request: ownerReq,
	} as never)
	expect(revoked.status).toBe(200)
	expect(revoked.data).toEqual({ ok: true })
	const payload = (
		await testOrgGrantsApiHandler(env).execute({ request: ownerReq } as never)
	).data as { grants: Array<{ id: string }> }
	expect(payload.grants.map((grant) => grant.id)).not.toContain('grant-1')
	const gone = await db
		.prepare(
			`SELECT deleted_at FROM grants WHERE id = 'grant-1' AND org_id = ?`,
		)
		.bind(acmeId)
		.first<{ deleted_at: string | null }>()
	expect(gone?.deleted_at).not.toBeNull()
})

test('owner can revoke a grant', async () => {
	const env = createEnv()
	const revokeReq = new Request('https://kody.test/@zeta-co/-/grants', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ grantId: 'grant-1' }),
	})
	await signIn('ada', revokeReq)
	const revoked = await testOrgGrantsRevokePostHandler(env).execute({
		request: revokeReq,
	} as never)
	expect(revoked.status).toBe(200)
	expect(revoked.data).toEqual({ ok: true })
	const payload = (
		await testOrgGrantsApiHandler(env).execute({ request: revokeReq } as never)
	).data as { grants: Array<unknown> }
	expect(payload.grants).toEqual([])
})

test('personal org owner can list and revoke grants', async () => {
	const env = createEnv()
	const now = '2026-01-01T00:00:00.000Z'
	const personalOrgId = ownerIdFromStored(people.ada.personId)
	sqlite
		.prepare(
			`INSERT INTO grants (
			   id, org_id, resource_type, resource_id, subject_type, subject_id,
			   preset, created_by_user_id, created_at, updated_at
			 ) VALUES ('grant-personal-1', ?, 'package', 'pkg-1', 'user', ?, 'use', ?, ?, ?)`,
		)
		.run(personalOrgId, people.dan.personId, people.ada.personId, now, now)

	const listReq = new Request('https://kody.test/@ada/-/grants')
	await signIn('ada', listReq)
	const listRes = await testOrgGrantsApiHandler(env).execute({
		request: listReq,
	} as never)
	expect(listRes.status).toBe(200)
	const listPayload = listRes.data as {
		canManage: boolean
		grants: Array<{ id: string }>
	}
	expect(listPayload.canManage).toBe(true)
	expect(listPayload.grants).toContainEqual(
		expect.objectContaining({ id: 'grant-personal-1', canRevoke: true }),
	)

	const revokeReq = new Request('https://kody.test/@ada/-/grants', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ grantId: 'grant-personal-1' }),
	})
	await signIn('ada', revokeReq)
	const revoked = await testOrgGrantsRevokePostHandler(env).execute({
		request: revokeReq,
	} as never)
	expect(revoked.status).toBe(200)
	expect(revoked.data).toEqual({ ok: true })
	const payload = (
		await testOrgGrantsApiHandler(env).execute({ request: revokeReq } as never)
	).data as { grants: Array<{ id: string }> }
	expect(payload.grants.map((g) => g.id)).not.toContain('grant-personal-1')
})

test('collaborators JSON is 404 for grant-only people', async () => {
	const env = createEnv()
	const req = new Request('https://kody.test/@zeta-co/-/collaborators')
	await signIn('dan', req)
	expect(
		(
			await readCollaborators(env, {
				request: req,
			} as never)
		).status,
	).toBe(404)
})
