import { searchText } from './filter-search.ts'
import {
	type AdminOrgKind,
	type AdminOrgStatus,
} from '#worker/admin/orgs-data.ts'

export function adminOrgReturnTo(location: {
	pathname: string
	searchStr: string
}) {
	return location.pathname + location.searchStr
}

export function adminOrgsFilters(search: Record<string, unknown>) {
	const page = Number.parseInt(String(search.page ?? ''), 10)
	const status = searchText(search.status)
	const kind = searchText(search.kind)
	const normalizedStatus: AdminOrgStatus =
		status === 'deleted' || status === 'all' ? status : 'live'
	const normalizedKind: AdminOrgKind | 'all' =
		kind === 'personal' || kind === 'team' || kind === 'all' ? kind : 'all'
	return {
		query: searchText(search.q)?.trim() ?? '',
		status: normalizedStatus,
		kind: normalizedKind,
		page: Number.isFinite(page) && page > 0 ? page : 1,
		pageSize: 20,
	}
}

export function adminOrgsSearch(search: Record<string, unknown>) {
	return {
		...search,
		q: searchText(search.q),
		status: adminOrgsFilters(search).status,
		kind: adminOrgsFilters(search).kind,
		page: adminOrgsFilters(search).page,
	}
}
