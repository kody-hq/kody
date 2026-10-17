import { memoriesSearch } from './filter-search.ts'
/** Route search is normalized once, before it becomes a Query key or RPC input. */
export function memoriesInput(
	orgSlug: string,
	search: Record<string, unknown>,
	memoryId?: string,
) {
	const filters = memoriesSearch(search)
	return {
		orgSlug,
		memoryId,
		selected: filters.selected?.trim() || undefined,
		query: filters.q?.trim() ?? '',
		includeDeleted: filters.includeDeleted,
	}
}
