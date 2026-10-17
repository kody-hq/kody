import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	request: new Request('https://kody.test/_serverFn/auth?redirectTo=%2Fwrong', {
		headers: { cookie: 'original=session' },
	}),
	session: vi.fn(),
	header: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let validate: (data: unknown) => unknown
		const builder = {
			validator(fn: typeof validate) {
				validate = fn
				return builder
			},
			handler(fn: (args: { data: unknown }) => unknown) {
				return (args: { data: unknown }) => fn({ data: validate(args.data) })
			},
		}
		return builder
	},
}))
vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('../../src/app/env.ts', () => ({
	getEnv: () => ({ COOKIE_SECRET: 'trusted' }),
}))
vi.mock('../../src/app/auth-session.ts', () => ({
	setAuthSessionSecret: vi.fn(),
}))
vi.mock('../../src/app/session-info.ts', () => ({
	loadSessionInfo: state.session,
}))
vi.mock('../../src/app/oauth-providers.ts', () => ({
	getEnabledOauthProviders: () => [],
	oauthProviderDefinitions: {},
}))
vi.mock('../../src/app/public-form-protection.ts', () => ({
	getTurnstileSiteKey: () => null,
}))
vi.mock(
	'../../src/app/auth-redirect.ts',
	async () => import('../../universal/safe-redirect.ts'),
)
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => state.request,
	setResponseHeader: state.header,
}))
import { loadAuthPage } from './auth-page.ts'
beforeEach(() => {
	vi.clearAllMocks()
	state.session.mockResolvedValue({
		session: { username: 'member' },
		setCookie: 'session=renewed',
	})
})
test.each([
	['/account/security', '/account/security'],
	['https://evil.test', '/account'],
	['//evil.test', '/account'],
	[null, '/account'],
])(
	'auth uses the explicit safe return destination %s',
	async (redirectTo, destination) => {
		await expect(loadAuthPage({ data: { redirectTo } })).rejects.toMatchObject({
			options: { href: destination, statusCode: 302 },
		})
		expect(state.session).toHaveBeenCalledWith(state.request, {
			COOKIE_SECRET: 'trusted',
		})
		expect(state.header).toHaveBeenCalledWith('Set-Cookie', 'session=renewed')
	},
)
test('auth returns configuration without redirecting unauthenticated requests', async () => {
	state.session.mockResolvedValue({ session: null })
	await expect(
		loadAuthPage({ data: { redirectTo: '/account' } }),
	).resolves.toMatchObject({
		authConfig: { ok: true, providers: [] },
	})
})
