/** Keep only inputs the resource reads, in a stable order. Presentation and
 * attribution parameters remain in the browser URL, outside the data cache. */
export function pageSearch(search: string, keys: readonly string[]) {
	const input = new URLSearchParams(search)
	const output = new URLSearchParams()
	for (const key of keys) {
		const value = input.get(key)
		if (value !== null) output.set(key, value)
	}
	const value = output.toString()
	return value ? `?${value}` : ''
}

/** Uncapped repository lists filter locally. Only a capped inventory reads q. */
export function repositoryPageSearch(search: string) {
	return pageSearch(
		search,
		new URLSearchParams(search).has('limit') ? ['limit', 'q'] : [],
	)
}
