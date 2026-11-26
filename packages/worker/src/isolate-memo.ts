import { isolateCollection } from '@kody-internal/shared/isolate-state.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'

/**
 * One lazily built value per isolate: a dynamic `import()`, a derived key, a
 * built registry. A promise belongs to the request that created it, so a
 * module-scope `memo ??= load()` hands every later request a promise that can
 * never settle once its creator ends (workerd: "This promise was created by a
 * request that has since ended"), wedging the isolate. This shares a settled
 * value, or an in-flight load only while it can still settle; an orphaned or
 * failed load is replaced by a load in the caller's own request (the module
 * registry dedupes repeated `import()` evaluation).
 */
export function isolateMemo<T>(load: () => Promise<T>): () => Promise<T> {
	const cache = isolateCollection(
		new PromiseLruCache<T>({ ttlMs: Number.POSITIVE_INFINITY, limit: 1 }),
	)
	return () => cache.getOrCreate({ cacheKey: 'value', create: load })
}

/** {@link isolateMemo} per key, for values derived from a key or secret. */
export function isolateMemoByKey<T>(
	load: (key: string) => Promise<T>,
	options?: { limit?: number },
) {
	const cache = isolateCollection(
		new PromiseLruCache<T>({
			ttlMs: Number.POSITIVE_INFINITY,
			limit: options?.limit ?? 64,
		}),
	)
	return Object.assign(
		(key: string) =>
			cache.getOrCreate({ cacheKey: key, create: () => load(key) }),
		{ clear: () => cache.clear() },
	)
}
