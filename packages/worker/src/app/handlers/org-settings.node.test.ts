import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { resolveOrgManagementAccess } from '#app/org-management-access.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	requireAuthenticatedPageUser: vi.fn(),
	renderAppPage: vi.fn(async (input: { status?: number; notFound?: boolean }) =>
		Response.json(
			{
				notFound: input.notFound ?? false,
				unauthorized: false,
			},
			{ status: input.status ?? 200 },
		),
	),
	softDeleteOrg: vi.fn(),
	processUserAvatar: vi.fn(),
	saveOrgAvatar: vi.fn(),
	customDomainsEnabled: vi.fn(async (..._args: unknown[]) => false),
}))

vi.mock('#worker/package-app-custom-hostnames/feature-flag.ts', () => ({
	isPackageAppCustomDomainsEnabledForUser: (...args: unknown[]) =>
		mocks.customDomainsEnabled(...args),
}))
vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))
vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (...args: Array<unknown>) =>
		mocks.requireAuthenticatedPageUser(...args),
}))
vi.mock('#worker/orgs/soft-delete.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#worker/orgs/soft-delete.ts')>()
	return {
		...actual,
		softDeleteOrg: (...args: Array<unknown>) => mocks.softDeleteOrg(...args),
	}
})
vi.mock('#worker/community/avatar.ts', () => ({
	processUserAvatar: (...args: Array<unknown>) =>
		mocks.processUserAvatar(...args),
}))
vi.mock('#worker/orgs/org-avatar.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#worker/orgs/org-avatar.ts')>()
	return {
		...actual,
		saveOrgAvatar: (...args: Array<unknown>) => mocks.saveOrgAvatar(...args),
	}
})

const {
	loadOrgSettingsData,
	saveOrganizationPhoto,
	deleteOrganization,
	updateOrganizationProfile,
} = await import('./org-settings.ts')

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
	await ensureUsersTestSchema({
		db,
		columns: ['avatar_key', 'experiments_opt_in'],
	})
	const now = '2026-01-01T00:00:00.000Z'
	for (const [username, person] of Object.entries(people)) {
		sqlite
			.prepare(
				`INSERT INTO users (id, username, email, password_hash, stable_user_id)
				 VALUES (?, ?, ?, 'x', ?)`,
			)
			.run(person.id, username, `${username}@example.com`, person.personId)
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
	return {
		APP_DB: db,
		COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef',
	} as Env
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
	return user
}

beforeEach(async () => {
	mocks.readAuthenticatedAppUser.mockReset()
	mocks.requireAuthenticatedPageUser.mockReset()
	mocks.renderAppPage.mockClear()
	mocks.softDeleteOrg.mockClear()
	mocks.processUserAvatar.mockReset()
	mocks.saveOrgAvatar.mockReset()
	mocks.customDomainsEnabled.mockReset().mockResolvedValue(false)
	await seed()
})

async function readSettings(env: Env, { request }: { request: Request }) {
	const user = await mocks.readAuthenticatedAppUser(request, env)
	const orgSlug = new URL(request.url).pathname.split('/')[1]!.slice(1)
	const access = await resolveOrgManagementAccess({
		env,
		request,
		user,
		orgSlug,
		permission: 'org:read',
	})
	return access.ok
		? {
				status: 200,
				data: await loadOrgSettingsData({ env, user, org: access.org }),
			}
		: { status: access.status, data: { ok: false, error: access.error } }
}
async function callSettings(
	operation:
		| typeof updateOrganizationProfile
		| typeof saveOrganizationPhoto
		| typeof deleteOrganization,
	env: Env,
	{ request }: { request: Request },
) {
	const user = await mocks.readAuthenticatedAppUser(request, env)
	const context = {
		env,
		request,
		user,
		orgSlug: new URL(request.url).pathname.split('/')[1]!.slice(1),
	}
	if (operation === saveOrganizationPhoto) {
		const avatar = (await request.formData()).get('avatar')
		return saveOrganizationPhoto({
			...context,
			avatar: avatar instanceof File ? avatar : null,
		})
	}
	const body = (await request.json()) as {
		displayName?: string
		slug?: string
		confirmation?: string
	}
	if (operation === deleteOrganization)
		return deleteOrganization({
			...context,
			confirmation: body.confirmation ?? '',
		})
	return updateOrganizationProfile({
		...context,
		displayName: body.displayName,
		slug: body.slug,
	})
}

