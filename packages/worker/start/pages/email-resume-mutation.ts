import { mutationOptions, type QueryClient } from '@tanstack/react-query'
import { emailKeys } from './email-resources.ts'
export function emailResumeMutationOptions<TResult>(
	client: QueryClient,
	send: (input: { data: { orgSlug?: string } }) => Promise<TResult>,
) {
	return mutationOptions({
		gcTime: 0,
		retry: false,
		mutationFn: ({
			orgSlug,
		}: {
			actorKey: string | null
			orgSlug: string | null
		}) => send({ data: { orgSlug: orgSlug ?? undefined } }),
		onSettled: async (_data, _error, input) => {
			const filters = { queryKey: emailKeys.all(input.actorKey, input.orgSlug) }
			await client.cancelQueries(filters)
			await client.invalidateQueries(filters)
		},
	})
}
