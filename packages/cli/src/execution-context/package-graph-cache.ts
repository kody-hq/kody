import { createHash } from 'node:crypto'
import { type LocalPackageGraph } from '../local-package-graph.js'

export type PackageGraphCacheSlot = {
	get: () => LocalPackageGraph | undefined
	set: (graph: LocalPackageGraph) => void
}

export type PackageGraphCache = {
	slot: (scope: {
		apiUrl: string
		userId: string
		orgId: string
		conversationId?: string
		code: string
	}) => PackageGraphCacheSlot
	readonly size: number
}

/**
 * Package graphs a daemon fetched recently, keyed by who asked and a hash of
 * the module source (which names every `kody:@` import). Bounded LRU with a
 * short TTL so republished packages and changed access show up quickly.
 */
export function createPackageGraphCache(
	options: { maxEntries?: number; ttlMs?: number; now?: () => number } = {},
): PackageGraphCache {
	const maxEntries = options.maxEntries ?? 32
	const ttlMs = options.ttlMs ?? 60_000
	const now = options.now ?? Date.now
	const entries = new Map<
		string,
		{ graph: LocalPackageGraph; expiresAt: number }
	>()
	return {
		get size() {
			return entries.size
		},
		slot(scope) {
			const key = createHash('sha256')
				.update(
					JSON.stringify([
						scope.apiUrl,
						scope.userId,
						scope.orgId,
						scope.conversationId ?? null,
						scope.code,
					]),
				)
				.digest('hex')
			return {
				get: () => {
					const entry = entries.get(key)
					if (!entry) return undefined
					entries.delete(key)
					if (entry.expiresAt <= now()) return undefined
					entries.set(key, entry)
					return entry.graph
				},
				set: (graph) => {
					entries.delete(key)
					entries.set(key, { graph, expiresAt: now() + ttlMs })
					while (entries.size > maxEntries) {
						const oldest = entries.keys().next().value
						if (oldest === undefined) break
						entries.delete(oldest)
					}
				},
			}
		},
	}
}
