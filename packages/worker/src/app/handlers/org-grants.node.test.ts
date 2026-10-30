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
const {
	grantOrganizationCreateAccess,
	grantOrganizationReadAccess,
	testOrgGrantsApiHandler,
	testOrgGrantsRevokePostHandler,
} = await import('./org-grants.test-support.ts')
const { compileAccessForActor } =
	await import('#worker/authorization/access-compile.ts')

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

async function grantReads(
	env: Env,
	person: Person,
	fields: { subject: string; permissions: Array<string> },
) {
	const request = new Request('https://kody.test/@zeta-co/-/grants', {
		method: 'POST',
	})
	await signIn(person, request)
	const user = await mocks.readAuthenticatedAppUser(request, env)
	return await grantOrganizationReadAccess({
		request,
		env,
		user,
		orgSlug: 'zeta-co',
		...fields,
	})
}

async function bobOrgPermissions() {
	const compiled = await compileAccessForActor({
		db,
		orgId: acmeId as never,
		userId: people.bob.personId,
		role: 'member',
	})
	return compiled.orgPermissions
}

test('an owner grants a member org-wide read access; no write comes with it', async () => {
	const env = createEnv()
	const listReq = new Request('https://kody.test/@zeta-co/-/grants')
	await signIn('ada', listReq)
	const before = (
		await testOrgGrantsApiHandler(env).execute({ request: listReq } as never)
	).data as {
		orgWideRead: {
			subjects: Array<{ key: string; label: string; reads: Array<string> }>
		}
	}
	// Owners already hold everything, and outside collaborators are not listed.
	expect(before.orgWideRead.subjects).toEqual([
		{
			key: `user:${people.bob.personId}`,
			kind: 'user',
			label: '@bob',
			reads: [],
			creates: [],
		},
	])
	expect(await bobOrgPermissions()).not.toContain('job:read')

	const saved = await grantReads(env, 'ada', {
		subject: `user:${people.bob.personId}`,
		permissions: ['job:read', 'app:read'],
	})
	expect(saved.status).toBe(200)
	const permissions = await bobOrgPermissions()
	expect(permissions.has('job:read')).toBe(true)
	expect(permissions.has('app:read')).toBe(true)
	for (const write of [
		'job:write',
		'job:execute',
		'app:execute',
		'org:execute',
	]) {
		expect(permissions.has(write as never)).toBe(false)
	}

	const after = (
		await testOrgGrantsApiHandler(env).execute({ request: listReq } as never)
	).data as {
		orgWideRead: { subjects: Array<{ reads: Array<string> }> }
		grants: Array<{ resourceType: string; permissions: Array<string> }>
	}
	expect([...(after.orgWideRead.subjects[0]?.reads ?? [])].sort()).toEqual([
		'app:read',
		'job:read',
	])
	expect(
		after.grants.find((grant) => grant.resourceType === 'org'),
	).toBeTruthy()

	const refused = await grantReads(env, 'ada', {
		subject: `user:${people.bob.personId}`,
		permissions: ['job:write'],
	})
	expect(refused.status).toBe(400)
	expect(refused.data).toMatchObject({ ok: false })
	expect((await bobOrgPermissions()).has('job:write')).toBe(false)
})

test('saving read access keeps other org permissions and drops unchecked reads', async () => {
	const env = createEnv()
	const now = '2026-01-01T00:00:00.000Z'
	sqlite
		.prepare(
			`INSERT INTO grants (
			   id, org_id, resource_type, resource_id, subject_type, subject_id,
			   created_by_user_id, created_at, updated_at
			 ) VALUES ('grant-bob-org', ?, 'org', ?, 'user', ?, ?, ?, ?)`,
		)
		.run(acmeId, acmeId, people.bob.personId, people.ada.personId, now, now)
	for (const permission of ['audit:read', 'job:read']) {
		sqlite
			.prepare(
				`INSERT INTO grant_permissions (grant_id, permission) VALUES ('grant-bob-org', ?)`,
			)
			.run(permission)
	}
	const saved = await grantReads(env, 'ada', {
		subject: `user:${people.bob.personId}`,
		permissions: ['package:read'],
	})
	expect(saved.status).toBe(200)
	const permissions = await bobOrgPermissions()
	expect(permissions.has('audit:read')).toBe(true)
	expect(permissions.has('package:read')).toBe(true)
	expect(permissions.has('job:read')).toBe(false)
})

