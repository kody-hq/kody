import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { anonymousHtmlCacheControl } from '#app/anonymous-html-cache.ts'
import {
	anonymousHtmlEdgeCacheHeader,
	deliverAnonymousDocument,
	buildAnonymousHtmlCacheKey,
	serveAnonymousHtmlFromCache as serveWithPolicy,
} from '#app/anonymous-html-edge-cache.ts'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'

async function serveAnonymousHtmlFromCache(
	...args: Parameters<typeof serveWithPolicy>
) {
	return deliverAnonymousDocument(
		args[0],
		await serveWithPolicy(args[0], args[1], args[2], args[3], {
			policy: 'marketing',
			...args[4],
		}),
	)
}

const env = {
	CF_VERSION_METADATA: { id: 'version-1' },
	APP_BASE_URL: 'https://test.kody.dev',
}
const encoder = new TextEncoder()

function defaultCache() {
	return (caches as CacheStorage & { default: Cache }).default
}
const completeDocument =
	'<!DOCTYPE html><html><body>ok</body></html><!-- rmx:flush document -->'

function storeableHtml(body: BodyInit) {
	return new Response(body, {
		status: 200,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': anonymousHtmlCacheControl,
			Vary: 'Cookie',
		},
	})
}

async function serve(request: Request, upstream: () => Response) {
	const ctx = createExecutionContext()
	const response = await serveAnonymousHtmlFromCache(request, env, ctx, () =>
		Promise.resolve(upstream()),
	)
	const text = await response.text()
	await waitOnExecutionContext(ctx)
	return {
		response,
		text,
		cached: await defaultCache().match(
			buildAnonymousHtmlCacheKey(request, env),
		),
	}
}

test('a complete anonymous document is stored and replayed', async () => {
	const url = `https://test.kody.dev/pricing?complete=${crypto.randomUUID()}`
	const miss = await serve(new Request(url), () =>
		storeableHtml(completeDocument),
	)
	expect(miss.response.headers.get(anonymousHtmlEdgeCacheHeader)).toBe('MISS')
	expect(miss.text).toBe(completeDocument)
	await expect(miss.cached?.text()).resolves.toBe(completeDocument)

	const hit = await serve(new Request(url), () => {
		throw new Error('upstream must not run on a HIT')
	})
	expect(hit.response.headers.get(anonymousHtmlEdgeCacheHeader)).toBe('HIT')
	expect(hit.text).toBe(completeDocument)
})

test('anonymous llms.txt plain text is stored and replayed like marketing HTML', async () => {
	const body = '# Kody\n\n> viewer-independent docs index\n'
	function storeablePlain(text: string) {
		return new Response(text, {
			status: 200,
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': anonymousHtmlCacheControl,
				Vary: 'Cookie',
			},
		})
	}
	for (const pathname of ['/llms.txt', '/docs/llms.txt'] as const) {
		const url = `https://test.kody.dev${pathname}?plain=${crypto.randomUUID()}`
		const miss = await serve(new Request(url), () => storeablePlain(body))
		expect(miss.response.headers.get(anonymousHtmlEdgeCacheHeader)).toBe('MISS')
		expect(miss.text).toBe(body)
		await expect(miss.cached?.text()).resolves.toBe(body)

		const hit = await serve(new Request(url), () => {
			throw new Error('upstream must not run on a HIT')
		})
		expect(hit.response.headers.get(anonymousHtmlEdgeCacheHeader)).toBe('HIT')
		expect(hit.text).toBe(body)
	}
})

test('anonymous auth pages are stored; cookie-bearing requests bypass the shared cache', async () => {
	for (const pathname of ['/login', '/signup'] as const) {
		const url = `https://test.kody.dev${pathname}?auth=${crypto.randomUUID()}`
		const miss = await serve(new Request(url), () =>
			storeableHtml(completeDocument),
		)
		expect(miss.response.headers.get(anonymousHtmlEdgeCacheHeader)).toBe('MISS')
		await expect(miss.cached?.text()).resolves.toBe(completeDocument)

		const hit = await serve(new Request(url), () => {
			throw new Error('upstream must not run on a HIT')
		})
		expect(hit.response.headers.get(anonymousHtmlEdgeCacheHeader)).toBe('HIT')
		expect(hit.text).toBe(completeDocument)

		const withCookie = await serve(
			new Request(url, { headers: { Cookie: 'kody_session=stale' } }),
			() =>
				new Response(completeDocument, {
					status: 200,
					headers: {
						'Content-Type': 'text/html; charset=utf-8',
						'Cache-Control': 'no-store',
					},
				}),
		)
		expect(
			withCookie.response.headers.get(anonymousHtmlEdgeCacheHeader),
		).toBeNull()
		expect(withCookie.response.headers.get('Cache-Control')).toBe('no-store')
	}
})

