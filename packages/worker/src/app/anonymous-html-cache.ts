/**
 * Shared Cache-Control for anonymous marketing HTML, auth entry pages, and the
 * viewer-independent `/llms.txt` / `/docs/llms.txt` plain-text indexes. Session
 * pages and any response that sets a cookie stay `no-store`. The origin Worker
 * stores cookie-less GET responses in `caches.default` keyed on canonical
 * origin + pathname + search plus a `__accept=html` marker; markdown-preferring
 * `Accept` values (`prefersMarkdown`) bypass the store. Native routes opt in
 * through their cache policy. Hits restore the miss `Vary` (`Cookie`, plus `Accept` on
 * negotiated routes) so intermediary caches still split on the session cookie.
 */

export type AnonymousDocumentCachePolicy = 'marketing' | 'visibility'

export const sessionCookieName = 'kody_session'

/**
 * Retired site-banner dismiss cookie. The feature is gone; browsers may still
 * send this HttpOnly cookie for years. Clear it when present so clients stop
 * shipping up to ~1.6 KB of dead UUIDs on every request.
 */
export const retiredSiteBannerDismissCookieName = 'kody_site_banner_dismiss'

export const anonymousHtmlCacheControl =
	'public, max-age=60, stale-while-revalidate=300'

/**
 * Package surfaces answer to an owner's visibility switch (unpublish, make
 * private). Nothing purges shared caches on that switch, so they get the
 * shorter policy: a stale public response can outlive the change by at most
 * one minute instead of riding the marketing pages' revalidation window.
 */
export const anonymousVisibilityGatedCacheControl = 'public, max-age=60'

export function requestHasSessionCookie(request: Request): boolean {
	const cookie = request.headers.get('Cookie') ?? ''
	return /(?:^|;\s*)kody_session=/.test(cookie)
}

export function requestHasRetiredSiteBannerDismissCookie(
	request: Request,
): boolean {
	const cookie = request.headers.get('Cookie') ?? ''
	return new RegExp(`(?:^|;\\s*)${retiredSiteBannerDismissCookieName}=`).test(
		cookie,
	)
}

export function clearRetiredSiteBannerDismissCookie(input: {
	secure: boolean
}): string {
	const secure = input.secure ? '; Secure' : ''
	return `${retiredSiteBannerDismissCookieName}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${secure}`
}

export function resolveAppPageCacheControl(input: {
	policy?: AnonymousDocumentCachePolicy
	session: unknown | null
	request: Request
	responseSetsCookie: boolean
	/** Only successful documents are shared; a 404 or 401 must not outlive its cause. */
	status?: number
	/**
	 * `npm run dev`: the browser serves Vite's post-HMR `location.reload()` from
	 * its HTTP cache when the document is `public, max-age=60`, so an edit
	 * never shows. Nothing shares anonymous HTML locally anyway.
	 */
	localDev?: boolean
}): { cacheControl: string; vary?: string } {
	if (input.localDev) {
		return { cacheControl: 'no-store' }
	}
	if (input.session !== null) {
		return { cacheControl: 'no-store' }
	}
	if ((input.status ?? 200) !== 200) {
		return { cacheControl: 'no-store' }
	}
	if (input.responseSetsCookie) {
		return { cacheControl: 'no-store' }
	}
	if (requestHasSessionCookie(input.request)) {
		return { cacheControl: 'no-store' }
	}
	if (!input.policy) return { cacheControl: 'no-store' }
	return {
		cacheControl:
			input.policy === 'visibility'
				? anonymousVisibilityGatedCacheControl
				: anonymousHtmlCacheControl,
		vary: 'Cookie',
	}
}

export function publicSharedJsonCacheHeaders(): HeadersInit {
	return { 'Cache-Control': anonymousHtmlCacheControl }
}

export function anonymousPersonalizedJsonCacheHeaders(input: {
	personalized: boolean
	request: Request
	/** Payload for a surface an owner can make private; see the shorter policy. */
	visibilityGated?: boolean
}): HeadersInit {
	if (input.personalized || requestHasSessionCookie(input.request)) {
		return { 'Cache-Control': 'no-store' }
	}
	return {
		'Cache-Control': input.visibilityGated
			? anonymousVisibilityGatedCacheControl
			: anonymousHtmlCacheControl,
		Vary: 'Cookie',
	}
}
