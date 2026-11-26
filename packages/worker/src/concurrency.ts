export async function mapWithConcurrency<T, R>(
	items: ReadonlyArray<T>,
	concurrency: number,
	mapper: (item: T) => Promise<R>,
): Promise<Array<R>> {
	if (items.length === 0) return []
	const limit = Math.max(1, Math.min(Math.floor(concurrency), items.length))
	const results: Array<R> = Array.from({ length: items.length })
	let nextIndex = 0
	await Promise.all(
		Array.from({ length: limit }, async () => {
			while (nextIndex < items.length) {
				const index = nextIndex
				nextIndex += 1
				results[index] = await mapper(items[index]!)
			}
		}),
	)
	return results
}
