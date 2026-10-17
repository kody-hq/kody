import { pageQueryInputOrg, type PageOrgScope } from './page-query-scope.ts'
import { type QueryClient, type Query } from '@tanstack/react-query'
import { type PageResource } from './page-resources.ts'

export type PageMutationDependencies = readonly PageResource[] | 'permissions'

/** Permission policy changes can affect every resource. Ordinary writes name
 * their dependencies, including inactive cached pages visited later. */
export async function invalidatePageResources(
	client: QueryClient,
	actorKey: string | null,
	resources: PageMutationDependencies,
	refetchType: 'active' | 'all' | 'none' = 'active',
	scope?: PageOrgScope,
) {
	const filters = {
		queryKey: resources === 'permissions' ? undefined : ['page', actorKey],
		predicate: (query: Query) =>
			(resources === 'permissions' && query.meta?.actorKey === actorKey) ||
			(resources !== 'permissions' &&
				resources.some((resource) => query.queryKey[2] === resource) &&
				(scope === undefined ||
					pageQueryInputOrg(query.queryKey[3]) === scope.orgSlug)),
	}
	// A read started before the write must not satisfy its confirming refresh.
	// Keep uncached reads waiting on a pending mutation barrier alive, because
	// a navigation may already be awaiting that shared promise.
	await client.cancelQueries({
		...filters,
		predicate: (query) =>
			query.state.data !== undefined && filters.predicate(query),
	})
	await client.invalidateQueries({ ...filters, refetchType })
}
