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

/** Default body for package-app host `/robots.txt` (allow all). */
export const packageAppHostDefaultRobotsTxt = 'User-agent: *\nAllow: /\n'

/** Response header value marking the platform default robots.txt. */
export const packageAppHostDefaultRobotsTxtHeader = 'robots.txt'

export function isPackageAppHostReservedFirstSegment(segment: string) {
	return packageAppHostReservedFirstSegments.has(segment.trim().toLowerCase())
}

/**
 * True when a package name leaf must not be newly created because it collides
 * with a package-app host root or system path (reserved first segments plus
 * the legacy `packages` mount prefix).
 */
export function isPackageAppHostReservedPackageLeaf(leaf: string) {
	const normalized = leaf.trim().toLowerCase()
	return (
		isPackageAppHostReservedFirstSegment(normalized) ||
		normalized === packageAppHostLegacyMountSegment
	)
}

/** Sorted reserved package leaves for audits and error copy. */
export function listPackageAppHostReservedPackageLeaves(): Array<string> {
	return [
		...packageAppHostReservedFirstSegments,
		packageAppHostLegacyMountSegment,
	].sort()
}

/**
 * Clear create/publish rejection when a leaf collides with a package-app host
 * root or system path. No em dashes.
 */
export function packageAppHostReservedPackageLeafMessage(leaf: string) {
	const normalized = leaf.trim().toLowerCase() || leaf
	return `Cannot create package: ${JSON.stringify(normalized)} is reserved for package-app host paths (system routes under /-/, robots.txt, favicon.ico, sitemap.xml, .well-known, legacy /packages, and _kody). Choose a different package name leaf.`
}

/**
 * Read-only SQL to find live saved packages whose `kody_id` leaf is reserved.
 * Does not rename or mutate rows. Run against D1 (local or production replica).
 */
export function packageAppHostReservedPackageLeafAuditSql() {
	const leaves = listPackageAppHostReservedPackageLeaves()
	const inList = leaves
		.map((leaf) => `'${leaf.replaceAll("'", "''")}'`)
		.join(', ')
	return `SELECT id, user_id, name, kody_id, created_at
FROM saved_packages
WHERE deleted_at IS NULL
  AND lower(kody_id) IN (${inList})
ORDER BY kody_id, user_id;`
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
		isPackageAppHostReservedPackageLeaf(normalized) ||
		normalized.startsWith('@')
	)
}

/** Exact `/robots.txt` on a package-app short-path host. */
export function isPackageAppHostRobotsTxtPath(pathname: string) {
	return pathname === '/robots.txt'
}

/** `/.well-known` or any path under it (never a package mount). */
export function isPackageAppHostWellKnownPath(pathname: string) {
	return pathname === '/.well-known' || pathname.startsWith('/.well-known/')
}

/** True when the pathname is exactly `/-/{name}` or below it. */
export function isPackageAppHostSystemPath(pathname: string) {
	return (
		pathname === packageAppHostSystemPrefix ||
		pathname.startsWith(`${packageAppHostSystemPrefix}/`)
	)
}
