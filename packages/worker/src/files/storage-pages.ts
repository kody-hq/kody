/** Durable Object KV lists are bounded. Scan explicitly for backup and maintenance. */
export async function allStorageRows<T>(
	storage: Pick<DurableObjectStorage, 'list'>,
	prefix: string,
): Promise<Map<string, T>> {
	const result = new Map<string, T>()
	let startAfter: string | undefined
	for (;;) {
		const page = await storage.list<T>({ prefix, startAfter, limit: 500 })
		for (const [key, value] of page) result.set(key, value)
		if (page.size < 500) return result
		startAfter = Array.from(page.keys()).at(-1)
	}
}
