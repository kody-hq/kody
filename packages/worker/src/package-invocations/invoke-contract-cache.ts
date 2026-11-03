import { getPackageNameLeaf } from '#worker/package-registry/package-name.ts'
import {
	packageArtifactCacheBudget,
	PromiseLruCache,
} from '#worker/package-registry/published-package-cache.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { type PublishedBundleArtifact } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'

/**
 * Per-isolate caches for invocation hot paths (host invoke contract check and
 * package-app HTTP serve), so a warm call of an already-warm package+commit
 * performs zero D1/KV loads before dispatch (see
 * docs/contributing/architecture/invocation-overhead-guardrails.md).
 *
 * Two tiers with different lifetimes:
 *
 * - **Freshness tier** (saved-package row, entity-source row): these rows can change on republish/rename, so they carry a short
 *   TTL. That TTL is the cross-isolate republish staleness bound; the isolate
 *   that runs the projection refresh also invalidates eagerly, so it picks
 *   the new publish up immediately. Misses are never retained — a package
 *   saved moments later is visible on the next lookup.
 * - **Commit tier** (prepared bundle artifact): keyed by the published commit
 *   taken from the freshness tier, and a published commit's artifact is
 *   immutable, so entries here are never a staleness source. The TTL only
 *   bounds memory.
 *
 * Every cache key starts with the caller's `userId`; entries are never shared
 * across users.
 */

/**
 * Cross-isolate republish staleness bound for invocation paths: after
 * `entity_sources.published_commit` (or the saved-package row) changes, other
 * isolates serve the previous contract for at most this long.
 */
export const invokeContractFreshnessTtlMs = 15_000
export const invokeContractFreshnessCacheLimit = 200

/**
 * Commit-keyed artifact entries are immutable; this TTL and the small limit
 * exist only to bound isolate memory (bundle payloads can be large).
 */
export const invokeContractArtifactCacheTtlMs = 5 * 60 * 1000
export const invokeContractArtifactCacheLimit = 20

export type CachedInvokeModuleArtifact = {
	artifact: PublishedBundleArtifact
	source: EntitySourceRow
	entryPoint: string
}

function createFreshnessCache<T>() {
	return new PromiseLruCache<T>({
		ttlMs: invokeContractFreshnessTtlMs,
		limit: invokeContractFreshnessCacheLimit,
	})
}

function createArtifactCache() {
	return new PromiseLruCache<CachedInvokeModuleArtifact>({
		ttlMs: invokeContractArtifactCacheTtlMs,
		limit: invokeContractArtifactCacheLimit,
		byteBudget: packageArtifactCacheBudget,
	})
}

/**
 * Package-app host slug lookup: the URL path segment may be a retired slug.
 * Cached under a distinct key prefix from live-only {@link resolveSavedPackage}
 * so following redirects never teaches invocation paths to serve at an old path.
 */
export type PackageAppSlugLookup = {
	savedPackage: SavedPackageRecord
	/**
	 * True when the URL slug is retired and the package now lives at a different
	 * leaf. Callers must 308 to the current leaf instead of serving.
	 */
	retired: boolean
}

const savedPackageCache = createFreshnessCache<SavedPackageRecord | null>()
const packageAppSlugCache = createFreshnessCache<PackageAppSlugLookup | null>()
const sourceRowCache = createFreshnessCache<EntitySourceRow>()
const moduleArtifactCache = createArtifactCache()

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (value && typeof value === 'object') {
		const objectValue = value as object
		if (seen.has(objectValue)) {
			return value
		}
		seen.add(objectValue)
		for (const child of Object.values(value as Record<string, unknown>)) {
			deepFreeze(child, seen)
		}
		Object.freeze(objectValue)
	}
	return value
}

function savedPackageCacheKey(input: {
	userId: string
	packageIdOrKodyId: string
}) {
	return JSON.stringify([
		'saved-package',
		input.userId,
		input.packageIdOrKodyId,
	])
}

function packageAppSlugCacheKey(input: { userId: string; slug: string }) {
	return JSON.stringify(['saved-package-app-slug', input.userId, input.slug])
}

function sourceRowCacheKey(input: { userId: string; sourceId: string }) {
	return JSON.stringify(['source-row', input.userId, input.sourceId])
}

export async function resolveSavedPackageWithFreshnessCache(input: {
	userId: string
	packageIdOrKodyId: string
	load: () => Promise<SavedPackageRecord | null>
}): Promise<SavedPackageRecord | null> {
	const cacheKey = savedPackageCacheKey(input)
	return await savedPackageCache.getOrCreate({
		cacheKey,
		create: async () => {
			const record = await input.load()
			if (!record) {
				// Do not retain misses: a package saved moments later must be
				// visible on the next lookup instead of after the TTL.
				savedPackageCache.delete(cacheKey)
				return null
			}
			return deepFreeze(record)
		},
	})
}

