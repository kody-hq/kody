/**
 * In-memory `KVNamespace` for node tests that exercise `list` pagination.
 * Keys are listed in sorted order like the real binding. A cursor resumes
 * after the last key it returned, so deleting a listed page (the provider's
 * revoke loop) does not skip the next one.
 */
export function createMemoryKvNamespace(initial?: Record<string, string>) {
	const store = new Map<string, string | Uint8Array<ArrayBuffer>>(
		Object.entries(initial ?? {}),
	)
	const defaultListLimit = 1000
	const namespace = {
		async get(key: string, options?: string | { type?: string }) {
			const raw = store.get(key)
			if (raw === undefined) return null
			const type = typeof options === 'string' ? options : options?.type
			if (type === 'arrayBuffer') {
				const bytes =
					typeof raw === 'string' ? new TextEncoder().encode(raw) : raw
				return bytes.slice().buffer
			}
			const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
			return type === 'json' ? JSON.parse(text) : text
		},
		async put(key: string, value: string | ArrayBuffer | ArrayBufferView) {
			store.set(
				key,
				typeof value === 'string'
					? value
					: ArrayBuffer.isView(value)
						? new Uint8Array(
								value.buffer,
								value.byteOffset,
								value.byteLength,
							).slice()
						: new Uint8Array(value).slice(),
			)
		},
		async delete(key: string) {
			store.delete(key)
		},
		async list(options?: {
			prefix?: string | null
			cursor?: string | null
			limit?: number
		}) {
			const prefix = options?.prefix ?? ''
			const after = options?.cursor
				? Buffer.from(options.cursor, 'base64url').toString()
				: undefined
			const matching = [...store.keys()]
				.filter((key) => key.startsWith(prefix))
				.filter((key) => after === undefined || key > after)
				.sort()
			const limit = options?.limit ?? defaultListLimit
			const page = matching.slice(0, limit)
			const lastKey = page.at(-1)
			const keys = page.map((name) => ({ name }))
			return lastKey !== undefined && page.length < matching.length
				? {
						keys,
						list_complete: false as const,
						cursor: Buffer.from(lastKey).toString('base64url'),
					}
				: { keys, list_complete: true as const, cacheStatus: null }
		},
	}
	return { kv: namespace as unknown as KVNamespace, store }
}
