import { type QueryClient } from '@tanstack/react-query'
import { invalidatePageResources } from './page-invalidation-cache.ts'

/** Membership and grant writes affect both page and resource query caches. */
export function permissionsMutationOptions(
	client: QueryClient,
	actorKey: string | null,
) {
	return {
		gcTime: 0,
		onMutate: async () => {
			const submitted = { actorKey }
			await client.cancelQueries({
				predicate: (query) =>
					query.meta?.actorKey === actorKey && query.state.data !== undefined,
			})
			return submitted
		},
		onSettled: async (
			_data: unknown,
			_error: Error | null,
			_input: unknown,
			submitted: { actorKey: string | null } | undefined,
		) => {
			if (!submitted) return
			await invalidatePageResources(client, submitted.actorKey, 'permissions')
		},
	}
}
