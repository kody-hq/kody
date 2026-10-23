import { expect, test } from 'vitest'

import { cacheObjectKey, createR2CacheStore } from './r2-store.ts'

const HASH = '0123456789abcdef0123456789abcdef'

function createFakeR2() {
	const objects = new Map<string, Uint8Array>()
	return {
		async get(key: string) {
			const bytes = objects.get(key)
			if (!bytes) return null
			return { body: bytes, size: bytes.byteLength }
		},
		async put(
			key: string,
			value: ArrayBuffer | ReadableStream,
			options?: { onlyIf?: { etagDoesNotMatch?: string } },
		) {
			if (options?.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) {
				return { onlyIfFailed: true as const, size: 0, key }
			}
			const bytes =
				value instanceof ArrayBuffer
					? new Uint8Array(value)
					: new Uint8Array(await new Response(value).arrayBuffer())
			objects.set(key, bytes)
			return { key, size: bytes.byteLength }
		},
	} as unknown as R2Bucket
}

test('R2 store refuses overwrite and round-trips an artifact', async () => {
	const store = createR2CacheStore(createFakeR2())
	const body = new TextEncoder().encode('artifact').buffer

	expect(await store.putIfAbsent(HASH, body)).toBe('created')
	expect(await store.putIfAbsent(HASH, body)).toBe('exists')

	const stored = await store.get(HASH)
	expect(stored?.size).toBe(body.byteLength)
	expect(cacheObjectKey(HASH)).not.toBe(cacheObjectKey(`${HASH}2`))
})
