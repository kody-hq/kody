import {
	queryOptions,
	useSuspenseQuery,
	type QueryKey,
	type QueryClient,
	type FetchQueryOptions,
	type UseSuspenseQueryOptions,
} from '@tanstack/react-query'
import { isNotFound } from '@tanstack/react-router'
import { type ResolvedDocumentHead } from '#universal/document-head.ts'

export type PageQueryPolicy<TInput = unknown> = {
	/** How long this resource can be reused without another read. */
	staleTime?: number
	gcTime?: number
	/** Entry must verify permissions even when an earlier preload is available. */
	freshAuthorization?: boolean | ((input: TInput) => boolean)
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
			queryFn: ({ signal }) => read({ data: input, signal }),
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
	if (!preload && options.meta?.freshAuthorization === true) {
		// A preload may have read permissions before revocation. Its late result
		// must not satisfy the foreground authorization check.
		await client.cancelQueries({ queryKey: options.queryKey, exact: true })
		return client.fetchQuery({ ...options, staleTime: 0 })
	}
	const state = client.getQueryState(options.queryKey)
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
