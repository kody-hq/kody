import { expect, test, vi } from 'vitest'
import { firstPartySecurityHeaders } from '../src/app/security-headers.ts'
import { getEnv } from '../src/app/env.ts'
import { createHttpRequestHandler } from './http-entry.ts'
import { markSentryReported } from '../src/app/sentry-reported-error.ts'
import { silenceExpectedConsoleErrors } from '#worker/test-support/console-spies.ts'
import { testOidcSigningEnv } from '#worker/test-support/oidc-signing-env.ts'

const captureException = vi.fn()
const renderDocument = vi.fn(async (request: Request) => {
	const error = new Error('Renderer unavailable')
	if (request.headers.get('x-kody-test-reported-error') === '1')
		markSentryReported(error)
	throw error
})
const handleRequest = createHttpRequestHandler(renderDocument)

vi.mock('@sentry/cloudflare', async () => {
	const stub = await import('#worker/test-support/sentry-cloudflare-stub.ts')
	return {
		...stub,
		captureException: (...args: Array<unknown>) => captureException(...args),
	}
})

function createEnv(overrides: Record<string, unknown> = {}) {
	return {
		COOKIE_SECRET: 'LOCAL_TEST_COOKIE_SECRET_32_CHARS_MINIMUM',
		SECRET_STORE_KEY: 'LOCAL_TEST_SECRET_STORE_KEY_32_CHARS_MINIMUM',
		...testOidcSigningEnv,
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {},
		JOB_MANAGER: {},
		STORAGE_RUNNER: {},
		PACKAGE_REALTIME_SESSION: {},
		MCP_CLIENT_HUB: {},
		...overrides,
	} as unknown as Env
}

test('server-function requests reach Start without legacy endpoint authorization', async () => {
	vi.stubEnv('TSS_SERVER_FN_BASE', '/_serverFn/')
	const render = vi.fn(async () => new Response('rpc'))
	const handle = createHttpRequestHandler(render)
	const request = new Request('https://example.com/_serverFn/test', {
		method: 'POST',
		headers: { 'x-tsr-serverFn': 'true' },
	})
	const response = await handle(request, createEnv())
	expect(response.status).toBe(200)
	expect(render).toHaveBeenCalledWith(request, expect.anything())
	vi.unstubAllEnvs()
})

test('getEnv memoizes per env identity and requires production rate limiting and Turnstile', () => {
	const env = createEnv()
	expect(getEnv(env)).toBe(getEnv(env))
	expect(getEnv(createEnv())).not.toBe(getEnv(env))
	expect(() => getEnv(createEnv({ SENTRY_ENVIRONMENT: 'production' }))).toThrow(
		'AUTH_RATE_LIMITER',
	)
	for (const keys of [
		{},
		{ TURNSTILE_SITE_KEY: 'test-site' },
		{ TURNSTILE_SECRET_KEY: 'test-secret' },
		{ TURNSTILE_SITE_KEY: ' ', TURNSTILE_SECRET_KEY: 'test-secret' },
	]) {
		expect(() =>
			getEnv(
				createEnv({
					SENTRY_ENVIRONMENT: 'production',
					AUTH_RATE_LIMITER: {},
					...keys,
				}),
			),
		).toThrow('TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY')
	}
	expect(() =>
		getEnv(
			createEnv({
				SENTRY_ENVIRONMENT: 'production',
				AUTH_RATE_LIMITER: {},
				TURNSTILE_SITE_KEY: 'test-site',
				TURNSTILE_SECRET_KEY: 'test-secret',
			}),
		),
	).not.toThrow()
})

test('local wrangler can boot without production Turnstile and rate limiter bindings', () => {
	expect(() =>
		getEnv(
			createEnv({
				SENTRY_ENVIRONMENT: 'production',
				WRANGLER_IS_LOCAL_DEV: 'true',
			}),
		),
	).not.toThrow()
})

test('HTTP boundary dispatches multiple requests from the same env to Start', async () => {
	const render = vi.fn(async () => Response.json({ ok: true }))
	const handle = createHttpRequestHandler(render)
	const env = createEnv()
	const first = await handle(new Request('https://example.com/health'), env)
	const second = await handle(new Request('https://example.com/health'), env)
	expect(first.status).toBe(200)
	expect(second.status).toBe(200)
	expect(render).toHaveBeenCalledTimes(2)
	await expect(second.json()).resolves.toMatchObject({ ok: true })
})

