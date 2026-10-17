import { beforeEach, expect, test, vi } from 'vitest'
import { connectOauthInput } from '../connect-input.ts'
const state = vi.hoisted(() => ({
	request: new Request('https://kody.test/connect/oauth'),
	env: { APP_DB: {} },
	authenticated: vi.fn(),
	auth: vi.fn(),
	binding: vi.fn(),
	operation: vi.fn(),
}))
vi.mock('@tanstack/react-start', async () => ({
	createServerFn: (
		await import('#worker/test-support/start-server-function.ts')
	).createTestServerFn,
	createServerOnlyFn: <T>(fn: T) => fn,
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => state.request,
	setResponseHeader: vi.fn(),
}))
vi.mock('cloudflare:workers', () => ({ env: state.env }))
vi.mock('#app/env.ts', () => ({ getEnv: (env: unknown) => env }))
vi.mock('../../src/app/auth-session.ts', () => ({
	setAuthSessionSecret: vi.fn(),
}))
vi.mock('../../src/app/request-auth-cache.ts', () => ({
	loadResolvedRequestAuth: state.auth,
}))
// Read scope never acquires a write lease or loads its Durable Object graph.
vi.mock('#worker/account/deletion-state.ts', () => ({
	withAccountWriteLease: vi.fn(() => {
		throw new Error('Unexpected write lease during read')
	}),
}))
vi.mock('./request-env.ts', () => ({ getStartRequestEnv: () => state.env }))
vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: state.authenticated,
}))
vi.mock('#worker/orgs/repo.ts', () => ({
	loadOrgBindingForSlug: state.binding,
}))
vi.mock('#worker/request-context/request-context.ts', () => ({
	deriveRequestContext: (value: unknown) => value,
}))
vi.mock('./document-head.ts', () => ({ loadDocumentHead: () => ({}) }))
vi.mock('../../src/app/handlers/connect-oauth.ts', () => ({
	loadConnectOauthLoaderData: state.operation,
}))
import { loadConnectOauth } from './connect.ts'
import { verifySession } from './shell.ts'

beforeEach(() => {
	vi.clearAllMocks()
	state.auth.mockResolvedValue({ user: { mcpUser: { userId: 'owner' } } })
	state.authenticated.mockResolvedValue({
		mcpUser: { userId: 'owner' },
		request: { original: true },
	})
	state.binding.mockResolvedValue({ org: { slug: 'team' }, role: 'member' })
	state.operation.mockResolvedValue({ ok: true })
})
for (const path of ['/connect/oauth', '/_serverFn/connect']) {
	test.each(['?org=', '?org=%20', '?org=../other'])(
		`${path} rejects malformed scope before authentication or data reads: %s`,
		(search) => {
			state.request = new Request(`https://kody.test${path}${search}`)
			let failure: unknown
			try {
				loadConnectOauth({ data: connectOauthInput(search) })
			} catch (error) {
				failure = error
			}
			expect(failure).toMatchObject({ isNotFound: true })
			expect(state.authenticated).not.toHaveBeenCalled()
			expect(state.operation).not.toHaveBeenCalled()
		},
	)
	test(`${path} rejects unknown and grant-only organization without reading connection data`, async () => {
		state.request = new Request(`https://kody.test${path}`)
		for (const binding of [null, { org: { slug: 'team' }, role: null }]) {
			state.binding.mockResolvedValue(binding)
			await expect(
				loadConnectOauth({
					data: connectOauthInput('?org=team&provider=github'),
				}),
			).rejects.toMatchObject({ isNotFound: true })
		}
		expect(state.operation).not.toHaveBeenCalled()
	})
	test(`${path} keeps absent personal scope and valid membership`, async () => {
		state.request = new Request(`https://kody.test${path}`)
		await loadConnectOauth({ data: connectOauthInput('?provider=github') })
		expect(state.binding).not.toHaveBeenCalled()
		await loadConnectOauth({
			data: connectOauthInput('?org=team&provider=github'),
		})
		expect(state.binding).toHaveBeenCalledWith(
			state.env.APP_DB,
			'owner',
			'team',
		)
		expect(state.operation).toHaveBeenCalledTimes(2)
		expect(state.operation.mock.calls[1]?.[3]).toMatchObject({
			request: { orgBinding: { org: { slug: 'team' }, role: 'member' } },
		})
	})
}

for (const path of ['/connect/oauth', '/_serverFn/connect']) {
	test(`${path} callback explicit unknown org returns notFound before callback metadata`, async () => {
		state.request = new Request(`https://kody.test${path}`)
		state.binding.mockResolvedValue(null)
		await expect(
			loadConnectOauth({
				data: connectOauthInput('?org=missing&code=callback'),
			}),
		).rejects.toMatchObject({ isNotFound: true })
		expect(state.operation).not.toHaveBeenCalled()
	})
	test(`${path} callback preserves grant-only and signed-out public metadata access`, async () => {
		state.request = new Request(`https://kody.test${path}`)
		state.binding.mockResolvedValue({ org: { slug: 'team' }, role: null })
		await loadConnectOauth({
			data: connectOauthInput('?org=team&code=callback'),
		})
		expect(state.operation).toHaveBeenCalledOnce()
		state.auth.mockResolvedValue({ user: null })
		state.binding.mockClear()
		await loadConnectOauth({
			data: connectOauthInput('?org=team&error=denied'),
		})
		expect(state.binding).not.toHaveBeenCalled()
		expect(state.operation).toHaveBeenCalledTimes(2)
	})
	test(`${path} native matched section verification denies grant-only private sections`, async () => {
		state.request = new Request(`https://kody.test${path}`)
		state.binding.mockResolvedValue({ org: { slug: 'team' }, role: null })
		await expect(
			verifySession({ data: { orgSlug: 'team', section: 'memories' } }),
		).rejects.toMatchObject({ isNotFound: true })
		await expect(
			verifySession({ data: { orgSlug: 'team', section: 'agents' } }),
		).resolves.toEqual({ actorKey: 'owner' })
	})
}
