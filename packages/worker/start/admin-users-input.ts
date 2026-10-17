import { searchText } from './filter-search.ts'
import { parsePersonId } from '@kody-internal/shared/owner-person-ids.ts'

/** URL search is decoded once at the navigation boundary, not inside the RPC. */
export function adminUsersFilters(search: Record<string, unknown>) {
	const pageSize = Number.parseInt(String(search.pageSize ?? ''), 10)
	return {
		query: searchText(search.q)?.trim() ?? '',
		role: searchText(search.role)?.trim() ?? '',
		verification: searchText(search.verification)?.trim() ?? '',
		pageSize:
			Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : 20,
	}
}

export function adminUsersSelection(
	search: Record<string, unknown>,
	pathStableUserId?: string,
) {
	return (
		parsePersonId(pathStableUserId) ??
		parsePersonId(searchText(search.selected))
	)
}

export function adminUsersSearch(search: Record<string, unknown>) {
	return {
		...search,
		q: searchText(search.q),
		role: searchText(search.role),
		verification: searchText(search.verification),
		selected: searchText(search.selected),
		pageSize: adminUsersFilters(search).pageSize,
	}
}
