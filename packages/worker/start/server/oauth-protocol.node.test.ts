import { beforeEach, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
	env: { OAUTH_PROVIDER: { marker: 'request provider' } },
	silent: vi.fn<(request: Request, env: unknown) => Promise<Response | null>>(
		async () => null,
	),
	post: vi.fn(async () => new Response('approved')),
	protect: vi.fn(async () => ({
		ok: true,
		response: new Response('blocked', { status: 403 }),
	})),
	discard: vi.fn(),
	status: vi.fn(),
	report: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	getGlobalStartContext: () => ({ env: mocks.env }),
}))
vi.mock('../../src/app/env.ts', () => ({ getEnv: (env: unknown) => env }))
vi.mock('@sentry/cloudflare', () => ({ captureException: mocks.report }))
vi.mock('@tanstack/react-start/server', () => ({
	setResponseStatus: mocks.status,
}))
vi.mock('../../src/oauth-handlers.ts', () => ({
	tryHandleSilentOidcAuthorize: mocks.silent,
	handleAuthorizeRequest: mocks.post,
	handleAuthorizeRouteException: () => new Response('failed', { status: 500 }),
}))
vi.mock('../../src/app/public-form-protection.ts', () => ({
	verifyPublicFormProtection: mocks.protect,
}))
vi.mock('../../src/request-body.ts', () => ({
	discardUnreadRequestBody: mocks.discard,
}))
import {
	oauthAuthorizeDocument,
	oauthAuthorizePost,
	oauthCallbackDocument,
	rejectOAuthAuthorizeMethod,
} from './oauth-protocol.ts'
beforeEach(() => vi.clearAllMocks())
test('interactive authorization falls through once without pre-reading consent or cloning the request', async () => {
	const request = new Request(
		'https://kody.test/oauth/authorize?client_id=one&client_id=two',
	)
	const response = new Response('consent', {
		headers: { 'Set-Cookie': 'session=rotated' },
	})
	const next = vi.fn(async () => response)
	expect(await oauthAuthorizeDocument({ request, next })).toBe(response)
	expect(mocks.silent).toHaveBeenCalledExactlyOnceWith(request, mocks.env)
	expect(next).toHaveBeenCalledTimes(1)
})
test('silent authorization returns its response without rendering or reading consent again', async () => {
	const response = new Response(null, {
		status: 302,
		headers: { Location: 'https://client.test/callback?code=one' },
	})
	mocks.silent.mockResolvedValueOnce(response)
	const next = vi.fn(async () => new Response('unexpected'))
	expect(
		await oauthAuthorizeDocument({
			request: new Request('https://kody.test/oauth/authorize?prompt=none'),
			next,
		}),
	).toBe(response)
	expect(next).not.toHaveBeenCalled()
})
test('unsupported methods including HEAD cannot authorize', () => {
	const response = rejectOAuthAuthorizeMethod()
	expect(response.status).toBe(405)
	expect(response.headers.get('Allow')).toBe('GET, POST')
	expect(mocks.silent).not.toHaveBeenCalled()
	expect(mocks.post).not.toHaveBeenCalled()
})
test('credential submissions retain bot protection before authorization', async () => {
	mocks.protect.mockResolvedValueOnce({
		ok: false,
		response: new Response('blocked', { status: 403 }),
	})
	const request = new Request('https://kody.test/oauth/authorize', {
		method: 'POST',
		body: new URLSearchParams({
			email: 'user@example.com',
			password: 'secret',
		}),
	})
	expect((await oauthAuthorizePost({ request })).status).toBe(403)
	expect(mocks.post).not.toHaveBeenCalled()
	expect(mocks.discard).toHaveBeenCalledWith(request)
})
test('approval posts preserve the original body and operation response', async () => {
	const request = new Request('https://kody.test/oauth/authorize', {
		method: 'POST',
		body: new URLSearchParams({ decision: 'approve' }),
	})
	await oauthAuthorizePost({ request })
	expect(mocks.protect).not.toHaveBeenCalled()
	expect(mocks.post).toHaveBeenCalledExactlyOnceWith(request, mocks.env)
	expect((await request.formData()).get('decision')).toBe('approve')
})
test.each(['?error=', '?error_description=denied', '?error=access_denied'])(
	'callback preserves error presence status for %s',
	async (search) => {
		const response = new Response('callback')
		expect(
			await oauthCallbackDocument({
				request: new Request(`https://kody.test/oauth/callback${search}`),
				next: async () => response,
			}),
		).toBe(response)
		expect(mocks.status).toHaveBeenCalledWith(400)
	},
)
test('successful callback sets its own status without reusing prior failure status', async () => {
	await oauthCallbackDocument({
		request: new Request('https://kody.test/oauth/callback?code=ok'),
		next: async () => new Response('ok'),
	})
	expect(mocks.status).toHaveBeenCalledExactlyOnceWith(200)
})
