/** Router parses URL values as JSON. Text filters also accept bookmarked primitives. */
export function searchText(value: unknown): string | undefined {
	if (value === undefined) return undefined
	if (typeof value === 'string') return value
	if (value === null || typeof value === 'object') return JSON.stringify(value)
	if (typeof value === 'number' || typeof value === 'boolean')
		return String(value)
	return undefined
}

export function collectionSearch(search: Record<string, unknown>) {
	return {
		...search,
		q: searchText(search.q),
		selected: searchText(search.selected),
		view:
			search.view === 'history'
				? ('history' as const)
				: search.view === 'all'
					? ('all' as const)
					: ('active' as const),
	}
}

export function memoriesSearch(search: Record<string, unknown>) {
	const deleted = searchText(search.includeDeleted)?.trim().toLowerCase()
	return {
		...search,
		q: searchText(search.q),
		selected: searchText(search.selected),
		includeDeleted: deleted === '1' || deleted === 'true' || deleted === 'yes',
	}
}

export function secretsSearch(search: Record<string, unknown>) {
	return {
		...search,
		q: searchText(search.q),
		selected: searchText(search.selected),
		package: searchText(search.package),
		scope: searchText(search.scope),
	}
}

/** A presentation query does not change resource selection or authorization. */
export function textSearch(search: Record<string, unknown>) {
	return { ...search, q: searchText(search.q) }
}