test('a 200 whose body stopped after the doctype is served once but never stored', async () => {
	silenceExpectedConsoleWarns(['anonymous-html-cache-skip-incomplete'])
	const url = `https://test.kody.dev/onboarding?truncated=${crypto.randomUUID()}`

	// An SSR render aborted by a Vite HMR re-evaluation used to end here: a
	// committed 200 with 15 bytes. Stored, it became a blank page for every
	// later anonymous visit.
	const truncated = await serve(new Request(url), () =>
		storeableHtml('<!DOCTYPE html>'),
	)
	expect(truncated.response.status).toBe(200)
	expect(truncated.text).toBe('<!DOCTYPE html>')
	expect(truncated.cached).toBeUndefined()

	const recovered = await serve(new Request(url), () =>
		storeableHtml(completeDocument),
	)
	expect(recovered.response.headers.get(anonymousHtmlEdgeCacheHeader)).toBe(
		'MISS',
	)
	expect(recovered.text).toBe(completeDocument)
	await expect(recovered.cached?.text()).resolves.toBe(completeDocument)
})

test('a body that errors mid-stream is never stored', async () => {
	const url = `https://test.kody.dev/pricing?errored=${crypto.randomUUID()}`
	const ctx = createExecutionContext()
	const response = await serveAnonymousHtmlFromCache(
		new Request(url),
		env,
		ctx,
		() =>
			Promise.resolve(
				storeableHtml(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode('<!DOCTYPE html><html>'))
							controller.error(new Error('render failed'))
						},
					}),
				),
			),
	)
	await expect(response.text()).rejects.toThrow('render failed')
	await waitOnExecutionContext(ctx)
	expect(
		await defaultCache().match(
			buildAnonymousHtmlCacheKey(new Request(url), env),
		),
	).toBeUndefined()
})

test('cached nonce documents get a fresh policy and matching trusted script nonce on every delivery', async () => {
	const url = `https://test.kody.dev/pricing?nonce=${crypto.randomUUID()}`
	const originalNonce = 'originalnonce0123456789'
	const originalHtml = `<!DOCTYPE html><html><head><meta property="csp-nonce" content="${originalNonce}"></head><body><script nonce="${originalNonce}">void 0</script><script>untrusted()</script><script nonce="wrong">untrusted()</script></body></html>`
	const miss = await serve(new Request(url), () => {
		const response = storeableHtml(originalHtml)
		response.headers.set(
			'Content-Security-Policy',
			`script-src 'self' 'nonce-${originalNonce}'`,
		)
		return response
	})
	const hit = await serve(new Request(url), () => {
		throw new Error('cached document should be reused')
	})
	const nonces = [miss, hit].map(({ response, text }) => {
		const nonce = response.headers
			.get('Content-Security-Policy')
			?.match(/'nonce-([^']+)'/)?.[1]
		expect(nonce).toBeTruthy()
		expect(text).toContain(`<script nonce="${nonce}">void 0</script>`)
		expect(text).toContain(`property="csp-nonce" content="${nonce}"`)
		expect(text).toContain('<script>untrusted()</script>')
		expect(text).toContain('<script nonce="wrong">untrusted()</script>')
		expect(response.headers.get('Cache-Control')).toBe('private, no-store')
		return nonce
	})
	expect(nonces[0]).toBe(originalNonce)
	expect(nonces[1]).not.toBe(originalNonce)
	expect(nonces[0]).not.toBe(nonces[1])
	await expect(miss.cached?.text()).resolves.toBe(originalHtml)
	expect(hit.response.headers.get(anonymousHtmlEdgeCacheHeader)).toBe('HIT')
})

test('server function JSON is never parsed or rewritten as HTML', async () => {
	const request = new Request('https://test.kody.dev/_serverFn/test')
	const body = JSON.stringify({
		value: '<script nonce="known">literal text</script>',
	})
	const result = await serve(
		request,
		() =>
			new Response(body, {
				headers: {
					'Content-Type': 'application/json',
					'Cache-Control': 'private, no-store',
					'Content-Security-Policy': "script-src 'self' 'nonce-known'",
				},
			}),
	)
	expect(result.text).toBe(body)
	expect(result.cached).toBeUndefined()
})

