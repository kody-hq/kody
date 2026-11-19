import {
	invokeContractFreshnessCacheLimit,
	invokeContractFreshnessTtlMs,
} from '#worker/package-invocations/invoke-contract-cache.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'

/**
 * Per-isolate cache of the commit anonymous visitors run per app, same 15 s
 * freshness tier as the slug lookup it pairs with. Every entry names a commit
 * the owner approved, so a stale entry at most keeps visitors on the previous
 * approved version for one freshness window. Approval writes and serving
 * advances drop the entry in the isolate that made them.
 */
export const approvedCommitCache = new PromiseLruCache<string | null>({
	ttlMs: invokeContractFreshnessTtlMs,
	limit: invokeContractFreshnessCacheLimit,
})
