import { type QueryClient } from '@tanstack/react-query'
import { emailKeys } from './email-resources.ts'

export function emailDestinationMutationOptions(
	client: QueryClient,
	actorKey: string | null,
) {
	return {
		mutationKey: ['email-destination-write', actorKey],
		gcTime: 0,
		onMutate: async () => {
			const queryKey = emailKeys.destinations(actorKey)
			await client.cancelQueries({ queryKey, exact: true })
			return queryKey
		},
		// A lost response can still mean the write committed. Reconcile the
		// submitting account, even when the active account has since changed.
		onSettled: (
			_data: unknown,
			_error: Error | null,
			_input: unknown,
			queryKey: ReturnType<typeof emailKeys.destinations> | undefined,
		) => {
			if (queryKey) return client.invalidateQueries({ queryKey, exact: true })
		},
	}
}