test('invalid bindings return the static illustrated 500 with document title, lang, and CSP', async () => {
	silenceExpectedConsoleErrors([
		'Native app request failed:',
		'Native error document failed:',
	])
	captureException.mockClear()
	const response = await handleRequest(
		new Request('https://example.com/health'),
		createEnv({ SENTRY_ENVIRONMENT: 'production' }),
	)
	const body = await response.text()

	expect(response.status).toBe(500)
	expect(response.headers.get('content-type')).toMatch(/text\/html/)
	expect(body).toContain('lang="en"')
	expect(body).toContain('<title>Something went wrong — Kody</title>')
	expect(body).toContain('data-testid="internal-error-page"')
	expect(body).toContain('data-error-agent-prompt')
	expect(body).toContain('We got a little zapped.')
	expect(body).toContain('src="/images/kody-500-zapped.png"')
	expect(body).toContain('Try again')
	expect(body).toContain('href="/"')
	expect(response.headers.get('Content-Security-Policy')).toBe(
		firstPartySecurityHeaders['Content-Security-Policy'],
	)
	expect(captureException).toHaveBeenCalledTimes(1)
	expect(captureException).toHaveBeenCalledWith(
		expect.any(Error),
		expect.objectContaining({
			tags: expect.objectContaining({
				surface: 'app-router',
				pathname: '/health',
			}),
		}),
	)
})

test('handleRequest skips Sentry when SSR already reported the failure', async () => {
	silenceExpectedConsoleErrors([
		'Native app request failed:',
		'Native error document failed:',
	])
	captureException.mockClear()
	const response = await handleRequest(
		new Request('https://example.com/account', {
			headers: { 'x-kody-test-reported-error': '1' },
		}),
		createEnv({ AUTH_RATE_LIMITER: {} }),
	)

	expect(response.status).toBe(500)
	expect(captureException).not.toHaveBeenCalled()
})

test('unmapped document requests go to the native renderer with the original URL', async () => {
	const render = vi.fn(async () => new Response('document'))
	const handle = createHttpRequestHandler(render)
	const request = new Request(
		'https://example.com/blog/kody-vs-executor?test=1',
	)
	const response = await handle(request, createEnv())
	expect(response.status).toBe(200)
	expect(render).toHaveBeenCalledWith(request, expect.anything())
})

test('a failed native mutation is never dispatched again to render an error', async () => {
	silenceExpectedConsoleErrors(['Native app request failed:'])
	vi.stubEnv('TSS_SERVER_FN_BASE', '/_serverFn/')
	try {
		let committedWrites = 0
		const render = vi.fn(async () => {
			committedWrites++
			throw new Error('failed after commit')
		})
		const handle = createHttpRequestHandler(render)
		const response = await handle(
			new Request('https://example.com/_serverFn/mutation', { method: 'POST' }),
			createEnv(),
		)
		expect(response.status).toBe(500)
		expect(await response.text()).toContain('/images/kody-500-zapped.png')
		expect(committedWrites).toBe(1)
		expect(render).toHaveBeenCalledTimes(1)
	} finally {
		vi.unstubAllEnvs()
	}
})

test('legacy org connection bookmarks redirect through the native route', async () => {
	const { connectionsRedirect } = await import('./server/legacy-redirects.ts')
	const response = connectionsRedirect({
		request: new Request(
			'https://example.com/@acme/-/connections/usage?connection=abc',
		),
	})
	expect(response.status).toBe(301)
	expect(response.headers.get('Location')).toBe(
		'/@acme/-/agents/usage?connection=abc',
	)
})

test.each([200, 301, 403, 500])(
	'RPC responses enforce private caching after rendering (%i)',
	async (status) => {
		vi.stubEnv('TSS_SERVER_FN_BASE', '/_serverFn/')
		try {
			const handle = createHttpRequestHandler(
				async () =>
					new Response('serialized result', {
						status,
						headers: {
							'Cache-Control': 'public, max-age=3600',
							Location: '/community/canonical',
							'Set-Cookie': 'session=refreshed; HttpOnly',
						},
					}),
			)
			const response = await handle(
				new Request('https://example.com/_serverFn/read'),
				createEnv(),
			)
			expect(response.status).toBe(status)
			expect(response.headers.get('Cache-Control')).toBe('private, no-store')
			expect(response.headers.get('Location')).toBe('/community/canonical')
			expect(response.headers.get('Set-Cookie')).toBe(
				'session=refreshed; HttpOnly',
			)
			expect(await response.text()).toBe('serialized result')
		} finally {
			vi.unstubAllEnvs()
		}
	},
)

test('canonical document redirects retain their public cache policy', async () => {
	const handle = createHttpRequestHandler(
		async () =>
			new Response(null, {
				status: 301,
				headers: {
					'Cache-Control': 'public, max-age=3600',
					Location: '/community/canonical',
				},
			}),
	)
	const response = await handle(
		new Request('https://example.com/community/old'),
		createEnv(),
	)
	expect(response.status).toBe(301)
	expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600')
	expect(response.headers.get('Location')).toBe('/community/canonical')
})
