import type { NxCacheObject, NxCacheStore } from './nx-cache-types.ts'

export function createMemoryCacheStore(): NxCacheStore {
	const objects = new Map<string, Uint8Array>()

	return {
		async get(hash) {
			const bytes = objects.get(hash)
			if (!bytes) return null
			const body = new ArrayBuffer(bytes.byteLength)
			new Uint8Array(body).set(bytes)
			return {
				body,
				size: bytes.byteLength,
			} satisfies NxCacheObject
		},
		async putIfAbsent(hash, body) {
			if (objects.has(hash)) return 'exists'
			const bytes =
				body instanceof ArrayBuffer
					? new Uint8Array(body)
					: new Uint8Array(await new Response(body).arrayBuffer())
			if (objects.has(hash)) return 'exists'
			objects.set(hash, bytes)
			return 'created'
		},
	}
}
