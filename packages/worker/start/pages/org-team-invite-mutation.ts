import { type QueryClient, type QueryKey } from '@tanstack/react-query'

export function teamInviteMutationOptions<TInput>(
	client: QueryClient,
	queryKey: QueryKey,
	send: (input: TInput) => Promise<void>,
) {
	return {
		gcTime: 0,
		retry: false,
		mutationFn: send,
		onMutate: () => queryKey,
		onSettled: async (
			_data: unknown,
			_error: unknown,
			_input: TInput,
			submittedKey: QueryKey | undefined,
		) => {
			if (!submittedKey) return
			const filters = { queryKey: submittedKey, exact: true }
			await client.cancelQueries(filters)
			await client.invalidateQueries(filters)
		},
	}
}
