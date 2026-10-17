import { mutationOptions, type QueryClient } from '@tanstack/react-query'
type ConversionData = { newHandle: string; confirmation: string }
/** Conversion changes every personal resource while keeping the person ID. */
export function conversionMutationOptions<TResult>(
	client: QueryClient,
	send: (input: { data: ConversionData }) => Promise<TResult>,
) {
	return mutationOptions({
		gcTime: 0,
		retry: false,
		mutationFn: ({ data }: { data: ConversionData; actorKey: string | null }) =>
			send({ data }),
		onSettled: async (_result, _error, input) => {
			const filters = {
				predicate: (query: { meta?: Record<string, unknown> }) =>
					query.meta?.actorKey === input.actorKey,
			}
			// An uncached read started before conversion can still hold the old personal org.
			await client.cancelQueries(filters)
			await client.invalidateQueries(filters)
		},
	})
}
