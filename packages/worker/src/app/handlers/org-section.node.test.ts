import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	loadProfileData: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/profile-data.ts', () => ({
	loadProfileData: (...args: Array<unknown>) => mocks.loadProfileData(...args),
}))

const { loadOrgBindingForSlug } = await import('#worker/orgs/repo.ts')

const adaId = 'person-ada'
const bobId = 'person-bob'

async function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	const now = '2026-01-01T00:00:00.000Z'
	for (const [id, slug] of [
		[adaId, 'ada'],
		[bobId, 'bob'],
		['org-acme', 'acme'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(id, slug, slug, now, now)
	}
	for (const [orgId, userId] of [
		[adaId, adaId],
		[bobId, bobId],
		['org-acme', adaId],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, 'owner', ?)`,
			)
			.run(orgId, userId, now)
	}
	return { APP_DB: db } as unknown as Env
}

function signInAs(personId: string, username: string) {
	mocks.readAuthenticatedAppUser.mockResolvedValue({
		username,
		mcpUser: { userId: personId },
	})
}

async function getPackages(env: Env, orgSlug: string) {
	const request = new Request(
		`https://kody.test/@${orgSlug}/-/repositories.json`,
	)
	const user = await mocks.readAuthenticatedAppUser(request, env)
	if (!user) return { status: 401, data: { ok: false, error: 'Unauthorized.' } }
	const binding = await loadOrgBindingForSlug(
		env.APP_DB,
		user.mcpUser.userId,
		orgSlug,
	)
	if (!binding?.role)
		return {
			status: 404,
			data: { ok: false, error: 'Organization unavailable' },
		}
	return {
		status: 200,
		data: await mocks.loadProfileData(env, request, user.username),
	}
}

beforeEach(() => {
	mocks.readAuthenticatedAppUser.mockReset()
	mocks.loadProfileData.mockReset()
	mocks.loadProfileData.mockImplementation(
		async (_env: Env, _request: Request, username: string) => ({
			ok: true,
			profile: { username },
		}),
	)
})

test('workspace repositories JSON requires a signed-in person', async () => {
	const env = await createEnv()
	mocks.readAuthenticatedAppUser.mockResolvedValue(null)
	const response = await getPackages(env, 'ada')
	expect(response.status).toBe(401)
	expect(mocks.loadProfileData).not.toHaveBeenCalled()
})

test('workspace repositories JSON is closed to people outside the organization', async () => {
	const env = await createEnv()
	signInAs(adaId, 'ada')
	const response = await getPackages(env, 'bob')
	expect(response.status).toBe(404)
	expect(response.data).toEqual({
		ok: false,
		error: 'Organization unavailable',
	})
	expect(mocks.loadProfileData).not.toHaveBeenCalled()
})

test('workspace repositories JSON lists the owner by current username after a rename', async () => {
	const env = await createEnv()
	signInAs(adaId, 'ada-new')
	const response = await getPackages(env, 'ada')
	expect(response.status).toBe(200)
	expect(response.data).toEqual({
		ok: true,
		profile: { username: 'ada-new' },
	})
	expect(mocks.loadProfileData).toHaveBeenCalledWith(
		env,
		expect.any(Request),
		'ada-new',
	)
})

test('team Connections are open to every member role and to grant-only collaborators', async () => {
	const { orgSectionDenial } = await import('#app/org-request-binding.ts')
	const team = { id: 'org-acme', slug: 'acme' } as never
	for (const role of ['owner', 'member', 'billing', null] as const) {
		expect(orgSectionDenial({ org: team, role }, 'agents')).toBeNull()
	}
	expect(orgSectionDenial({ org: team, role: null }, 'secrets')).toBe(
		'Organization resources unavailable',
	)
	expect(orgSectionDenial('denied', 'agents')).toBe('Organization unavailable')
})

test('credential creation passes the same team-org permission gate as native credential reads', async () => {
	const { orgSectionDenial } = await import('#app/org-request-binding.ts')
	const org = { id: 'org-acme', slug: 'acme' } as never
	expect(orgSectionDenial({ org, role: 'owner' }, 'credentials')).toBeNull()
	expect(orgSectionDenial('denied', 'credentials')).toBe(
		'Organization unavailable',
	)
})

test('the org-less creation link keeps its query on the signup org page', async () => {
	const { signupOrgCredentialCreateHref } =
		await import('./connect-credential.ts')
	expect(
		signupOrgCredentialCreateHref(
			{ username: 'ada', request: { org: { slug: 'ada' } } } as never,
			'?kind=secret&name=x',
		),
	).toBe('/@ada/-/credentials/new?kind=secret&name=x')
	expect(
		signupOrgCredentialCreateHref(
			{ username: 'ada', request: { org: { slug: null } } } as never,
			'',
		),
	).toBe('/@ada/-/credentials/new')
})
