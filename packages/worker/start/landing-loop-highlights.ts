import { type QueryClient } from '@tanstack/react-query'
import { loadLandingLoopHighlights } from '#start/server/landing-loop-highlights'
export async function fetchLandingLoopHighlights(queryClient: QueryClient) {
	try {
		return await queryClient.ensureQueryData({
			queryKey: ['landing-loop-highlights'],
			queryFn: ({ signal }) => loadLandingLoopHighlights({ signal }),
			staleTime: Infinity,
		})
	} catch {
		return {}
	}
}
