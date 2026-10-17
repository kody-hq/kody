import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	read: vi.fn(),
	resolved: vi.fn(),
	header: vi.fn(),
	status: vi.fn(),
	request: new Request('https://kody.test/_serverFn/admin'),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let validate = (value: unknown) => value
		const builder = {
			validator(parser: { parse: (value: unknown) => unknown }) {
				validate = parser.parse
				return builder
			},
			handler(run: (input: { data: unknown }) => Promise<unknown>) {
				return async (input: { data: unknown }) =>
					run({ data: validate(input.data) })
			},
		}
		return builder
	},
}))
vi.mock('cloudflare:workers', () => ({ env: { COOKIE_SECRET: 'test' } }))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => state.request,
	setResponseHeader: state.header,
	setResponseStatus: state.status,
}))
vi.mock('../../src/app/env.ts', () => ({ getEnv: (value: unknown) => value }))
vi.mock('../../src/app/auth-session.ts', () => ({
	setAuthSessionSecret: vi.fn(),
}))
vi.mock('../../src/app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: state.read,
}))
vi.mock('../../src/app/request-auth-cache.ts', () => ({
	loadResolvedRequestAuth: state.resolved,
}))
import { loadAdminIndex } from './admin-index.ts'
import { readAdminPageContext } from './admin-page-context.ts'
beforeEach(() => {
	vi.clearAllMocks()
	state.resolved.mockResolvedValue({ setCookie: 'kody_session=; Max-Age=0' })
})
test('unauthenticated reads clear stale cookies and redirect to the explicit admin destination', async () => {
	state.read.mockResolvedValue(null)
	const failure = await readAdminPageContext('/admin/users?q=ada').catch(
		(error) => error,
	)
	expect(failure.options.href).toBe(
		'/login?redirectTo=%2Fadmin%2Fusers%3Fq%3Dada',
	)
	expect(state.header).toHaveBeenCalledWith(
		'Set-Cookie',
		'kody_session=; Max-Age=0',
	)
})
test('non-admin reads return forbidden state without serializing a transport response', async () => {
	state.read.mockResolvedValue({ roles: ['user'] })
	const context = await readAdminPageContext('/admin/users')
	expect(context.user).toBeNull()
	expect(state.status).toHaveBeenCalledWith(403)
	expect(context.request).toBe(state.request)
	expect(context.url.pathname).toBe('/admin/users')
})
test('admin reads use the original authenticated request and private cache policy', async () => {
	const user = { roles: ['admin'] }
	state.read.mockResolvedValue(user)
	const context = await readAdminPageContext('/admin/users')
	expect(context.user).toBe(user)
	expect(state.read).toHaveBeenCalledWith(state.request, expect.anything(), {
		prefetchFeatureFlags: true,
	})
	expect(state.header).toHaveBeenCalledWith(
		'Cache-Control',
		'private, no-store',
	)
})

test('admin index checks authentication before redirecting to the user list', async () => {
	state.read.mockResolvedValue(null)
	const failure = await loadAdminIndex({ data: { returnTo: '/admin/' } }).catch(
		(error) => error,
	)
	expect(failure.options.href).toBe('/login?redirectTo=%2Fadmin%2F')
	expect(state.header).toHaveBeenCalledWith(
		'Set-Cookie',
		'kody_session=; Max-Age=0',
	)
})
test('admin index renders a native forbidden result with HTTP 403 for members', async () => {
	state.read.mockResolvedValue({ roles: ['user'] })
	await expect(
		loadAdminIndex({ data: { returnTo: '/admin' } }),
	).resolves.toEqual({
		forbidden: true,
	})
	expect(state.status).toHaveBeenCalledWith(403)
})
test('admin index redirects authorized administrators using Router redirect', async () => {
	state.read.mockResolvedValue({ roles: ['admin'] })
	const failure = await loadAdminIndex({ data: { returnTo: '/admin' } }).catch(
		(error) => error,
	)
	expect(failure.options.to).toBe('/admin/users')
	expect(failure.options.statusCode).toBe(302)
})
test.each([
	'/administrator',
	'/admin/missing',
	'//other.test/admin',
	'/admin/../login',
])(
	'admin index refuses an unrelated destination %s before authentication',
	async (href) => {
		await expect(loadAdminIndex({ data: { returnTo: href } })).rejects.toThrow()
		expect(state.read).not.toHaveBeenCalled()
	},
)
