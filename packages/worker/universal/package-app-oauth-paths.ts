/**
 * Paths for first-party OAuth for hosted package apps.
 *
 * Authorize / consent stay on the app origin (kody.codes). Login, callback,
 * logout, and me run on the package-app host (`*.kody.run` and verified custom
 * domains) at the host root under the `/-/` system prefix, never under a
 * package mount. The legacy `/_kody/auth/*` paths are still served so existing
 * kit clients keep working.
 */

export const packageAppOauthPaths = {
	authorize: '/oauth/package-app/authorize',
	login: '/-/auth/login',
	callback: '/-/auth/callback',
	logout: '/-/auth/logout',
	me: '/-/auth/me',
} as const

export const packageAppOauthLegacyPaths = {
	login: '/_kody/auth/login',
	callback: '/_kody/auth/callback',
	logout: '/_kody/auth/logout',
	me: '/_kody/auth/me',
} as const

const canonicalAuthPrefix = '/-/auth'
const legacyAuthPrefix = '/_kody/auth'

/** True for the canonical or legacy host auth root and anything below it. */
export function isPackageAppOauthHostAuthPathname(pathname: string) {
	return (
		pathname === canonicalAuthPrefix ||
		pathname.startsWith(`${canonicalAuthPrefix}/`) ||
		pathname === legacyAuthPrefix ||
		pathname.startsWith(`${legacyAuthPrefix}/`)
	)
}

/** Map a legacy `/_kody/auth/*` pathname to its canonical `/-/auth/*` form. */
export function normalizePackageAppOauthHostAuthPathname(pathname: string) {
	if (pathname === legacyAuthPrefix) return canonicalAuthPrefix
	if (pathname.startsWith(`${legacyAuthPrefix}/`)) {
		return `${canonicalAuthPrefix}${pathname.slice(legacyAuthPrefix.length)}`
	}
	return pathname
}

export function isPackageAppOauthCallbackPathname(pathname: string) {
	return (
		pathname === packageAppOauthPaths.callback ||
		pathname === packageAppOauthLegacyPaths.callback
	)
}

export const packageAppOauthPkceCookieName = '__Host-kody_pkg_oauth'
export const packageAppOauthPkceCookieNameInsecure = 'kody_pkg_oauth'
