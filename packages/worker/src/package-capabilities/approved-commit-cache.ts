import {
	invokeContractFreshnessCacheLimit,
	invokeContractFreshnessTtlMs,
} from '#worker/package-invocations/invoke-contract-cache.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'

/**
 * Per-isolate cache of the commit anonymous visitors may run per app, same
 * 15 s freshness tier as the slug lookup it pairs with. Serve still refuses
 * anonymous requests whose live published commit differs, so a stale entry
 * never widens what anonymous visitors run. Approval writes drop the entry;
 * publish warms it.
 */
export const approvedCommitCache = new PromiseLruCache<string | null>({
	ttlMs: invokeContractFreshnessTtlMs,
	limit: invokeContractFreshnessCacheLimit,
})
