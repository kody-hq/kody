import { lookupPackageAppCustomHostname } from '#worker/package-app-custom-hostnames/lookup.ts'
import type { PackageAppCustomHostnameLookup } from '#worker/package-app-custom-hostnames/types.ts'
import { createPromiseLruCacheByBinding } from '#worker/package-registry/published-package-cache.ts'

/**
 * Short-TTL per-isolate cache for Host-header → custom-hostname mapping.
 * Staleness of up to {@link packageAppCustomHostnameLookupCacheTtlMs} is ok
 * for serve routing; mutations invalidate the hostname key in this isolate.
 * Other isolates re-read within the TTL (same pattern as entitlements).
 */
export const packageAppCustomHostnameLookupCacheTtlMs = 60_000

const lookupCaches =
	createPromiseLruCacheByBinding<PackageAppCustomHostnameLookup | null>({
		ttlMs: packageAppCustomHostnameLookupCacheTtlMs,
		limit: 2_000,
	})

/**
 * Cached {@link lookupPackageAppCustomHostname} for the package-app Host
 * allowlist hot path. Prefer the uncached lookup when an admin needs a
 * fresh row after a mutation in the same request.
 */
export async function lookupCachedPackageAppCustomHostname(input: {
	db: D1Database
	hostname: string
}): Promise<PackageAppCustomHostnameLookup | null> {
	const key = input.hostname.trim().toLowerCase()
	if (!key) return null
	return await lookupCaches.for(input.db).getOrCreate({
		cacheKey: key,
		create: () => lookupPackageAppCustomHostname(input),
	})
}

/** Drop one hostname from this isolate's lookup cache after a mutation. */
export function invalidateCachedPackageAppCustomHostname(
	db: D1Database,
	hostname: string,
): void {
	const key = hostname.trim().toLowerCase()
	if (!key) return
	lookupCaches.for(db).delete(key)
}

/** Drop every hostname this isolate cached for a db (package renames). */
export function clearCachedPackageAppCustomHostnames(db: D1Database): void {
	lookupCaches.clear(db)
}
