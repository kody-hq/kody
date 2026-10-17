import { mutationOptions, type QueryClient } from '@tanstack/react-query'
import {
	invalidatePageResources,
	type PageMutationDependencies,
} from './page-invalidation-cache.ts'

export function secretMutationOptions<TInput, TResult>(
	client: QueryClient,
	actorKey: string | null,
	orgSlug: string | null,
	resources: PageMutationDependencies,
	send: (input: { data: TInput }) => Promise<TResult>,
) {
	return mutationOptions({
		mutationFn: (data: TInput) => send({ data }),
		gcTime: 0,
		retry: false,
		onMutate: () => ({ actorKey, orgSlug }),
		onSettled: async (_result, _error, _input, scope) => {
			if (!scope) return
			await invalidatePageResources(
				client,
				scope.actorKey,
				resources,
				'active',
				{ orgSlug: scope.orgSlug },
			)
		},
	})
}
