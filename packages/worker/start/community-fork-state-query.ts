import { queryOptions } from '@tanstack/react-query'
import { type CommunityForkState } from '#universal/community-public-types.ts'
import { loadCommunityForkState } from '#start/server/community-mutations'

/** How often to re-read a fork that is still being created. */
export const FORK_IN_PROGRESS_POLL_MS = 2_000

const communityForkStateKey = (
	actorKey: string | null,
	listingId: string | null,
	org: string | null,
) => ['community-fork-state', actorKey, listingId, org] as const

/**
 * Live fork state for the viewer, one listing, and the install org (`org`,
 * null for the personal org). The page's `viewerInstall`
 * is computed at load time and misses a fork that was still in flight, and
 * local mutation state is lost when the viewer navigates away mid-fork. So
 * this read is never trusted from cache: it refetches on every mount
 * (including navigating back), on focus and visibility return (root
 * `refreshOnActivation` refetches stale active queries carrying this actor),
 * and polls while a fork is in progress.
 */
export function communityForkStateQuery(input: {
	actorKey: string | null
	listingId: string | null
	org?: string | null
	enabled: boolean
	load?: (listingId: string, signal: AbortSignal) => Promise<CommunityForkState>
}) {
	const org = input.org ?? null
	const load =
		input.load ??
		((listingId: string, signal: AbortSignal) =>
			loadCommunityForkState({
				data: { listingId, org },
				signal,
			}) as Promise<CommunityForkState>)
	return queryOptions({
		queryKey: communityForkStateKey(input.actorKey, input.listingId, org),
		queryFn: ({ signal }) => load(input.listingId ?? '', signal),
		enabled: input.enabled && Boolean(input.listingId),
		staleTime: 0,
		gcTime: 0,
		refetchOnMount: 'always',
		refetchOnWindowFocus: 'always',
		refetchInterval: (query) =>
			query.state.data?.state === 'in_progress'
				? FORK_IN_PROGRESS_POLL_MS
				: false,
		retry: false,
		meta: { actorKey: input.actorKey },
	})
}
