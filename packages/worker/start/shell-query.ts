import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { loadShell } from '#start/server/shell'

export function shellSearch(search: string) {
	const input = new URLSearchParams(search)
	const output = new URLSearchParams()
	for (const key of ['youtubeId']) {
		const value = input.get(key)
		if (value !== null) output.set(key, value)
	}
	const value = output.toString()
	return value ? `?${value}` : ''
}

export function shellQuery(actorKey: string | null, search: string) {
	const relevantSearch = shellSearch(search)
	return queryOptions({
		meta: { actorKey },
		queryKey: ['shell', actorKey, relevantSearch] as const,
		queryFn: ({ signal }) =>
			loadShell({ data: { pathname: '/', search: relevantSearch }, signal }),
		staleTime: 60_000,
		gcTime: 5 * 60_000,
	})
}

export async function ensureShellQuery(
	client: QueryClient,
	actorKey: string | null,
	search: string,
	revalidateIfStale = true,
) {
	const options = shellQuery(actorKey, search)
	return client.ensureQueryData({ ...options, revalidateIfStale })
}

export function invalidateShellQueries(
	client: QueryClient,
	actorKey: string | null,
) {
	return client.invalidateQueries({ queryKey: ['shell', actorKey] })
}