test('settings JSON is 404 for an unknown slug, collaborator, and 403 for a member write', async () => {
	const env = createEnv()
	const unknown = new Request('https://kody.test/@missing/-/settings.json')
	await signIn('ada', unknown)
	expect(
		(
			await readSettings(env, {
				request: unknown,
			} as never)
		).status,
	).toBe(404)

	const collab = new Request('https://kody.test/@zeta-co/-/settings.json')
	await signIn('dan', collab)
	expect(
		(
			await readSettings(env, {
				request: collab,
			} as never)
		).status,
	).toBe(404)

	const memberGet = new Request('https://kody.test/@zeta-co/-/settings.json')
	await signIn('bob', memberGet)
	const readable = await readSettings(env, {
		request: memberGet,
	} as never)
	expect(readable.status).toBe(200)
	expect(readable.data).toMatchObject({
		ok: true,
		canManage: false,
		org: { slug: 'zeta-co', personal: false },
	})

	const memberWrite = new Request(
		'https://kody.test/@zeta-co/-/settings.json',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ displayName: 'Nope' }),
		},
	)
	await signIn('bob', memberWrite)
	expect(
		(
			await callSettings(updateOrganizationProfile, env, {
				request: memberWrite,
			} as never)
		).status,
	).toBe(403)
})

test('owner can update team settings and cannot delete a personal org', async () => {
	const env = createEnv()
	const update = new Request('https://kody.test/@zeta-co/-/settings.json', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ displayName: 'Acme Co' }),
	})
	await signIn('ada', update)
	const updated = await callSettings(updateOrganizationProfile, env, {
		request: update,
	} as never)
	expect(updated.status).toBe(200)
	expect(updated.data).toMatchObject({
		ok: true,
		org: { displayName: 'Acme Co', slug: 'zeta-co' },
	})

	const personal = new Request(
		'https://kody.test/@ada/-/settings/delete.json',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ confirmation: 'ada' }),
		},
	)
	await signIn('ada', personal)
	const blocked = await callSettings(deleteOrganization, env, {
		request: personal,
	} as never)
	expect(blocked.status).toBe(400)
	expect(blocked.data).toMatchObject({
		ok: false,
		error: expect.stringMatching(/Data & deletion/),
	})
	expect(mocks.softDeleteOrg).not.toHaveBeenCalled()

	const del = new Request('https://kody.test/@zeta-co/-/settings/delete.json', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ confirmation: 'zeta-co' }),
	})
	await signIn('ada', del)
	expect(
		(
			await callSettings(deleteOrganization, env, {
				request: del,
			} as never)
		).status,
	).toBe(200)
	expect(mocks.softDeleteOrg).toHaveBeenCalled()
})

test('org avatar upload keeps validation as 400 and storage failures as 500', async () => {
	const env = createEnv()
	consoleError.mockImplementation(() => {})
	mocks.processUserAvatar.mockImplementation(() => {
		throw new Error('Avatars must be PNG, JPEG, or WebP images.')
	})
	const invalidForm = new FormData()
	invalidForm.set(
		'avatar',
		new File([Uint8Array.from([1])], 'avatar.svg', { type: 'image/svg+xml' }),
	)
	const invalid = new Request(
		'https://kody.test/@zeta-co/-/settings/avatar.json',
		{ method: 'POST', body: invalidForm },
	)
	await signIn('ada', invalid)
	const invalidResponse = await callSettings(saveOrganizationPhoto, env, {
		request: invalid,
	} as never)
	expect(invalidResponse.status).toBe(400)
	expect(invalidResponse.data).toMatchObject({
		ok: false,
		error: 'Avatars must be PNG, JPEG, or WebP images.',
	})
	expect(mocks.saveOrgAvatar).not.toHaveBeenCalled()

	mocks.processUserAvatar.mockReturnValue({
		bytes: Uint8Array.from([1, 2, 3]),
		contentType: 'image/png',
	})
	mocks.saveOrgAvatar.mockRejectedValue(
		new Error('Organization was not found.'),
	)
	const form = new FormData()
	form.set(
		'avatar',
		new File([Uint8Array.from([1, 2, 3])], 'avatar.png', {
			type: 'image/png',
		}),
	)
	const failing = new Request(
		'https://kody.test/@zeta-co/-/settings/avatar.json',
		{ method: 'POST', body: form },
	)
	await signIn('ada', failing)
	const failed = await callSettings(saveOrganizationPhoto, env, {
		request: failing,
	} as never)
	expect(failed.status).toBe(500)
	expect(failed.data).toMatchObject({
		ok: false,
		error: 'Unable to save avatar.',
	})
	expect(consoleError).toHaveBeenCalledWith(
		'org-avatar-save-failed',
		expect.any(Error),
	)
})

