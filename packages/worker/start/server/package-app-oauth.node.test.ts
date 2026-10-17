import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	resolve: vi.fn(),
	limit: vi.fn(),
	host: vi.fn(),
	mutation: vi.fn(),
	header: vi.fn(),
	request: new Request('https://kody.test/_serverFn/consent', {
		headers: { Origin: 'https://kody.test', Cookie: 'session=actor' },
	}),
	dedicatedHost: '',
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let parse: { parse(input: unknown): unknown }
		const builder = {
			validator(value: typeof parse) {
				parse = value
				return builder
			},
			handler(run: (input: { data: unknown }) => Promise<unknown>) {
				return async (input: { data: unknown }) =>
					run({ data: parse.parse(input.data) })
			},
		}
		return builder
	},
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => state.request,
	setResponseHeader: state.header,
	setResponseStatus: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({
	redirect: (options: unknown) => ({ redirect: options }),
}))
vi.mock('./request-env.ts', () => ({
	getStartRequestEnv: () => ({ COOKIE_SECRET: 'secret' }),
}))
vi.mock('./mutation-context.ts', () => ({
	withWebsiteMutation: async (
		options: unknown,
		run: (context: unknown) => Promise<unknown>,
	) => {
		state.mutation(options)
		return run({ request: state.request, env: {}, user: { id: 'actor' } })
	},
}))
vi.mock('../../src/app/package-app-oauth-authorize.ts', () => ({
	handlePackageAppOauthAuthorizeRequest: state.resolve,
}))
vi.mock('../../src/app/package-app-oauth-host-auth.ts', () => ({
	handlePackageAppOauthHostAuth: state.host,
}))
vi.mock('../../src/app-base-url.ts', () => ({
	getPackageAppBaseUrl: () => state.dedicatedHost,
}))
vi.mock('../../src/app/rate-limit.ts', () => ({
	checkAuthRateLimit: state.limit,
}))
vi.mock('../../src/audit-log.ts', () => ({
	getRequestIp: () => '198.51.100.2',
}))
import {
	loadPackageAppOauthConsent,
	decidePackageAppOauthConsent,
} from './package-app-oauth.ts'
import {
	packageAppOauthAuthorizeDocument,
	packageAppOauthAuthorizePost,
	packageAppOauthHostAuth,
} from './package-app-oauth-protocol.ts'
beforeEach(() => {
	vi.clearAllMocks()
	state.dedicatedHost = ''
	state.limit.mockReset().mockResolvedValue({ allowed: true })
	state.resolve.mockReset().mockResolvedValue({ consent: { ok: true } })
})

test('native consent reads cannot skip consent or mint a code, document dispatch alone can', async () => {
	await loadPackageAppOauthConsent({ data: '?client_id=owner%2Fapp&state=123' })
	expect(state.resolve).toHaveBeenLastCalledWith(
		expect.any(Request),
		expect.any(Object),
		{ allowConsentSkip: false },
	)
	const read = state.resolve.mock.calls.at(-1)![0] as Request
	expect(read.url).toBe(
		'https://kody.test/oauth/package-app/authorize?client_id=owner%2Fapp&state=123',
	)
	const response = new Response(null, {
		status: 302,
		headers: { Location: 'https://app.test/callback?code=one-time' },
	})
	state.resolve.mockResolvedValue(response)
	const next = vi.fn()
	expect(
		await packageAppOauthAuthorizeDocument({ request: state.request, next }),
	).toBe(response)
	expect(next).not.toHaveBeenCalled()
	expect(state.resolve).toHaveBeenLastCalledWith(
		state.request,
		expect.any(Object),
		{ allowConsentSkip: true },
	)
})

test('native decisions use the website write boundary and preserve protocol fields and redirect', async () => {
	const destination =
		'https://app.test/callback?code=code&state=literal%2Bstate'
	state.resolve.mockResolvedValue(
		new Response(null, { status: 302, headers: { Location: destination } }),
	)
	await expect(
		decidePackageAppOauthConsent({
			data: {
				fields: {
					client_id: 'owner/app',
					state: 'literal+state',
					decision: 'deny',
				},
				decision: 'approve',
			},
		}),
	).rejects.toEqual({ redirect: { href: destination, reloadDocument: true } })
	expect(state.mutation).toHaveBeenCalledWith({})
	const request = state.resolve.mock.calls.at(-1)![0] as Request
	expect(request.method).toBe('POST')
	expect(request.headers.get('Origin')).toBe('https://kody.test')
	expect(request.headers.get('Cookie')).toBe('session=actor')
	const form = await request.formData()
	expect(form.get('state')).toBe('literal+state')
	expect(form.get('decision')).toBe('approve')
	state.resolve.mockResolvedValue(
		new Response('Cross-origin consent posts are not allowed.', {
			status: 403,
		}),
	)
	await expect(
		decidePackageAppOauthConsent({ data: { fields: {}, decision: 'deny' } }),
	).rejects.toThrow('Cross-origin')
})

test('real protocol POST remains a response and host-auth fallback runs only without a dedicated host', async () => {
	const response = new Response(null, { status: 302 })
	state.resolve.mockResolvedValue(response)
	expect(await packageAppOauthAuthorizePost({ request: state.request })).toBe(
		response,
	)
	state.host.mockResolvedValue(response)
	expect(await packageAppOauthHostAuth({ request: state.request })).toBe(
		response,
	)
	state.dedicatedHost = 'https://packages.test'
	expect(
		(await packageAppOauthHostAuth({ request: state.request })).status,
	).toBe(404)
	expect(state.host).toHaveBeenCalledOnce()
})

test('native decisions share the protocol auth rate limit before issuing a code', async () => {
	state.limit.mockResolvedValue({ allowed: false, retryAfterSeconds: 15 })
	await expect(
		decidePackageAppOauthConsent({ data: { fields: {}, decision: 'approve' } }),
	).rejects.toThrow('Too many requests')
	expect(state.limit).toHaveBeenCalledWith(
		expect.any(Object),
		'auth:ip:198.51.100.2',
	)
	expect(state.resolve).not.toHaveBeenCalled()
	expect(state.header).toHaveBeenCalledWith('Retry-After', '15')
})
