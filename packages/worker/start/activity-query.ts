import { infiniteQueryOptions, type QueryClient } from '@tanstack/react-query'
import { loadActivityPage } from '#start/server/account-collections'

export type ActivityInput = Parameters<typeof loadActivityPage>[0]['data']

export function activityQuery(actorKey: string | null, input: ActivityInput) {
	return infiniteQueryOptions({
		meta: { actorKey },
		queryKey: ['page', actorKey, 'loadActivityPage', input] as const,
		initialPageParam: null as string | null,
		queryFn: ({ pageParam, signal }) =>
			loadActivityPage({
				data: { ...input, cursor: pageParam ?? input.cursor },
				signal,
			}),
		getNextPageParam: (lastPage) => lastPage.payload.nextCursor ?? undefined,
		staleTime: 10_000,
	})
}
export async function loadActivityQuery(
	client: QueryClient,
	actorKey: string | null,
	input: ActivityInput,
	preload = false,
) {
	const options = activityQuery(actorKey, input)
	// A foreground entry must recheck organization membership. An older
	// preload flight must not satisfy that authorization check.
	if (!preload)
		await client.cancelQueries({ queryKey: options.queryKey, exact: true })
	const data = !preload
		? await client.fetchInfiniteQuery({ ...options, staleTime: 0 })
		: await client.ensureInfiniteQueryData({
				...options,
				revalidateIfStale: true,
			})
	return { head: data.pages[0]?.head, pageHeadQueryKey: options.queryKey }
}
