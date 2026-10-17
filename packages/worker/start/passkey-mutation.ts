import {
	mutationOptions,
	type QueryClient,
	type QueryKey,
} from '@tanstack/react-query'
import { invalidatePageResources } from './page-invalidation-cache.ts'
import { invalidateShellQueries } from './shell-query.ts'

export function passkeyMutationOptions<TInput, TResult>(
	client: QueryClient,
	queryKey: QueryKey,
	send: (input: { data: TInput }) => Promise<TResult>,
) {
	return mutationOptions({
		mutationFn: (data: TInput) => send({ data }),
		gcTime: 0,
		onMutate: () => ({ actorKey: queryKey[1] as string | null }),
		onSettled: async (_result, _error, _variables, scope) => {
			if (!scope) return
			await Promise.all([
				invalidatePageResources(client, scope.actorKey, [
					'loadAccountSecurity',
					'loadAccountPage',
				]),
				invalidateShellQueries(client, scope.actorKey),
			])
		},
	})
}