test('unchecking every read clears a reads-only org grant', async () => {
	const env = createEnv()
	const subject = `user:${people.bob.personId}`
	expect(
		(await grantReads(env, 'ada', { subject, permissions: ['job:read'] }))
			.status,
	).toBe(200)
	expect((await bobOrgPermissions()).has('job:read')).toBe(true)
	const cleared = await grantReads(env, 'ada', { subject, permissions: [] })
	expect(cleared.status).toBe(200)
	expect((await bobOrgPermissions()).has('job:read')).toBe(false)
	const live = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM grants
			 WHERE org_id = ? AND resource_type = 'org' AND deleted_at IS NULL`,
		)
		.bind(acmeId)
		.first<{ n: number }>()
	expect(live?.n).toBe(0)
})

test('only a member:write holder can grant read access, and only to members or teams', async () => {
	const env = createEnv()
	const denied = await grantReads(env, 'bob', {
		subject: `user:${people.bob.personId}`,
		permissions: ['job:read'],
	})
	expect(denied.status).toBe(403)
	expect((await bobOrgPermissions()).has('job:read')).toBe(false)

	for (const subject of [
		`user:${people.dan.personId}`,
		`user:${people.ada.personId}`,
		'team:missing',
		'nonsense',
	]) {
		const refused = await grantReads(env, 'ada', {
			subject,
			permissions: ['job:read'],
		})
		expect(refused.status).toBe(400)
	}
})

async function grantCreates(
	env: Env,
	person: Person,
	fields: { subject: string; permissions: Array<string> },
) {
	const request = new Request('https://kody.test/@zeta-co/-/grants', {
		method: 'POST',
	})
	await signIn(person, request)
	const user = await mocks.readAuthenticatedAppUser(request, env)
	return await grantOrganizationCreateAccess({
		request,
		env,
		user,
		orgSlug: 'zeta-co',
		...fields,
	})
}

test('an owner grants and revokes create access without touching read access', async () => {
	const env = createEnv()
	const subject = `user:${people.bob.personId}`
	expect(
		(await grantReads(env, 'ada', { subject, permissions: ['job:read'] }))
			.status,
	).toBe(200)
	expect((await bobOrgPermissions()).has('package:create')).toBe(false)

	const saved = await grantCreates(env, 'ada', {
		subject,
		permissions: ['package:create'],
	})
	expect(saved.status).toBe(200)
	let permissions = await bobOrgPermissions()
	expect(permissions.has('package:create')).toBe(true)
	expect(permissions.has('job:read')).toBe(true)
	expect(permissions.has('package:write')).toBe(false)

	const listReq = new Request('https://kody.test/@zeta-co/-/grants')
	await signIn('ada', listReq)
	const listed = (
		await testOrgGrantsApiHandler(env).execute({ request: listReq } as never)
	).data as {
		orgWideRead: {
			subjects: Array<{ reads: Array<string>; creates: Array<string> }>
		}
	}
	expect(listed.orgWideRead.subjects[0]).toMatchObject({
		reads: ['job:read'],
		creates: ['package:create'],
	})

	// Saving reads keeps the create grant, and clearing creates keeps reads.
	expect(
		(await grantReads(env, 'ada', { subject, permissions: ['app:read'] }))
			.status,
	).toBe(200)
	expect((await bobOrgPermissions()).has('package:create')).toBe(true)
	expect(
		(await grantCreates(env, 'ada', { subject, permissions: [] })).status,
	).toBe(200)
	permissions = await bobOrgPermissions()
	expect(permissions.has('package:create')).toBe(false)
	expect(permissions.has('app:read')).toBe(true)

	for (const refused of [['job:read'], ['package:write'], ['secret:write']]) {
		const result = await grantCreates(env, 'ada', {
			subject,
			permissions: refused,
		})
		expect(result.status).toBe(400)
	}
	expect(
		(
			await grantCreates(env, 'bob', {
				subject,
				permissions: ['package:create'],
			})
		).status,
	).toBe(403)
	expect((await bobOrgPermissions()).has('package:create')).toBe(false)
})
