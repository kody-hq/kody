import {
	mutationOptions,
	type QueryClient,
	type QueryKey,
} from '@tanstack/react-query'

export function orgDomainMutationOptions<TInput, TResult>(
	client: QueryClient,
	queryKey: QueryKey,
	send: (input: { data: TInput }) => Promise<TResult>,
) {
	return mutationOptions({
		mutationFn: (data: TInput) => send({ data }),
		gcTime: 0,
		onMutate: () => ({ queryKey }),
		onSettled: async (_result, _error, _variables, submission) => {
			if (!submission) return
			const filters = { queryKey: submission.queryKey, exact: true }
			// Reconcile even when the response was lost after Cloudflare accepted a write.
			// Cancel older reads and retain the original actor/org scope after navigation.
			await client.cancelQueries(filters)
			await client.invalidateQueries(filters)
		},
	})
}
