import { lookupPackageAppCustomHostname } from '#worker/package-app-custom-hostnames/lookup.ts'
import type { PackageAppCustomHostnameLookup } from '#worker/package-app-custom-hostnames/types.ts'

/**
 * Short-TTL per-isolate cache for Host-header → custom-hostname mapping.
 * Staleness of up to {@link packageAppCustomHostnameLookupCacheTtlMs} is ok
 * for serve routing; mutations invalidate the hostname key in this isolate.
 * Other isolates re-read within the TTL (same pattern as entitlements).
 */
export const packageAppCustomHostnameLookupCacheTtlMs = 60_000
const maxEntries = 2_000

type CacheEntry = {
	value: Promise<PackageAppCustomHostnameLookup | null>
	expiresAtMs: number
}

const cachesByDb = new WeakMap<D1Database, Map<string, CacheEntry>>()

function cacheFor(db: D1Database) {
	let cache = cachesByDb.get(db)
	if (!cache) {
		cache = new Map()
		cachesByDb.set(db, cache)
	}
	return cache
}

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
	const cache = cacheFor(input.db)
	const nowMs = Date.now()
	const existing = cache.get(key)
	if (existing && existing.expiresAtMs > nowMs) {
		return await existing.value
	}
	const value = lookupPackageAppCustomHostname(input)
	value.catch(() => {
		if (cache.get(key)?.value === value) cache.delete(key)
	})
	if (cache.size >= maxEntries) {
		const oldestKey = cache.keys().next().value
		if (oldestKey !== undefined) cache.delete(oldestKey)
	}
	cache.set(key, {
		value,
		expiresAtMs: nowMs + packageAppCustomHostnameLookupCacheTtlMs,
	})
	return await value
}

/** Drop one hostname from this isolate's lookup cache after a mutation. */
export function invalidateCachedPackageAppCustomHostname(
	db: D1Database,
	hostname: string,
): void {
	const key = hostname.trim().toLowerCase()
	if (!key) return
	cacheFor(db).delete(key)
}

/** Test helper: wipe this isolate's custom-hostname lookup cache. */
export function clearCachedPackageAppCustomHostnames(db: D1Database): void {
	cachesByDb.delete(db)
}
