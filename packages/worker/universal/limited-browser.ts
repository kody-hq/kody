/**
 * Limited browsers (ADR 0094): engines older than the app bundle's build
 * target (Vite's `baseline-widely-available` default: Chrome/Edge 111,
 * Firefox 114, Safari 16.4) or e-reader browsers such as the Kindle's. Kody
 * serves them its sign-in pages as plain HTML with no app bundle, because a
 * half-working bundle is worse than none. User agents are self-reported, so
 * this only picks a rendering; it is never a security decision, and every
 * page still works for a browser that is misdetected either way.
 */

/** Query flag for a sign-in document served without the app bundle. */
export const plainDocumentQueryParam = 'plain'

function majorVersion(userAgent: string, pattern: RegExp) {
	const match = pattern.exec(userAgent)?.[1]
	if (!match) return null
	const [major = '', minor = '0'] = match.split('.')
	const parsed = Number(major)
	return Number.isFinite(parsed)
		? { major: parsed, minor: Number(minor) || 0 }
		: null
}

export function isLimitedBrowserUserAgent(userAgent: string | null) {
	const ua = (userAgent ?? '').slice(0, 512)
	if (!ua) return false
	if (/\bKindle\b|\bSilk\//.test(ua)) return true
	const chromium = majorVersion(ua, /(?:Chrome|Chromium|CriOS)\/([\d.]+)/)
	if (chromium) return chromium.major < 111
	const firefox = majorVersion(ua, /(?:Firefox|FxiOS)\/([\d.]+)/)
	if (firefox) return firefox.major < 114
	const safari = majorVersion(ua, /Version\/([\d.]+).*Safari\//)
	if (safari) {
		return safari.major < 16 || (safari.major === 16 && safari.minor < 4)
	}
	return false
}

export function isPlainDocumentSearch(search: string) {
	return new URLSearchParams(search).get(plainDocumentQueryParam) === '1'
}
