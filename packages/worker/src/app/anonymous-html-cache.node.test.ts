import { expect, test } from 'vitest'
import {
	anonymousHtmlCacheControl,
	anonymousPersonalizedJsonCacheHeaders,
	anonymousVisibilityGatedCacheControl,
	publicSharedJsonCacheHeaders,
	requestHasSessionCookie,
	resolveAppPageCacheControl,
} from '#app/anonymous-html-cache.ts'

type PageCacheInput = Parameters<typeof resolveAppPageCacheControl>[0]

function request(url: string, cookie?: string) {
	return new Request(url, {
		headers: cookie ? { Cookie: cookie } : undefined,
	})
}

/** Anonymous GET of `pathname` on example.com unless overridden. */
function pageCache(pathname: string, overrides: Partial<PageCacheInput> = {}) {
	return resolveAppPageCacheControl({
		policy: 'marketing',
		session: null,
		request: request(`https://example.com${pathname}`),
		responseSetsCookie: false,
		...overrides,
	})
}

const noStore = { cacheControl: 'no-store' }
const sharedHtml = {
	cacheControl: 'public, max-age=60, stale-while-revalidate=300',
	vary: 'Cookie',
}

test('requestHasSessionCookie matches only the kody_session name', () => {
	const cases = [
		[undefined, false],
		['theme=dark; other=1', false],
		['kody_session=abc; other=1', true],
		['not_kody_session=abc', false],
	] as const
	for (const [cookie, expected] of cases) {
		expect(
			requestHasSessionCookie(request('https://example.com/', cookie)),
		).toBe(expected)
	}
})

test('anonymous marketing HTML is cacheable only without a session', () => {
	const sharedPaths = [
		'/',
		'/pricing',
		'/faq',
		'/about',
		'/contact',
		'/case-studies',
		'/believe',
		'/onboarding',
		'/onboarding/step-1',
		'/docs',
		'/docs/how-kody-works',
		'/llms.txt',
		'/docs/llms.txt',
		'/login',
		'/signup',
	]
	expect(
		sharedPaths.map((pathname) => [pathname, pageCache(pathname)]),
	).toEqual(sharedPaths.map((pathname) => [pathname, sharedHtml]))

	// Cookie-bearing auth requests stay private even though the paths are
	// on the anonymous allowlist.
	expect(
		pageCache('/login', {
			request: request('https://example.com/login', 'kody_session=stale'),
		}),
	).toEqual(noStore)
	expect(
		pageCache('/signup', {
			request: request('https://example.com/signup', 'kody_session=stale'),
		}),
	).toEqual(noStore)

	const privateCases: Array<[string, Partial<PageCacheInput>]> = [
		// Local dev: a browser-cached document would be what Vite's post-HMR page
		// reload shows instead of the edit.
		['/', { localDev: true }],
		['/account', { policy: undefined }],
		['/', { session: { id: 'user-1' } }],
		['/', { request: request('https://example.com/', 'kody_session=stale') }],
		['/', { responseSetsCookie: true }],
	]
	for (const [pathname, overrides] of privateCases) {
		expect(pageCache(pathname, overrides)).toEqual(noStore)
	}

	expect(publicSharedJsonCacheHeaders()).toEqual({
		'Cache-Control': anonymousHtmlCacheControl,
	})
	const onboardingJson = request('https://example.com/onboarding.json')
	expect(
		anonymousPersonalizedJsonCacheHeaders({
			personalized: false,
			request: onboardingJson,
		}),
	).toEqual({ 'Cache-Control': anonymousHtmlCacheControl, Vary: 'Cookie' })
	expect(
		anonymousPersonalizedJsonCacheHeaders({
			personalized: true,
			request: onboardingJson,
		}),
	).toEqual({ 'Cache-Control': 'no-store' })
	expect(
		anonymousPersonalizedJsonCacheHeaders({
			personalized: false,
			request: request(
				'https://example.com/onboarding.json',
				'kody_session=stale',
			),
		}),
	).toEqual({ 'Cache-Control': 'no-store' })
})

test('anonymous package pages are cacheable, but only successful documents', () => {
	const packagePaths = [
		'/@kentcdodds/sentry',
		'/@kentcdodds/sentry/tree/main',
		'/@kentcdodds/sentry/tree/main/src/index.ts',
		'/community/0e75b90a-1fd7-4a4a-9ae1-167384bbd227',
		'/community/0e75b90a-1fd7-4a4a-9ae1-167384bbd227/files/src',
	]
	const visibilityGated = {
		cacheControl: anonymousVisibilityGatedCacheControl,
		vary: 'Cookie',
	}
	expect(
		packagePaths.map((pathname) => [
			pathname,
			pageCache(pathname, { policy: 'visibility' }),
		]),
	).toEqual(packagePaths.map((pathname) => [pathname, visibilityGated]))
	expect(
		anonymousPersonalizedJsonCacheHeaders({
			personalized: false,
			request: request('https://example.com/x.json'),
			visibilityGated: true,
		}),
	).toEqual({
		'Cache-Control': anonymousVisibilityGatedCacheControl,
		Vary: 'Cookie',
	})
	// A private package answers 401/404 to strangers; that answer changes the
	// moment the owner makes it public, so it is never shared.
	for (const status of [401, 404]) {
		expect(pageCache('/@kentcdodds/secret', { status })).toEqual(noStore)
	}
	expect(
		pageCache('/@kentcdodds/sentry', {
			request: request(
				'https://example.com/@kentcdodds/sentry',
				'kody_session=x',
			),
		}),
	).toEqual(noStore)
})
