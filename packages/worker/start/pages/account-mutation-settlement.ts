import { type Query, type QueryClient } from '@tanstack/react-query'
import { invalidatePageResources } from '../page-invalidation-cache.ts'
import { pageQueryInputOrg } from '../page-query-scope.ts'
import { type PageResource } from '../page-resources.ts'
import { invalidateShellQueries } from '../shell-query.ts'

export const profileResources = [
	'loadAccountPage',
	'loadProfile',
	'loadCommunity',
	'loadPackage',
] as const
export const accountConnectionResources = [
	'loadAccountPage',
	'loadDiscord',
	'loadOnboarding',
] as const
export const jobResources = [
	'loadJobsPage',
	'loadActivityPage',
	'loadWorkflowsPage',
	'loadUsagePage',
] as const

/** Reads remain independent of writes. Preserve navigation's first promise,
 * then confirm the submitted scope, including inactive pages and lost replies. */
export async function settleAccountMutation(
	client: QueryClient,
	actorKey: string | null,
	resources: readonly PageResource[],
	options: { orgSlug?: string | null; shell?: boolean } = {},
) {
	const matches = (query: Query) =>
		query.queryKey[0] === 'page' &&
		query.queryKey[1] === actorKey &&
		resources.some((resource) => query.queryKey[2] === resource) &&
		(options.orgSlug === undefined ||
			pageQueryInputOrg(query.queryKey[3]) === options.orgSlug)
	const firstReads = client
		.getQueryCache()
		.findAll({ predicate: matches })
		.filter(
			(query) =>
				query.state.data === undefined &&
				query.state.fetchStatus === 'fetching',
		)
		.map((query) => query.promise)
	await Promise.allSettled(firstReads)
	await Promise.all([
		invalidatePageResources(
			client,
			actorKey,
			resources,
			'all',
			options.orgSlug === undefined ? undefined : { orgSlug: options.orgSlug },
		),
		options.shell ? invalidateShellQueries(client, actorKey) : undefined,
	])
}
