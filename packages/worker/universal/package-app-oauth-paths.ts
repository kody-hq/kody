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
	/** Limited-browser sign-in approved on another device (ADR 0094). */
	device: '/oauth/package-app/device',
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

/** Device-code cookie for a limited browser signing in on another device. */
export const packageAppDeviceSignInCookieName = '__Host-kody_pkg_device'
export const packageAppDeviceSignInCookieNameInsecure = 'kody_pkg_device'

/**
 * Short-lived marker that a limited browser asked to sign in on another
 * device from a Kody package path (`/@{user}/packages/{name}/open`). The app
 * host's own sign-in start runs first so its PKCE cookie is set, then the
 * authorize request it sends back starts the device sign-in.
 */
export const packageAppDeviceIntentCookieName = '__Host-kody_pkg_device_intent'
export const packageAppDeviceIntentCookieNameInsecure = 'kody_pkg_device_intent'

const packageAppPathPattern = /^\/@[^/?#]+\/packages\/[^/?#]+/

/**
 * Where "Sign in on another device" can start from a sign-in page's
 * `redirectTo`: a package-app authorize resume, or a package app path such as
 * `/@{user}/packages/{name}/open`. Anything else (Kody's own pages) has no
 * app to sign in to, so the option is not offered. Callers pass a value that
 * already went through `normalizeRedirectTo`.
 */
export function packageAppDeviceSignInTarget(redirectTo: string | null) {
	if (!redirectTo) return null
	let pathname: string
	try {
		pathname = new URL(redirectTo, 'https://kody.invalid').pathname
	} catch {
		return null
	}
	if (pathname === packageAppOauthPaths.authorize) return redirectTo
	return packageAppPathPattern.test(pathname) ? redirectTo : null
}
