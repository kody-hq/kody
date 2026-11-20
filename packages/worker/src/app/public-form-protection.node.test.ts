import { expect, test, vi } from 'vitest'
import {
	getTurnstileSiteKey,
	honeypotFieldName,
	verifyPublicFormProtection,
} from '#app/public-form-protection.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const captureException = vi.fn()

vi.mock('@sentry/cloudflare', async () => {
	const stub = await import('#worker/test-support/sentry-cloudflare-stub.ts')
	return {
		...stub,
		captureException: (...args: Array<unknown>) => captureException(...args),
	}
})

type PublicFormProtectionEnv = {
	TURNSTILE_SITE_KEY?: string | undefined
	TURNSTILE_SECRET_KEY?: string | undefined
	SENTRY_ENVIRONMENT?: string | undefined
	WRANGLER_IS_LOCAL_DEV?: string | undefined
}

function formProtectionEnv(env: PublicFormProtectionEnv) {
	return env
}

test('public form protection defaults closed, rejects honeypots, and verifies Turnstile', async () => {
	expect(
		getTurnstileSiteKey(
			formProtectionEnv({
				TURNSTILE_SITE_KEY: 'site-key',
			}),
		),
	).toBeNull()

	const request = new Request('https://example.com/auth', {
		method: 'POST',
		headers: { 'CF-Connecting-IP': '203.0.113.10' },
	})
	const localOmitKeys = formProtectionEnv({ WRANGLER_IS_LOCAL_DEV: 'true' })
	await expect(
		verifyPublicFormProtection({
			env: localOmitKeys,
			request,
			body: {},
		}),
	).resolves.toEqual({ ok: true })

	const honeypot = await verifyPublicFormProtection({
		env: localOmitKeys,
		request,
		body: { [honeypotFieldName]: 'https://spam.example' },
	})
	expect(honeypot.ok).toBe(false)
	if (honeypot.ok) throw new Error('Expected honeypot rejection.')
	expect(honeypot.response.status).toBe(400)
	expect(await honeypot.response.json()).toEqual({
		error: 'Unable to submit this form.',
	})

	await expect(
		verifyPublicFormProtection({
			env: localOmitKeys,
			request,
			body: { website: 'https://kody.codes' },
		}),
	).resolves.toEqual({ ok: true })

	const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
		expect(init.method).toBe('POST')
		const body = new URLSearchParams(String(init.body))
		expect(body.get('secret')).toBe('secret-key')
		expect(['valid-token', 'foreign-host-token']).toContain(
			body.get('response'),
		)
		expect(body.get('remoteip')).toBe('203.0.113.11')
		return Response.json({
			success: true,
			hostname:
				body.get('response') === 'foreign-host-token'
					? 'kody-pr-99.kody-a99.workers.dev'
					: 'example.com',
		})
	})
	vi.stubGlobal('fetch', fetchSpy)
	try {
		const env = {
			TURNSTILE_SITE_KEY: 'site-key',
			TURNSTILE_SECRET_KEY: 'secret-key',
		}
		const turnstileRequest = new Request('https://example.com/auth', {
			method: 'POST',
			headers: { 'CF-Connecting-IP': '203.0.113.11' },
		})

		const missing = await verifyPublicFormProtection({
			env,
			request: turnstileRequest,
			body: {},
		})
		expect(missing.ok).toBe(false)
		if (missing.ok) throw new Error('Expected missing-token rejection.')
		expect(missing.response.status).toBe(400)
		expect(await missing.response.json()).toEqual({
			error: 'Please complete the human verification challenge.',
		})
		expect(fetchSpy).not.toHaveBeenCalled()

		await expect(
			verifyPublicFormProtection({
				env,
				request: turnstileRequest,
				body: { turnstileToken: 'valid-token' },
			}),
		).resolves.toEqual({ ok: true })
		expect(fetchSpy).toHaveBeenCalledOnce()

		fetchSpy.mockClear()
		consoleWarn.mockImplementation(() => {})
		const foreign = await verifyPublicFormProtection({
			env,
			request: turnstileRequest,
			body: { turnstileToken: 'foreign-host-token' },
		})
		expect(foreign.ok).toBe(false)
		if (foreign.ok) throw new Error('Expected foreign-hostname rejection.')
		expect(foreign.response.status).toBe(400)
		expect(await foreign.response.json()).toEqual({
			error: 'Human verification failed. Please try again.',
		})
		expect(consoleWarn).toHaveBeenCalledWith(
			expect.stringContaining(
				'"turnstile-hostname-mismatch",{"expected":"example.com","received":"kody-pr-99.kody-a99.workers.dev"}',
			),
		)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('non-production-unknown runtimes refuse when either Turnstile key is missing and report to Sentry', async () => {
	captureException.mockClear()
	const request = new Request('https://example.com/auth', { method: 'POST' })

	const missingBoth = await verifyPublicFormProtection({
		env: formProtectionEnv({ SENTRY_ENVIRONMENT: 'production' }),
		request,
		body: {},
	})
	expect(missingBoth.ok).toBe(false)
	if (missingBoth.ok) throw new Error('Expected production fail-closed.')
	expect(missingBoth.response.status).toBe(503)
	expect(await missingBoth.response.json()).toEqual({
		error:
			'Human verification is not configured on this deployment. Please try again later.',
	})
	expect(captureException).toHaveBeenCalledTimes(1)
	expect(captureException).toHaveBeenCalledWith(
		expect.objectContaining({
			message:
				'Production public forms require TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY.',
		}),
		expect.objectContaining({
			tags: expect.objectContaining({
				surface: 'public-form-protection',
				reason: 'turnstile-keys-missing',
			}),
		}),
	)

	captureException.mockClear()
	const unsetEnv = await verifyPublicFormProtection({
		env: formProtectionEnv({}),
		request,
		body: {},
	})
	expect(unsetEnv.ok).toBe(false)
	if (unsetEnv.ok) throw new Error('Expected unset-env fail-closed.')
	expect(unsetEnv.response.status).toBe(503)
	expect(captureException).toHaveBeenCalledTimes(1)

	captureException.mockClear()
	const siteOnly = await verifyPublicFormProtection({
		env: formProtectionEnv({
			SENTRY_ENVIRONMENT: 'production',
			TURNSTILE_SITE_KEY: 'site-key',
		}),
		request,
		body: {},
	})
	expect(siteOnly.ok).toBe(false)
	if (siteOnly.ok) throw new Error('Expected partial-key fail-closed.')
	expect(siteOnly.response.status).toBe(503)
	expect(captureException).toHaveBeenCalledTimes(1)

	captureException.mockClear()
	const secretOnly = await verifyPublicFormProtection({
		env: formProtectionEnv({
			SENTRY_ENVIRONMENT: 'production',
			TURNSTILE_SECRET_KEY: 'secret-key',
		}),
		request,
		body: {},
	})
	expect(secretOnly.ok).toBe(false)
	if (secretOnly.ok) throw new Error('Expected partial-key fail-closed.')
	expect(secretOnly.response.status).toBe(503)
	expect(captureException).toHaveBeenCalledTimes(1)

	captureException.mockClear()
	await expect(
		verifyPublicFormProtection({
			env: formProtectionEnv({
				SENTRY_ENVIRONMENT: 'preview',
			}),
			request,
			body: {},
		}),
	).resolves.toEqual({ ok: true })
	expect(captureException).not.toHaveBeenCalled()
})
