/**
 * Client helper: on the first page view, capture UTMs, the landing path, and
 * the document referrer into the `kody_first_touch` cookie. First touch wins
 * across tabs until the cookie expires or signup clears it; the server reads
 * it at signup. Referral share links use the last-wins `kody_ref` cookie.
 */

import {
	hasFirstTouchAttribution,
	parseFirstTouchAttribution,
	readFirstTouchAttributionFromCookie,
	serializeFirstTouchAttributionCookie,
} from '#universal/first-touch-attribution.ts'

export function captureFirstTouchAttributionFromLocation(
	href: string = typeof window !== 'undefined' ? window.location.href : '',
	referrer: string | null = typeof document !== 'undefined'
		? document.referrer || null
		: null,
	secure: boolean = typeof window !== 'undefined'
		? window.location.protocol === 'https:'
		: false,
) {
	if (typeof document === 'undefined') return
	let url: URL
	try {
		url = new URL(href, 'https://kody.codes')
	} catch {
		return
	}
	const attribution = parseFirstTouchAttribution({
		searchParams: url.searchParams,
		landingPath: url.pathname,
		referrer,
	})
	if (!hasFirstTouchAttribution(attribution)) return
	try {
		// Sandboxed iframes throw SecurityError on any document.cookie access.
		if (readFirstTouchAttributionFromCookie(document.cookie)) return
		document.cookie = serializeFirstTouchAttributionCookie({
			attribution,
			secure,
		})
	} catch {
		// Blocked cookies: signup proceeds without attribution.
	}
}
