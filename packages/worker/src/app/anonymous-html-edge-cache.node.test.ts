import { expect, test } from 'vitest'
import {
	anonymousHtmlCacheControl,
	anonymousVisibilityGatedCacheControl,
} from '#app/anonymous-html-cache.ts'
import {
	anonymousHtmlCacheAcceptHtml,
	anonymousHtmlCacheAcceptParam,
	buildAnonymousHtmlCacheEntry,
	buildAnonymousHtmlCacheKey,
	isAnonymousHtmlCacheRequest,
	isAnonymousHtmlCacheStoreable,
	isCompleteHtmlDocument,
} from '#app/anonymous-html-edge-cache.ts'

function htmlResponse(input: {
	status?: number
	cacheControl?: string
	contentType?: string
	setCookie?: string
}) {
	const headers = new Headers({
		'Content-Type': input.contentType ?? 'text/html; charset=utf-8',
		'Cache-Control': input.cacheControl ?? anonymousHtmlCacheControl,
		Vary: 'Cookie',
	})
	if (input.setCookie) headers.set('Set-Cookie', input.setCookie)
	return new Response('<html></html>', {
		status: input.status ?? 200,
		headers,
	})
}

const version = { CF_VERSION_METADATA: { id: 'version-1' } }
const canonicalEnv = {
	...version,
	APP_BASE_URL: 'https://kody.codes',
	APP_LEGACY_HOSTS: 'kody.codes.legacy.example',
	PACKAGE_APP_BASE_URL: 'https://kody-apps.example',
}

test('anonymous HTML Cache API stores only cookie-less 200 HTML with the shared TTL', () => {
	const home = 'https://kody.codes/'
	const requestCases: Array<
		[
			string,
			RequestInit,
			boolean,
			Parameters<typeof isAnonymousHtmlCacheRequest>[1]?,
		]
	> = [
		[home, {}, true],
		[home, { method: 'HEAD' }, true],
		[home, { method: 'POST' }, false],
		[home, { headers: { Cookie: 'kody_session=stale' } }, false],
		[
			home,
			{
				headers: {
					Cookie:
						'kody_site_banner_dismiss=11111111-1111-4111-8111-111111111111',
				},
			},
			false,
		],
		[home, { headers: { Authorization: 'Bearer x' } }, false],
		[home, { headers: { 'Cache-Control': 'no-cache' } }, false],
		[home, { headers: { Accept: 'text/markdown' } }, false],
		[home, { headers: { Accept: 'text/html' } }, true],
		['https://kody.codes/llms.txt', {}, true],
		['https://kody.codes/docs/llms.txt', {}, true],
		['https://kody.codes/login', {}, true],
		['https://kody.codes/signup', {}, true],
		[
			'https://kody.codes/login',
			{ headers: { Cookie: 'kody_session=stale' } },
			false,
		],
		[
			'https://kody.codes/signup',
			{ headers: { Cookie: 'kody_session=stale' } },
			false,
		],
		['https://kody.codes/?ref=alice', {}, false],
		['https://kody.codes.legacy.example/', {}, false],
		['https://kody-apps.example/', {}, false],
		[
			'https://preview.example.workers.dev/pricing',
			{},
			true,
			{ ...version, APP_BASE_URL: 'https://preview.example.workers.dev' },
		],
		['http://localhost:3742/', {}, true, version],
		[home, {}, false, {}],
		// `npm run dev` and the Playwright web server: a stored page would hide
		// the next edit from an anonymous tab for the stale-while-revalidate window.
		['http://localhost:3742/', {}, false, { WRANGLER_IS_LOCAL_DEV: 'true' }],
	]
	expect(
		requestCases.filter(
			([url, init, expected, env = canonicalEnv]) =>
				isAnonymousHtmlCacheRequest(
					new Request(url, init),
					env,
					'marketing',
				) !== expected,
		),
	).toEqual([])

	const htmlKey = buildAnonymousHtmlCacheKey(
		new Request('https://preview.example.workers.dev/pricing?utm=1', {
			method: 'HEAD',
			headers: { Accept: 'text/html' },
		}),
		{ ...version, APP_BASE_URL: 'https://kody.codes' },
	)
	expect(htmlKey.method).toBe('GET')
	expect(htmlKey.url).toBe(
		`https://kody.codes/pricing?utm=1&__worker_version=version-1&${anonymousHtmlCacheAcceptParam}=${anonymousHtmlCacheAcceptHtml}`,
	)
	const defaultAcceptKey = buildAnonymousHtmlCacheKey(
		new Request('https://preview.example.workers.dev/pricing?utm=1'),
		{ ...version, APP_BASE_URL: 'https://kody.codes' },
	)
	expect(defaultAcceptKey.url).toBe(htmlKey.url)

	const storeableCases: Array<[Parameters<typeof htmlResponse>[0], boolean]> = [
		[{}, true],
		[{ cacheControl: anonymousVisibilityGatedCacheControl }, true],
		[{ status: 404 }, false],
		[{ setCookie: 'kody_session=x; Path=/' }, false],
		[{ contentType: 'application/json' }, false],
		[{ contentType: 'text/plain; charset=utf-8' }, true],
		[{ cacheControl: 'no-store' }, false],
		[
			{
				contentType: 'text/plain; charset=utf-8',
				cacheControl: 'public, max-age=300',
			},
			false,
		],
	]
	expect(
		storeableCases.filter(
			([input, expected]) =>
				isAnonymousHtmlCacheStoreable(htmlResponse(input)) !== expected,
		),
	).toEqual([])
})

test('only a document that reached </html> counts as complete', () => {
	// An SSR stream that failed after committing the doctype ends cleanly at
	// 15 bytes; it must never be stored as the shared anonymous document.
	expect(
		['<!DOCTYPE html>', '', '<!DOCTYPE html><html><body>'].filter(
			isCompleteHtmlDocument,
		),
	).toEqual([])
	expect(
		[
			'<!DOCTYPE html><html><body></body></html><!-- rmx:flush document -->',
			'<html></HTML >',
		].filter((html) => !isCompleteHtmlDocument(html)),
	).toEqual([])
})

test('the stored entry keeps the buffered body and moves Vary aside', async () => {
	const response = new Response('streamed', {
		status: 200,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': anonymousHtmlCacheControl,
			Vary: 'Cookie, Accept',
			'X-Kody-Cache': 'MISS',
		},
	})
	const entry = buildAnonymousHtmlCacheEntry(response, '<html></html>')
	await expect(entry.text()).resolves.toBe('<html></html>')
	expect(entry.headers.get('X-Kody-Cache')).toBeNull()
	expect(entry.headers.get('X-Kody-Browser-Vary')).toBe('Cookie, Accept')
	expect(entry.headers.get('Vary')).toBe('Accept')
	expect(entry.headers.get('Cache-Control')).toBe(anonymousHtmlCacheControl)
})

test('routes that do not opt in never look up shared entries', () => {
	expect(
		isAnonymousHtmlCacheRequest(
			new Request('https://kody.codes/account'),
			canonicalEnv,
		),
	).toBe(false)
})
