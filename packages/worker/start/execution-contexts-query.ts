import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { createPageQuery } from './page-query.ts'
import { loadExecutionContextsPage } from '#start/server/execution-contexts'

export const executionContextsPresentationSearchKeys = ['q', 'status'] as const

export function validateExecutionContextsSearch(
	search: Record<string, unknown>,
) {
	return {
		q: typeof search.q === 'string' && search.q ? search.q : undefined,
		status:
			search.status === 'online' ||
			search.status === 'offline' ||
			search.status === 'revoked' ||
			search.status === 'not-in-chain'
				? search.status
				: undefined,
	} as {
		q?: string
		status?: 'online' | 'offline' | 'revoked' | 'not-in-chain'
	}
}

// Sharing, opt-in and chain state change independently of actor identity.
const pageQuery = createPageQuery(
	'loadExecutionContextsPage',
	loadExecutionContextsPage,
	{ freshAuthorization: true, staleTime: 5_000 },
)

export function executionContextsPageQuery(
	actorKey: string | null,
	input: { orgSlug: string; contextId?: string },
) {
	return pageQuery(actorKey, { ...input, search: [] })
}

/** Router invalidation alone reuses the cached page query, so refetch it too. */
export function useRefreshExecutionContextsPage() {
	const router = useRouter()
	const queryClient = useQueryClient()
	return () => {
		void queryClient
			.invalidateQueries({
				predicate: (query) =>
					query.queryKey[0] === 'execution-context-audit' ||
					(query.queryKey[0] === 'page' &&
						query.queryKey[2] === 'loadExecutionContextsPage'),
			})
			.then(() => router.invalidate())
	}
}
