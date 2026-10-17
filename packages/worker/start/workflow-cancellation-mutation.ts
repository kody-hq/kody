import { type Query, type QueryClient } from '@tanstack/react-query'
import { invalidatePageResources } from './page-invalidation-cache.ts'
import { pageQueryInputOrg } from './page-query-scope.ts'
import { type PageResource } from './page-resources.ts'

type WorkflowCancellationScope = {
	actorKey: string | null
	orgSlug: string | null
}

const resources: readonly PageResource[] = [
	'loadWorkflowsPage',
	'loadWaitingPage',
	'loadActivityPage',
]

export function workflowCancellationMutationOptions<
	Input extends WorkflowCancellationScope,
	Output,
>(client: QueryClient, mutationFn: (input: Input) => Promise<Output>) {
	return {
		mutationFn,
		onSettled: async (
			_accepted: Output | undefined,
			_error: Error | null,
			input: Input,
		) => {
			const matches = (query: Query) =>
				query.queryKey[0] === 'page' &&
				query.queryKey[1] === input.actorKey &&
				resources.some((resource) => query.queryKey[2] === resource) &&
				pageQueryInputOrg(query.queryKey[3]) === input.orgSlug
			// A navigation owns this first-read promise. Let it settle rather than
			// rejecting it, then confirm the cancellation with a newer read.
			const unfinished = client
				.getQueryCache()
				.findAll({ predicate: matches })
				.filter(
					(query) =>
						query.state.data === undefined &&
						query.state.fetchStatus === 'fetching',
				)
			await Promise.allSettled(unfinished.map((query) => query.promise))
			// Confirm inactive reads too: navigation may have completed while the
			// write was pending, before this settlement callback captured queries.
			// A lost response may still mean the server cancelled the run. Always
			// reconcile the submitted actor and org, even after leaving the page.
			await invalidatePageResources(client, input.actorKey, resources, 'all', {
				orgSlug: input.orgSlug,
			})
		},
	}
}
