import {
	useMutation,
	useQueryClient,
	type QueryClient,
} from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { pageQueryInputOrg } from './page-query-scope.ts'

const credentialResources = new Set([
	'loadCredentialsPage',
	'loadPackageCredentialsPage',
	'loadSecretsPage',
	'loadIntegrationsPage',
	'loadJobsPage',
	'loadWorkflowsPage',
	'loadWebhooksPage',
])
/** Both direct credential edits and approval decisions refresh the same consumers. */
export async function invalidateCredentialResources(
	client: QueryClient,
	actorKey: string | null,
	orgSlug: string | null,
) {
	if (orgSlug === null) return
	const filters = {
		predicate: ({ queryKey }: { queryKey: readonly unknown[] }) =>
			queryKey[0] === 'page' &&
			queryKey[1] === actorKey &&
			credentialResources.has(String(queryKey[2])) &&
			pageQueryInputOrg(queryKey[3]) === orgSlug,
	}
	await client.cancelQueries({
		...filters,
		predicate: (query) =>
			query.state.data !== undefined && filters.predicate(query),
	})
	await client.invalidateQueries(filters)
}

/** Credential writes invalidate only the submitting actor and organization. */
export function useCredentialMutation<TInput, TResult>(
	scope: { orgSlug: string | null },
	send: (input: TInput) => Promise<TResult>,
) {
	const client = useQueryClient()
	const { actorKey } = useRouteContext({ from: '__root__' })
	const org = scope.orgSlug
	return useMutation({
		mutationKey: ['credentials', actorKey, org],
		mutationFn: send,
		onMutate: () => ({ actorKey, org }),
		onSettled: async (_data, _error, _variables, submitted) => {
			if (!submitted) return
			await invalidateCredentialResources(
				client,
				submitted.actorKey,
				submitted.org,
			)
		},
	})
}
