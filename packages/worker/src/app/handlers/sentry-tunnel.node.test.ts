import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	buildEnvelopeIngestUrl,
	createSentryTunnelHandler,
} from './sentry-tunnel.ts'
import { sentryTunnelRateLimitConfig } from '#app/rate-limit.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

const configuredDsn = 'https://publickey@o123.ingest.us.sentry.io/456'

function createAppDb() {
	return createD1FromSqlite(new DatabaseSync(':memory:'))
}

function buildEnvelope(dsn?: string) {
	const header = JSON.stringify(dsn ? { dsn } : {})
	return `${header}\n{"type":"event"}\n{"message":"boom"}`
}

function tunnelRequest(
	body: string | ArrayBuffer,
	headers: Record<string, string> = {},
) {
	const length =
		typeof body === 'string'
			? new TextEncoder().encode(body).byteLength
			: body.byteLength
	return {
		request: new Request('http://example.com/sentry-tunnel', {
			method: 'POST',
			headers: { 'content-length': String(length), ...headers },
			body,
		}),
		url: new URL('http://example.com/sentry-tunnel'),
	} as unknown as Parameters<ReturnType<typeof createSentryTunnelHandler>>[0]
}

function stubFetch(fetchMock: ReturnType<typeof vi.fn>) {
	vi.stubGlobal('fetch', fetchMock)
	return {
		[Symbol.dispose]() {
			vi.unstubAllGlobals()
		},
	}
}

test('buildEnvelopeIngestUrl derives the envelope endpoint from the DSN', () => {
	expect(buildEnvelopeIngestUrl(configuredDsn)).toBe(
		'https://o123.ingest.us.sentry.io/api/456/envelope/',
	)
	expect(buildEnvelopeIngestUrl('not a url')).toBeNull()
	expect(buildEnvelopeIngestUrl('https://key@host.example.com/')).toBeNull()
	// Self-hosted Sentry under a base path keeps the path prefix.
	expect(
		buildEnvelopeIngestUrl('https://key@sentry.example.com/sentry/456'),
	).toBe('https://sentry.example.com/sentry/api/456/envelope/')
})

test('sentry tunnel forwards matching envelopes and rejects everything else', async () => {
	const forwardMock = vi.fn(async () => new Response(null, { status: 200 }))
	using _okFetch = stubFetch(forwardMock)
	const forwardHandler = createSentryTunnelHandler({
		SENTRY_DSN: configuredDsn,
		APP_DB: createAppDb(),
	})
	const forwarded = await forwardHandler(
		tunnelRequest(buildEnvelope(configuredDsn)),
	)
	expect(forwarded.status).toBe(200)
	expect(forwardMock).toHaveBeenCalledTimes(1)
	const [ingestUrl, init] = forwardMock.mock.calls[0] as unknown as [
		string,
		RequestInit,
	]
	expect(ingestUrl).toBe('https://o123.ingest.us.sentry.io/api/456/envelope/')
	expect(init.method).toBe('POST')

	const rejectMock = vi.fn()
	using _rejectFetch = stubFetch(rejectMock)
	const rejectHandler = createSentryTunnelHandler({
		SENTRY_DSN: configuredDsn,
		APP_DB: createAppDb(),
	})
	expect(
		(
			await rejectHandler(
				tunnelRequest(buildEnvelope('https://other@o999.ingest.sentry.io/1')),
			)
		).status,
	).toBe(403)
	// Truthy non-string dsn values must 403, not crash.
	expect(
		(
			await rejectHandler(
				tunnelRequest('{"dsn":{"nested":true}}\n{"type":"event"}'),
			)
		).status,
	).toBe(403)
	expect(
		(
			await createSentryTunnelHandler({ APP_DB: createAppDb() })(
				tunnelRequest(buildEnvelope(configuredDsn)),
			)
		).status,
	).toBe(404)
	expect((await rejectHandler(tunnelRequest('not json\nrest'))).status).toBe(
		400,
	)
	expect(rejectMock).not.toHaveBeenCalled()

	const failMock = vi.fn(async () => {
		throw new Error('network down')
	})
	using _failFetch = stubFetch(failMock)
	consoleWarn.mockImplementation(() => {})
	const failHandler = createSentryTunnelHandler({
		SENTRY_DSN: configuredDsn,
		APP_DB: createAppDb(),
	})
	expect(
		(await failHandler(tunnelRequest(buildEnvelope(configuredDsn)))).status,
	).toBe(502)
})

test('sentry tunnel caps forwarding per address and needs a declared length', async () => {
	const forwardMock = vi.fn(async () => new Response(null, { status: 200 }))
	using _okFetch = stubFetch(forwardMock)
	const limit = vi.fn(async ({ key }: RateLimitOptions) => {
		expect(key).toBe('sentry-tunnel:ip:198.51.100.42')
		return { success: forwardMock.mock.calls.length < 2 }
	})
	const handler = createSentryTunnelHandler({
		SENTRY_DSN: configuredDsn,
		APP_DB: createAppDb(),
		SENTRY_TUNNEL_RATE_LIMITER: { limit } as unknown as RateLimit,
	})
	const flood = () =>
		handler(
			tunnelRequest(buildEnvelope(configuredDsn), {
				'CF-Connecting-IP': '198.51.100.42',
			}),
		)

	expect((await flood()).status).toBe(200)
	expect((await flood()).status).toBe(200)
	const throttled = await flood()
	expect(throttled.status).toBe(429)
	expect(throttled.headers.get('Retry-After')).toBe(
		String(sentryTunnelRateLimitConfig.windowSeconds),
	)
	expect(forwardMock).toHaveBeenCalledTimes(2)

	// An undeclared body length is refused before anything is buffered.
	const chunked = await handler(
		tunnelRequest(buildEnvelope(configuredDsn), { 'content-length': '' }),
	)
	expect(chunked.status).toBe(411)
	expect(forwardMock).toHaveBeenCalledTimes(2)
})

test('sentry tunnel falls back to D1 rate limiting without the binding', async () => {
	const forwardMock = vi.fn(async () => new Response(null, { status: 200 }))
	using _okFetch = stubFetch(forwardMock)
	const handler = createSentryTunnelHandler({
		SENTRY_DSN: configuredDsn,
		APP_DB: createAppDb(),
	})

	let throttled: Response | null = null
	for (
		let attempt = 0;
		attempt <= sentryTunnelRateLimitConfig.maxRequests;
		attempt++
	) {
		const response = await handler(
			tunnelRequest(buildEnvelope(configuredDsn), {
				'CF-Connecting-IP': '203.0.113.9',
			}),
		)
		if (response.status === 429) {
			throttled = response
			break
		}
	}
	expect(throttled?.status).toBe(429)
	expect(forwardMock).toHaveBeenCalledTimes(
		sentryTunnelRateLimitConfig.maxRequests,
	)
})
