/**
 * Path rules for package-app hosts (`{username}.<package-app host>`).
 *
 * Packages mount at `/{kodyId}`. Everything Kody owns on that host lives under
 * `/-/` (auth, health), so a package name can never shadow a system route.
 * Exact `/.well-known/...` paths stay at their spec location and are never
 * package mounts. The legacy `/packages/{kodyId}` mount is still served.
 */

export const packageAppHostSystemPrefix = '/-'

export const packageAppHostLegacyMountSegment = 'packages'

export const packageAppHostReservedFirstSegments: ReadonlySet<string> = new Set(
	['-', '.well-known', '_kody', 'robots.txt', 'favicon.ico', 'sitemap.xml'],
)

export function isPackageAppHostReservedFirstSegment(segment: string) {
	return packageAppHostReservedFirstSegments.has(segment.trim().toLowerCase())
}

/** True when the pathname uses the legacy `/packages/{kodyId}` subdomain mount. */
export function isPackageAppLegacySubdomainMountPath(pathname: string) {
	return pathname.startsWith(`/${packageAppHostLegacyMountSegment}/`)
}

/**
 * True when a first path segment can never be a package leaf: Kody-owned
 * segments, the legacy `packages` mount segment (a prefix, not a package
 * name), and `@handle` segments, which belong to the app-origin username
 * namespace.
 */
export function isPackageAppHostNonLeafFirstSegment(segment: string) {
	const normalized = segment.trim().toLowerCase()
	return (
		isPackageAppHostReservedFirstSegment(normalized) ||
		normalized === packageAppHostLegacyMountSegment ||
		normalized.startsWith('@')
	)
}

/** True when the pathname is exactly `/-/{name}` or below it. */
export function isPackageAppHostSystemPath(pathname: string) {
	return (
		pathname === packageAppHostSystemPrefix ||
		pathname.startsWith(`${packageAppHostSystemPrefix}/`)
	)
}
