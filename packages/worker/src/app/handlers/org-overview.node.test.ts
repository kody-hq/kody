import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: async () =>
		(await mocks.readAuthenticatedAppUser()) ??
		Response.redirect('https://kody.test/login', 302),
}))
const native = vi.hoisted(() => ({
	env: {} as Env,
	request: new Request('https://example.com/login'),
	setResponseHeader: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerOnlyFn: <T>(fn: T) => fn,
	createServerFn: () => {
		let validate:
			| ((data: unknown) => unknown)
			| { parse(data: unknown): unknown } = (data) => data
		const builder = {
			validator: (fn: typeof validate) => {
				validate = fn
				return builder
			},
			handler:
				(fn: (input: { data: unknown }) => unknown) =>
				(input: { data: unknown }) =>
					fn({
						data:
							typeof validate === 'function'
								? validate(input.data)
								: validate.parse(input.data),
					}),
		}
		return builder
	},
}))
vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	get env() {
		return native.env
	},
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => native.request,
	setResponseHeader: native.setResponseHeader,
}))
vi.mock('#app/env.ts', () => ({ getEnv: () => native.env }))

const { loadOrgOverview } =
	await import('../../../start/server/org-management.ts')

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
	return {
		APP_DB: db,
		COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123456789',
	} as unknown as Env
}

async function getOverview(env: Env, orgSlug: string) {
	native.env = env
	native.request = new Request(`https://kody.test/@${orgSlug}/-/overview`)
	return loadOrgOverview({ data: { slug: orgSlug } })
}

beforeEach(() => {
	mocks.readAuthenticatedAppUser.mockReset()
	native.setResponseHeader.mockClear()
	mocks.readAuthenticatedAppUser.mockResolvedValue({
		username: 'ada-renamed',
		mcpUser: { userId: adaId },
	})
})

test('the signup org overview renders without remembering the org', async () => {
	expect(await getOverview(await createEnv(), 'ada')).toEqual({ slug: 'ada' })
	expect(native.setResponseHeader.mock.calls).toEqual([
		['Cache-Control', 'private, no-store'],
	])
})
test('a team org overview redirects to the team home', async () => {
	await expect(getOverview(await createEnv(), 'acme')).rejects.toMatchObject({
		options: { href: '/@acme' },
	})
})
test('an org you do not belong to is a 404', async () => {
	await expect(getOverview(await createEnv(), 'bob')).rejects.toMatchObject({
		isNotFound: true,
	})
})
test('signed-out visitors go to login', async () => {
	mocks.readAuthenticatedAppUser.mockResolvedValue(null)
	await expect(getOverview(await createEnv(), 'ada')).rejects.toMatchObject({
		options: { href: expect.stringContaining('/login') },
	})
})
