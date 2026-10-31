import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { createPageQuery } from './page-query.ts'
import { loadProfilesPage } from '#start/server/profiles'

export function validateProfilesSearch(search: Record<string, unknown>) {
	return {
		members: search.members === 'all' ? 'all' : undefined,
	} as { members?: 'all' }
}

// Profiles, statuses and tokens change outside this page (API, MCP, expiry).
const pageQuery = createPageQuery('loadProfilesPage', loadProfilesPage, {
	freshAuthorization: true,
	staleTime: 5_000,
})

export function profilesPageQuery(
	actorKey: string | null,
	input: { orgSlug: string; members?: 'all' },
) {
	// Expiry flips statuses with no event, so poll while the page is open.
	return { ...pageQuery(actorKey, input), refetchInterval: 60_000 }
}

/** Router invalidation alone reuses the cached page query, so refetch it too. */
export function useRefreshProfilesPage() {
	const router = useRouter()
	const queryClient = useQueryClient()
	return () =>
		queryClient
			.invalidateQueries({
				predicate: (query) =>
					query.queryKey[0] === 'page' &&
					query.queryKey[2] === 'loadProfilesPage',
			})
			.then(() => router.invalidate())
}
