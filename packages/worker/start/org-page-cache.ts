import { scopedPageResource, type PageOrgScope } from './page-query-scope.ts'
import { type QueryClient } from '@tanstack/react-query'

/** A mutation carries its initiating workspace even after navigation. */
export const orgPageFilters = scopedPageResource
export function updateOrgPagePayload<T>(
	client: QueryClient,
	actorKey: string | null,
	resource: string,
	scope: PageOrgScope,
	update: (payload: T) => T,
) {
	client.setQueriesData<{ payload: T }>(
		orgPageFilters(actorKey, resource, scope),
		(data) => (data ? { ...data, payload: update(data.payload) } : data),
	)
}
