import { expect, test, vi } from 'vitest'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { originWorkerHandler } from './origin-handler.ts'

test('claim forms use the auth IP limit', async () => {
	const limit = vi.fn(async (_options: RateLimitOptions) => ({
		success: false,
	}))
	const ctx = createExecutionContext()
	const fetch = originWorkerHandler.fetch
	if (!fetch) throw new Error('Expected the origin fetch handler.')
	const response = await fetch(
		new Request('https://test.kody.dev/claim/example', {
			method: 'POST',
			headers: {
				'CF-Connecting-IP': '203.0.113.8',
				Origin: 'https://test.kody.dev',
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: 'action=email_start',
		}),
		{ ...env, AUTH_RATE_LIMITER: { limit } },
		ctx,
	)
	await waitOnExecutionContext(ctx)
	expect(limit).toHaveBeenCalledWith({ key: 'auth:ip:203.0.113.8' })
	expect(response.status).toBe(303)
	expect(response.headers.get('Location')).toBe(
		'/claim/example?error=rate_limited',
	)
})
