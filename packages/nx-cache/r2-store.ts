import type { NxCacheObject, NxCacheStore } from './nx-cache-types.ts'

const OBJECT_PREFIX = 'v1/'

export function cacheObjectKey(hash: string) {
	return `${OBJECT_PREFIX}${hash}`
}

function isOnlyIfFailed(
	result: R2Object | null,
): result is R2Object & { onlyIfFailed: true } {
	return (
		result !== null && 'onlyIfFailed' in result && result.onlyIfFailed === true
	)
}

export function createR2CacheStore(bucket: R2Bucket): NxCacheStore {
	return {
		async get(hash) {
			const object = await bucket.get(cacheObjectKey(hash))
			if (!object) return null
			return {
				body: object.body,
				size: object.size,
			} satisfies NxCacheObject
		},
		async putIfAbsent(hash, body) {
			const key = cacheObjectKey(hash)
			const result = await bucket.put(key, body, {
				onlyIf: { etagDoesNotMatch: '*' },
				httpMetadata: { contentType: 'application/octet-stream' },
			})
			if (result === null || isOnlyIfFailed(result)) return 'exists'
			return 'created'
		},
	}
}
