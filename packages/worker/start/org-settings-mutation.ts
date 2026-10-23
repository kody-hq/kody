import {
	mutationOptions,
	type QueryClient,
	type QueryKey,
} from '@tanstack/react-query'
import { invalidateShellQueries } from './shell-query.ts'

/** Successful delete returns redirectTo; invalidate would refetch not-found before navigate. */
function leavesPage(result: unknown): boolean {
	return (
		result != null &&
		typeof result === 'object' &&
		'redirectTo' in result &&
		typeof result.redirectTo === 'string'
	)
}

export function orgSettingsMutationOptions<TInput, TResult>(
	client: QueryClient,
	queryKey: QueryKey,
	actorKey: string | null,
	send: (input: { data: TInput }) => Promise<TResult>,
) {
	return mutationOptions({
		mutationFn: (data: TInput) => send({ data }),
		gcTime: 0,
		onMutate: () => ({ queryKey, actorKey }),
		onSettled: async (result, _error, _variables, scope) => {
			if (!scope) return
			await Promise.all([
				client.cancelQueries({
					queryKey: scope.queryKey,
					exact: true,
					predicate: (query) => query.state.data !== undefined,
				}),
				client.cancelQueries({
					queryKey: ['shell', scope.actorKey],
					predicate: (query) => query.state.data !== undefined,
				}),
				client.cancelQueries({
					queryKey: ['page', scope.actorKey, 'loadOrganizations'],
					predicate: (query) => query.state.data !== undefined,
				}),
			])
			const pageQuery = leavesPage(result)
				? client.removeQueries({ queryKey: scope.queryKey, exact: true })
				: client.invalidateQueries({ queryKey: scope.queryKey, exact: true })
			await Promise.all([
				pageQuery,
				invalidateShellQueries(client, scope.actorKey),
				client.invalidateQueries({
					queryKey: ['page', scope.actorKey, 'loadOrganizations'],
				}),
			])
		},
	})
}
