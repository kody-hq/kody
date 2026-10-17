import { type QueryClient } from '@tanstack/react-query'

/** Verify the document actor before refreshing only the data currently in use. */
export async function refreshActiveQueries(
	client: QueryClient,
	actorKey: string | null,
	verify: () => Promise<unknown>,
) {
	await verify()
	await client.refetchQueries({
		type: 'active',
		predicate: (query) => {
			if (query.meta?.actorKey !== actorKey) return false
			// Recompute age at activation. A hidden tab can defer the observer's
			// stale timer, leaving its cached result.isStale behind wall-clock time.
			const stale = query.observers.some(({ options }) => {
				const enabled =
					typeof options.enabled === 'function'
						? options.enabled(query)
						: options.enabled
				const staleTime =
					typeof options.staleTime === 'function'
						? options.staleTime(query)
						: options.staleTime
				return enabled !== false && query.isStaleByTime(staleTime)
			})
			return stale || query.meta?.freshAuthorization === true
		},
	})
}
