import { createListDetailLinks } from '#client/list-detail-route.ts'
import { matchesSearchQuery } from '#client/search-filter.ts'
import type { AdminStarterTemplate } from '#universal/loader-data.ts'

export const starterTemplatesRoute = createListDetailLinks(
	'/admin/starter-templates',
)

export function filterStarterTemplates(
	starters: Array<AdminStarterTemplate>,
	search: string,
) {
	return starters.filter((starter) =>
		matchesSearchQuery(search, [
			starter.name,
			starter.packageName,
			...starter.tags,
		]),
	)
}

/** Swaps a starter with its neighbor in a list of package ids. */
export function moveStarter(
	order: Array<string>,
	packageId: string,
	by: -1 | 1,
) {
	const from = order.indexOf(packageId)
	const to = from + by
	if (from < 0 || to < 0 || to >= order.length) return order
	const next = [...order]
	next[from] = order[to]!
	next[to] = packageId
	return next
}
