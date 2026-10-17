import { type QueryClient } from '@tanstack/react-query'
import { orgPageFilters } from './org-page-cache.ts'

/** Confirm the initiating workspace after every outcome, including lost responses.
 * First navigation reads are allowed to finish, never canceled or blocked by writes. */
export async function settleConnectionResources(
	client: QueryClient,
	actorKey: string | null,
	orgSlug: string | null,
	resources: readonly string[],
) {
	const filters = resources.map((resource) =>
		orgPageFilters(actorKey, resource, { orgSlug }),
	)
	const unfinished = filters
		.flatMap((filter) => client.getQueryCache().findAll(filter))
		.filter(
			(query) =>
				query.state.data === undefined &&
				query.state.fetchStatus === 'fetching',
		)
	await Promise.allSettled(unfinished.map((query) => query.promise))
	await Promise.all(
		filters.map((filter) =>
			client.invalidateQueries({ ...filter, refetchType: 'all' }),
		),
	)
}
