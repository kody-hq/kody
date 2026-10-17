import { expect, test, vi } from 'vitest'
import { firstPartySecurityHeaders } from './security-headers.ts'
import { getEnv } from './env.ts'
import { handleRequest } from './handler.ts'
import { markSentryReported } from './sentry-reported-error.ts'
import { silenceExpectedConsoleErrors } from '#worker/test-support/console-spies.ts'
import { testOidcSigningEnv } from '#worker/test-support/oidc-signing-env.ts'

const captureException = vi.fn()

vi.mock('@sentry/cloudflare', async () => {
	const stub = await import('#worker/test-support/sentry-cloudflare-stub.ts')
	return {
		...stub,
		captureException: (...args: Array<unknown>) => captureException(...args),
	}
})

vi.mock('#app/router.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#app/router.ts')>()
	return {
		...actual,
		createAppRouter(env: Env) {
			const router = actual.createAppRouter(env)
			return {
				fetch(request: Request) {
					if (request.headers.get('x-kody-test-reported-error') === '1') {
						const error = new Error('ssr already reported')
						markSentryReported(error)
						return Promise.reject(error)
					}
					return router.fetch(request)
				},
			}
		},
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

test('account secrets api ignores legacy remote connector env secrets', async () => {
	const response = await handleRequest(
		new Request('https://example.com/account/secrets.json'),
		createEnv({}),
	)

	expect(response.status).toBe(401)
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error: 'Unauthorized.',
	})
})

test('getEnv memoizes per env identity and requires AUTH_RATE_LIMITER and Turnstile in production', () => {
	const env = createEnv()
	expect(getEnv(env)).toBe(getEnv(env))
	expect(getEnv(createEnv())).not.toBe(getEnv(env))
	expect(() => getEnv(createEnv({ SENTRY_ENVIRONMENT: 'production' }))).toThrow(
		'AUTH_RATE_LIMITER',
	)
	expect(() =>
		getEnv(
			createEnv({ SENTRY_ENVIRONMENT: 'production', AUTH_RATE_LIMITER: {} }),
		),
	).toThrow('TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY')
	expect(() =>
		getEnv(
			createEnv({
				SENTRY_ENVIRONMENT: 'production',
				AUTH_RATE_LIMITER: {},
				TURNSTILE_SITE_KEY: 'site-key',
			}),
		),
	).toThrow('TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY')
	expect(() =>
		getEnv(
			createEnv({
				SENTRY_ENVIRONMENT: 'production',
				AUTH_RATE_LIMITER: {},
				TURNSTILE_SITE_KEY: 'site-key',
				TURNSTILE_SECRET_KEY: 'secret-key',
			}),
		),
	).not.toThrow()
})

test('getEnv treats local wrangler (WRANGLER_IS_LOCAL_DEV) as non-production for boot guards', () => {
	// Local generated wrangler copies SENTRY_ENVIRONMENT=production from the
	// production env block but injects WRANGLER_IS_LOCAL_DEV=true (#3939).
	expect(() =>
		getEnv(
			createEnv({
				SENTRY_ENVIRONMENT: 'production',
				WRANGLER_IS_LOCAL_DEV: 'true',
			}),
		),
	).not.toThrow()
	expect(() =>
		getEnv(
			createEnv({
				SENTRY_ENVIRONMENT: 'production',
				WRANGLER_IS_LOCAL_DEV: 'true',
				AUTH_RATE_LIMITER: {},
			}),
		),
	).not.toThrow()
})

test('handleRequest serves multiple requests from the same env object', async () => {
	const env = createEnv()
	const first = await handleRequest(
		new Request('https://example.com/health'),
		env,
	)
	const second = await handleRequest(
		new Request('https://example.com/health'),
		env,
	)

	expect(first.status).toBe(200)
	expect(second.status).toBe(200)
	await expect(second.json()).resolves.toMatchObject({ ok: true })
})

test('uncaught handler failures return an illustrated HTML 500 with a document title, lang, and CSP', async () => {
	silenceExpectedConsoleErrors([
		'Remix server handler failed:',
		'Illustrated 500 shell failed:',
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
		'Remix server handler failed:',
		'Illustrated 500 shell failed:',
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

test('removed blog posts are a 404 with no redirect', async () => {
	const response = await handleRequest(
		new Request('https://example.com/blog/kody-vs-executor', {
			redirect: 'manual',
		}),
		createEnv(),
	)

	expect(response.status).toBe(404)
	expect(response.headers.get('location')).toBeNull()
	await expect(response.text()).resolves.toContain(
		'data-testid="not-found-page"',
	)
})
