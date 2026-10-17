import { expect, test } from 'vitest'
import { anonymousHtmlCacheControl } from '#app/anonymous-html-cache.ts'
import { isAnonymousHtmlCacheStoreable } from '#app/anonymous-html-edge-cache.ts'

test('responses setting cookies cannot enter the anonymous cache', async () => {
	const probe = crypto.randomUUID()
	const setCookieResponse = new Response('<html>set-cookie</html>', {
		status: 200,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': anonymousHtmlCacheControl,
			'Set-Cookie': 'kody_session=poison; Path=/',
		},
	})
	expect(isAnonymousHtmlCacheStoreable(setCookieResponse)).toBe(false)
	const setCookieKey = new Request(
		`https://test.kody.dev/pricing?set-cookie=${probe}`,
		{ method: 'GET' },
	)
	const edgeCache = (caches as CacheStorage & { default: Cache }).default
	await edgeCache.put(setCookieKey, setCookieResponse.clone()).catch(() => {
		// Cache API rejects Set-Cookie bodies; either path must not store.
	})
	expect(await edgeCache.match(setCookieKey)).toBeUndefined()
})