test('large nonce documents retain their closing markup on cache miss and hit', async () => {
	const url = `https://test.kody.dev/pricing?large=${crypto.randomUUID()}`
	const html = `<!DOCTYPE html><html><body>${'<p>content</p>'.repeat(30_000)}<footer>complete document</footer><script nonce="originalnonce">void 0</script></body></html>`
	const miss = await serve(new Request(url), () => {
		const response = storeableHtml(html)
		response.headers.set(
			'Content-Security-Policy',
			"script-src 'self' 'nonce-originalnonce'",
		)
		return response
	})
	const hit = await serve(new Request(url), () => {
		throw new Error('expected cache hit')
	})
	for (const result of [miss, hit]) {
		expect(result.text).toContain('<footer>complete document</footer>')
		expect(result.text.endsWith('</html>')).toBe(true)
		expect(result.text.length).toBeGreaterThanOrEqual(html.length)
	}
	expect(hit.response.headers.get(anonymousHtmlEdgeCacheHeader)).toBe('HIT')
})

test('a deployment cannot replay previous assets or accept a caller-selected version', async () => {
	const url = `https://test.kody.dev/pricing?campaign=${crypto.randomUUID()}`
	async function fetchVersion(id: string | undefined, requestUrl = url) {
		const ctx = createExecutionContext()
		const response = await serveAnonymousHtmlFromCache(
			new Request(requestUrl),
			{ ...env, CF_VERSION_METADATA: id ? { id } : undefined },
			ctx,
			async () =>
				storeableHtml(
					`<html><body><script src="/assets/${id ?? 'uncached'}.js"></script></body></html>`,
				),
		)
		const body = await response.text()
		await waitOnExecutionContext(ctx)
		return { body, lookup: response.headers.get(anonymousHtmlEdgeCacheHeader) }
	}
	expect((await fetchVersion('v1')).lookup).toBe('MISS')
	expect((await fetchVersion('v1')).lookup).toBe('HIT')
	const deployed = await fetchVersion('v2')
	expect(deployed.lookup).toBe('MISS')
	expect(deployed.body).toContain('/assets/v2.js')
	const forged = await fetchVersion(
		'v2',
		`${url}&__worker_version=v1&__worker_version=v1`,
	)
	expect(forged.lookup).toBe('HIT')
	expect(forged.body).toContain('/assets/v2.js')
	expect((await fetchVersion('v2', `${url}&content=different`)).lookup).toBe(
		'MISS',
	)
	const missing = await fetchVersion(undefined, `${url}&__worker_version=v1`)
	expect(missing.lookup).toBeNull()
	expect(missing.body).toContain('/assets/uncached.js')
	expect((await fetchVersion(undefined)).lookup).toBeNull()
})

test('native cache hit uses the current request nonce without executing its loader', async () => {
	const url = `https://test.kody.dev/pricing?request-nonce=${crypto.randomUUID()}`
	const request = new Request(url)
	const ctx = createExecutionContext()
	const first = await serveAnonymousHtmlFromCache(
		request,
		env,
		ctx,
		async () =>
			new Response('<html><script nonce="firstrequest">ok()</script></html>', {
				headers: {
					'Content-Type': 'text/html',
					'Content-Security-Policy': "script-src 'self' 'nonce-firstrequest'",
					'Cache-Control': anonymousHtmlCacheControl,
				},
			}),
		{ policy: 'marketing', nonce: 'firstrequest' },
	)
	await first.text()
	await waitOnExecutionContext(ctx)
	const hit = await serveAnonymousHtmlFromCache(
		request,
		env,
		createExecutionContext(),
		async () => {
			throw new Error('Cached route must not execute its loader')
		},
		{ policy: 'marketing', nonce: 'secondrequest' },
	)
	expect(hit.headers.get('X-Kody-Cache')).toBe('HIT')
	expect(hit.headers.get('Content-Security-Policy')).toContain(
		"'nonce-secondrequest'",
	)
	expect(await hit.text()).toContain('nonce="secondrequest"')
	expect(hit.headers.get('Cache-Control')).toBe('private, no-store')
})

test('personalized and referral requests bypass a populated native cache', async () => {
	const url = `https://test.kody.dev/pricing?personalization=${crypto.randomUUID()}`
	await serve(new Request(url), () => storeableHtml('<html>anonymous</html>'))
	for (const request of [
		new Request(url, { headers: { Cookie: 'kody_session=private' } }),
		new Request(url, { headers: { Authorization: 'Bearer private' } }),
		new Request(`${url}&ref=alice`),
	]) {
		const result = await serve(request, () =>
			storeableHtml('<html>fresh</html>'),
		)
		expect(result.text).toContain('fresh')
		expect(result.response.headers.get('X-Kody-Cache')).toBeNull()
	}
})
