import { isolateCollection } from '@kody-internal/shared/isolate-state.ts'
import { secretProviderCacheTtlMs } from './errors.ts'

type CachedProviderSecret = {
	value: string
	hosts: Array<string>
	expiresAtMs: number
}

const cache = isolateCollection(new Map<string, CachedProviderSecret>())

function cacheKey(input: {
	userId: string
	providerId: string
	canonicalRef: string
}) {
	return `${input.userId}\u0000${input.providerId}\u0000${input.canonicalRef}`
}

export function readProviderSecretCache(input: {
	userId: string
	providerId: string
	canonicalRef: string
	nowMs?: number
}): { value: string; hosts: Array<string> } | null {
	const key = cacheKey(input)
	const entry = cache.get(key)
	if (!entry) return null
	const nowMs = input.nowMs ?? Date.now()
	if (entry.expiresAtMs <= nowMs) {
		cache.delete(key)
		return null
	}
	return { value: entry.value, hosts: entry.hosts }
}

export function writeProviderSecretCache(input: {
	userId: string
	providerId: string
	canonicalRef: string
	value: string
	hosts: Array<string>
	ttlMs?: number
	nowMs?: number
}) {
	const nowMs = input.nowMs ?? Date.now()
	const ttlMs = input.ttlMs ?? secretProviderCacheTtlMs
	cache.set(cacheKey(input), {
		value: input.value,
		hosts: input.hosts,
		expiresAtMs: nowMs + ttlMs,
	})
}

export function clearProviderSecretCacheForBinding(input: {
	userId: string
	providerId: string
}) {
	const prefix = `${input.userId}\u0000${input.providerId}\u0000`
	for (const key of cache.keys()) {
		if (key.startsWith(prefix)) cache.delete(key)
	}
}
