import { expect, test } from 'vitest'
import {
	fetchPreservingWebSocketUpgrade,
	isWebSocketUpgradeRequest,
} from './websocket-upgrade.ts'

/**
 * Mirrors `@sentry/cloudflare` `instrumentFetcher`: when tracing headers are
 * present it rebuilds `new Request(input, { headers })` or merges a plain
 * headers init.
 */
function sentryStyleInstrumentFetcher(fetchFn: typeof fetch): typeof fetch {
	return ((input: RequestInfo | URL, init?: RequestInit) => {
		const originalHeaders =
			init?.headers ?? (input instanceof Request ? input.headers : undefined)
		if (!originalHeaders) {
			return fetchFn(input as RequestInfo, init)
		}
		let merged: Headers | Record<string, string>
		if (originalHeaders instanceof Headers) {
			merged = new Headers(originalHeaders)
			merged.set('sentry-trace', '00-trace-00')
		} else if (Array.isArray(originalHeaders)) {
			merged = Object.fromEntries(originalHeaders)
			merged['sentry-trace'] = '00-trace-00'
		} else {
			merged = Object.assign({}, originalHeaders, {
				'sentry-trace': '00-trace-00',
			})
		}
		if (input instanceof Request && init === undefined) {
			return fetchFn(new Request(input, { headers: merged }))
		}
		return fetchFn(input as RequestInfo, { ...init, headers: merged })
	}) as typeof fetch
}

test('isWebSocketUpgradeRequest is case-insensitive on the Upgrade value', () => {
	expect(
		isWebSocketUpgradeRequest(
			new Request('https://example.com/ws', {
				headers: { Upgrade: 'websocket' },
			}),
		),
	).toBe(true)
	expect(
		isWebSocketUpgradeRequest(
			new Request('https://example.com/ws', {
				headers: { Upgrade: 'WebSocket' },
			}),
		),
	).toBe(true)
	expect(isWebSocketUpgradeRequest(new Request('https://example.com/ws'))).toBe(
		false,
	)
})

test('fetchPreservingWebSocketUpgrade keeps Upgrade under Sentry-style Fetcher instrumentation', async () => {
	const seen: Array<{
		upgrade: string | null
		sentryTrace: string | null
		url: string
		method: string
		via: 'request' | 'init'
	}> = []

	const rawFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request =
			input instanceof Request && init === undefined
				? input
				: input instanceof Request
					? new Request(input, init)
					: new Request(input, init)
		seen.push({
			upgrade: request.headers.get('Upgrade'),
			sentryTrace: request.headers.get('sentry-trace'),
			url: request.url,
			method: request.method,
			via: input instanceof Request && init === undefined ? 'request' : 'init',
		})
		return new Response('upgraded', { status: 200 })
	}) as typeof fetch

	const instrumented = {
		fetch: sentryStyleInstrumentFetcher(rawFetch),
	}

	const browserUpgrade = new Request(
		'https://kentcdodds.kody.run/packages/pr-desk/ws',
		{
			headers: {
				Upgrade: 'websocket',
				Connection: 'Upgrade',
				'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
				'Sec-WebSocket-Version': '13',
			},
		},
	)

	// Broken path used by wholesale `RUNTIME_WORKER.fetch(request)`: Request
	// object through Sentry instrumentation (Request rebuild branch).
	await instrumented.fetch(browserUpgrade)
	expect(seen.at(-1)?.via).toBe('request')

	// Fixed path: plain-object headers init keeps Upgrade through Object.assign.
	await fetchPreservingWebSocketUpgrade(instrumented, browserUpgrade)
	expect(seen.at(-1)).toMatchObject({
		upgrade: 'websocket',
		sentryTrace: '00-trace-00',
		url: 'https://kentcdodds.kody.run/packages/pr-desk/ws',
		method: 'GET',
		via: 'init',
	})
})