/**
 * Freshness-cached package-app host lookup. Follows slug redirects but marks
 * `retired` so the host can 308 to the canonical path instead of serving at
 * the old URL (cookies, caches, and storage stay on one origin/path).
 */
export async function resolvePackageAppSlugWithFreshnessCache(input: {
	userId: string
	slug: string
	load: () => Promise<PackageAppSlugLookup | null>
}): Promise<PackageAppSlugLookup | null> {
	const cacheKey = packageAppSlugCacheKey(input)
	return await packageAppSlugCache.getOrCreate({
		cacheKey,
		create: async () => {
			const lookup = await input.load()
			if (!lookup) {
				packageAppSlugCache.delete(cacheKey)
				return null
			}
			return deepFreeze(lookup)
		},
	})
}

export async function loadSourceRowWithFreshnessCache(input: {
	userId: string
	sourceId: string
	load: () => Promise<EntitySourceRow>
}): Promise<EntitySourceRow> {
	return await sourceRowCache.getOrCreate({
		cacheKey: sourceRowCacheKey(input),
		create: async () => deepFreeze(await input.load()),
	})
}

export async function loadModuleArtifactWithCommitCache(input: {
	userId: string
	sourceId: string
	publishedCommit: string | null
	artifactName: string
	entryPoint: string
	load: () => Promise<CachedInvokeModuleArtifact>
}): Promise<CachedInvokeModuleArtifact> {
	if (!input.publishedCommit) {
		return await input.load()
	}
	const cacheKey = JSON.stringify([
		'module-artifact',
		input.userId,
		input.sourceId,
		input.publishedCommit,
		input.artifactName,
		input.entryPoint,
	])
	return await moduleArtifactCache.getOrCreate({
		cacheKey,
		create: async () => {
			const value = await input.load()
			if (value.artifact.publishedCommit !== input.publishedCommit) {
				// The bundle-artifact identity row can briefly point at a different
				// commit than the source row (e.g. mid-republish). Serve it, but do
				// not retain it under this commit's key — retaining would extend
				// staleness past the freshness-tier TTL.
				moduleArtifactCache.delete(cacheKey)
				return value
			}
			return deepFreeze(value)
		},
	})
}

function evictPackageAppSlugCache(input: { userId: string; slug: string }) {
	const slug = input.slug.trim()
	if (!slug) return
	packageAppSlugCache.delete(
		packageAppSlugCacheKey({ userId: input.userId, slug }),
	)
}

/**
 * Eager same-isolate invalidation for publish / projection-refresh / delete
 * flows. Cross-isolate pickup is bounded by
 * {@link invokeContractFreshnessTtlMs}. The commit-tier artifact cache needs
 * no invalidation: a republish changes the commit and therefore the key.
 */
export function invalidateInvokeContractFreshness(input: {
	userId: string
	/**
	 * Every lookup key the package resolves under: its package id plus any
	 * current (and, on rename, previous) kody ids / `kody:@scope/name` refs.
	 */
	packageIdOrKodyIds: Array<string>
	/**
	 * Package-app URL leaves to evict (current leaf, previous leaf on rename,
	 * and retired redirect slugs about to be released). Callers must pass
	 * these explicitly: {@link packageIdOrKodyIds} are often package ids or
	 * `kody:@scope/name` refs, not the name-leaf keys this cache uses.
	 */
	packageAppSlugs?: Array<string>
	sourceId?: string | null
}) {
	for (const packageIdOrKodyId of input.packageIdOrKodyIds) {
		savedPackageCache.delete(
			savedPackageCacheKey({ userId: input.userId, packageIdOrKodyId }),
		)
		if (packageIdOrKodyId.startsWith('kody:@')) {
			// Derive the URL leaf from the scoped name so rename/delete also
			// clears the package-app slug cache (keys are never `kody:@…`).
			evictPackageAppSlugCache({
				userId: input.userId,
				slug: getPackageNameLeaf(packageIdOrKodyId.slice('kody:'.length)),
			})
		} else {
			// When kodyId still equals the leaf, this also clears the slug entry.
			evictPackageAppSlugCache({
				userId: input.userId,
				slug: packageIdOrKodyId,
			})
		}
	}
	for (const slug of input.packageAppSlugs ?? []) {
		evictPackageAppSlugCache({ userId: input.userId, slug })
	}
	if (input.sourceId) {
		sourceRowCache.delete(
			sourceRowCacheKey({ userId: input.userId, sourceId: input.sourceId }),
		)
	}
}
