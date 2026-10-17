import {
	mutationOptions,
	type QueryClient,
	type QueryKey,
} from '@tanstack/react-query'
import { invalidatePageResources } from './page-invalidation-cache.ts'

export function creditSettingsMutationOptions<
	TInput extends { orgSlug: string },
	TResult,
>(
	client: QueryClient,
	queryKey: QueryKey,
	send: (input: { data: TInput }) => Promise<TResult>,
) {
	return mutationOptions({
		mutationFn: (data: TInput) => send({ data }),
		gcTime: 0,
		onMutate: (data: TInput) => ({
			actorKey: queryKey[1] as string | null,
			orgSlug: data.orgSlug,
		}),
		onSettled: async (_result, _error, _variables, scope) => {
			if (!scope) return
			await invalidatePageResources(
				client,
				scope.actorKey,
				['loadUsagePage', 'loadBillingPage'],
				'active',
				{ orgSlug: scope.orgSlug },
			)
		},
	})
}