test('a second owner still treats a signup org as personal', async () => {
	const env = createEnv()
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', ?)`,
		)
		.run(people.ada.personId, people.bob.personId, '2026-01-02T00:00:00.000Z')

	const get = new Request('https://kody.test/@ada/-/settings.json')
	await signIn('bob', get)
	const body = await (await readSettings(env, { request: get } as never)).data
	expect(body).toMatchObject({
		ok: true,
		org: { slug: 'ada', personal: true },
		canManage: false,
	})

	const del = new Request('https://kody.test/@ada/-/settings/delete.json', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ confirmation: 'ada' }),
	})
	await signIn('bob', del)
	const blocked = await callSettings(deleteOrganization, env, {
		request: del,
	} as never)
	expect(blocked.status).toBe(400)
	expect(mocks.softDeleteOrg).not.toHaveBeenCalled()
})

test('owner sees personal identity lock on their signup org and edits a team org', async () => {
	const env = createEnv()

	const personalGet = new Request('https://kody.test/@ada/-/settings.json')
	await signIn('ada', personalGet)
	expect(
		await (
			await readSettings(env, {
				request: personalGet,
			} as never)
		).data,
	).toMatchObject({
		ok: true,
		org: { slug: 'ada', personal: true },
		canManage: false,
		canDelete: false,
	})

	const teamGet = new Request('https://kody.test/@zeta-co/-/settings.json')
	await signIn('ada', teamGet)
	expect(
		await (
			await readSettings(env, {
				request: teamGet,
			} as never)
		).data,
	).toMatchObject({
		ok: true,
		org: { slug: 'zeta-co', personal: false },
		canManage: true,
		canDelete: true,
	})
})

test('former platform orgs are not personal for settings identity editing', async () => {
	const env = createEnv()
	const platformId = 'e'.repeat(64)
	const now = '2026-01-02T00:00:00.000Z'
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
			 VALUES (?, 'kody', NULL, ?, ?)`,
		)
		.run(platformId, now, now)
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at, deleted_at)
			 VALUES (?, ?, 'owner', ?, ?)`,
		)
		.run(platformId, platformId, now, '2026-10-10T00:00:00.000Z')
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', ?)`,
		)
		.run(platformId, people.ada.personId, now)
	sqlite
		.prepare(
			`INSERT INTO handles (handle, org_id, created_at) VALUES ('kody', ?, ?)`,
		)
		.run(platformId, now)

	const get = new Request('https://kody.test/@kody/-/settings.json')
	await signIn('ada', get)
	expect(
		await (
			await readSettings(env, {
				request: get,
			} as never)
		).data,
	).toMatchObject({
		ok: true,
		org: { slug: 'kody', personal: false },
		canManage: true,
		canDelete: true,
	})

	const update = new Request('https://kody.test/@kody/-/settings.json', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ displayName: 'Kody' }),
	})
	await signIn('ada', update)
	const updated = await callSettings(updateOrganizationProfile, env, {
		request: update,
	} as never)
	expect(updated.status).toBe(200)
	expect(updated.data).toMatchObject({
		ok: true,
		org: { slug: 'kody', displayName: 'Kody', personal: false },
	})
})

test('profile write succeeds without loading unrelated custom domain settings', async () => {
	const env = createEnv()
	const request = new Request('https://kody.test/@zeta-co/-/settings.json', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ displayName: 'Saved name' }),
	})
	await signIn('ada', request)
	mocks.customDomainsEnabled.mockRejectedValue(
		new Error('Domain settings unavailable'),
	)
	const result = await callSettings(updateOrganizationProfile, env, {
		request,
	} as never)
	expect(result.status).toBe(200)
	expect(result.data).toMatchObject({
		ok: true,
		org: { displayName: 'Saved name' },
	})
	expect(result.data).not.toHaveProperty('customDomains')
	expect(mocks.customDomainsEnabled).not.toHaveBeenCalled()
})
