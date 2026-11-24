import {
	queryOptions,
	useQuery,
	hashKey,
	useSuspenseQuery,
	type QueryKey,
	type QueryClient,
	type FetchQueryOptions,
	type UseSuspenseQueryOptions,
	type UseQueryOptions,
} from '@tanstack/react-query'
import { isNotFound } from '@tanstack/react-router'
import type { ResolvedDocumentHead } from '#universal/document-head.ts'

export type PageQueryPolicy<TInput = unknown> = {
	/** How long this resource can be reused without another read. */
	staleTime?: number
	gcTime?: number
	/** Entry must verify permissions even when an earlier preload is available. */
	freshAuthorization?: boolean | ((input: TInput) => boolean)
}

/**
 * How recently a permission-sensitive read must have been sent to the server
 * for a navigation to accept it. Covers the gap between hovering a link and
 * clicking it, so the hover's read is the click's read.
 */
export const freshAuthorizationWindowMs = 5_000

type ReadTimes = {
	/** When the read now in flight was sent. */
	inFlight?: number
	/** When the read that produced the cached data was sent. */
	arrived?: number
}

const readTimesByClient = new WeakMap<QueryClient, Map<string, ReadTimes>>()

function readTimesFor(client: QueryClient, queryKey: QueryKey) {
	let all = readTimesByClient.get(client)
	if (!all) readTimesByClient.set(client, (all = new Map()))
	const now = Date.now()
	if (all.size > 100) {
		for (const [key, times] of all) {
			const latest = Math.max(times.inFlight ?? 0, times.arrived ?? 0)
			if (now - latest >= freshAuthorizationWindowMs) all.delete(key)
		}
	}
	const key = hashKey(queryKey)
	let times = all.get(key)
	if (!times) all.set(key, (times = {}))
	return times
}

/** Query owns transport cancellation, independently of an individual navigation. */
export function createPageQuery<TInput, TData>(
	resource: string,
	read: (options: { data: TInput; signal: AbortSignal }) => Promise<TData>,
	policy: PageQueryPolicy<TInput> = {},
) {
	return (actorKey: string | null, input: TInput) =>
		queryOptions({
			queryKey: ['page', actorKey, resource, input] as const,
			queryFn: async ({ signal, client, queryKey }) => {
				const times = readTimesFor(client, queryKey)
				const sentAt = Date.now()
				times.inFlight = sentAt
				try {
					const data = await read({ data: input, signal })
					// A canceled read never reaches the cache.
					if (!signal.aborted) times.arrived = sentAt
					return data
				} finally {
					if (times.inFlight === sentAt) times.inFlight = undefined
				}
			},
			staleTime: policy.staleTime ?? 30_000,
			gcTime: policy.gcTime ?? 5 * 60_000,
			meta: {
				actorKey,
				freshAuthorization:
					typeof policy.freshAuthorization === 'function'
						? policy.freshAuthorization(input)
						: policy.freshAuthorization === true,
			},
		})
}

/** Permission failures must replace a cached page, even on a background read. */
export function usePageQuery<TData, TKey extends QueryKey>(
	options: UseSuspenseQueryOptions<TData, Error, TData, TKey>,
) {
	const result = useSuspenseQuery(options)
	if (isNotFound(result.error)) throw result.error
	return result
}

/** Recheck access before reusing pages whose permissions can change independently of actor identity. */
export async function ensurePageQuery<TData, TKey extends QueryKey>(
	client: QueryClient,
	options: FetchQueryOptions<TData, Error, TData, TKey>,
	preload: boolean,
) {
	const state = client.getQueryState(options.queryKey)
	if (options.meta?.freshAuthorization === true) {
		const times = readTimesByClient.get(client)?.get(hashKey(options.queryKey))
		const now = Date.now()
		const recent = (sentAt: number | undefined) =>
			sentAt !== undefined && now - sentAt < freshAuthorizationWindowMs
		if (!state?.isInvalidated) {
			// The server is authorizing this read right now: wait for it. Cached
			// data from an older read must not answer in its place.
			if (state?.fetchStatus === 'fetching' && recent(times?.inFlight)) {
				return client.fetchQuery({ ...options, staleTime: 0 })
			}
			// The cached data came from a read the server authorized moments ago.
			if (
				state?.fetchStatus === 'idle' &&
				state.status === 'success' &&
				recent(times?.arrived)
			) {
				return client.fetchQuery({ ...options, staleTime: Infinity })
			}
		}
		if (preload) {
			// The page on screen already holds this read. Hovering a link back
			// to it, such as a filter or view link, must not start another.
			const mounted = client
				.getQueryCache()
				.find({ queryKey: options.queryKey, exact: true })
				?.isActive()
			if (mounted && !state?.isInvalidated) {
				return client.ensureQueryData({ ...options, revalidateIfStale: true })
			}
			// Otherwise a preload repeats an older read so the click that
			// follows finds one inside the window. It leaves a read in flight
			// alone, since a navigation may be waiting on it.
			if (state?.fetchStatus === 'fetching') return client.fetchQuery(options)
		}
		// An older read may predate a revocation. Its late result must not
		// satisfy the foreground authorization check.
		await client.cancelQueries({ queryKey: options.queryKey, exact: true })
		return client.fetchQuery({ ...options, staleTime: 0 })
	}
	// Explicit invalidation requires authoritative data; elapsed age alone is SWR.
	if (state?.isInvalidated) return client.fetchQuery(options)
	return client.ensureQueryData({ ...options, revalidateIfStale: true })
}

/** Router keeps the head fallback and exact cache reference, never a second page payload. */
export async function loadPageQuery<
	TData extends object,
	TKey extends QueryKey,
>(
	client: QueryClient,
	options: FetchQueryOptions<TData, Error, TData, TKey>,
	preload: boolean,
) {
	const data = await ensurePageQuery(client, options, preload)
	const head = ('head' in data ? data.head : undefined) as
		| ResolvedDocumentHead
		| undefined
	// Only content resources own reactive metadata. Shared resources leave it
	// to the matched route, such as Profile, Security and Data using one account read.
	return { head, ...(head ? { pageHeadQueryKey: options.queryKey } : {}) }
}

/** Previous rows belong only to the same account and mounted resource scope. */
export function filteredPageQueryOptions<TData, TKey extends QueryKey>(
	options: UseSuspenseQueryOptions<TData, Error, TData, TKey>,
	scope: QueryKey,
): UseQueryOptions<TData, Error, TData, TKey> {
	const filterScope = hashKey(scope)
	return {
		...options,
		meta: { ...options.meta, filterScope },
		placeholderData: (data, previous) =>
			previous?.meta?.filterScope === filterScope ? data : undefined,
		throwOnError: true,
	}
}

/** Filter changes stay inside Query rather than suspending the mounted page. */
export function useFilteredPageQuery<TData, TKey extends QueryKey>(
	options: UseSuspenseQueryOptions<TData, Error, TData, TKey>,
	scope: QueryKey,
) {
	return useQuery(filteredPageQueryOptions(options, scope))
}
