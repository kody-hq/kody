import { useMatchedPageScope } from './use-matched-page-scope.ts'
import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import {
	invalidatePageResources,
	type PageMutationDependencies,
} from './page-invalidation-cache.ts'
import { invalidateShellQueries } from './shell-query.ts'

export function usePageInvalidation(
	resources: PageMutationDependencies,
	{
		refreshShell = false,
		refreshRoute = false,
	}: {
		refreshShell?: boolean
		/** Token and protocol action loaders still belong to Router. */
		refreshRoute?: boolean
	} = {},
) {
	const queryClient = useQueryClient()
	const router = useRouter()
	const { actorKey, pageLocation, orgSlug } = useMatchedPageScope()
	const href = pageLocation.href
	return useCallback(async () => {
		const canRefreshRoute = () => {
			const currentContext = router.state.matches[0]?.context
			return (
				refreshRoute &&
				router.state.location.href.split('#')[0] === href.split('#')[0] &&
				currentContext != null &&
				typeof currentContext === 'object' &&
				'actorKey' in currentContext &&
				currentContext.actorKey === actorKey
			)
		}
		const refreshCurrentRoute = canRefreshRoute()
		// One owner initiates active reads. Starting both Router and Query
		// refreshes races authorization loaders and can cancel/restart GETs.
		await invalidatePageResources(
			queryClient,
			actorKey,
			resources,
			refreshCurrentRoute ? 'none' : 'active',
			orgSlug === null ? undefined : { orgSlug },
		)
		await Promise.all([
			refreshShell ? invalidateShellQueries(queryClient, actorKey) : undefined,
			refreshCurrentRoute
				? canRefreshRoute()
					? router.invalidate({
							filter: (match) => match.routeId !== '__root__',
						})
					: invalidatePageResources(
							queryClient,
							actorKey,
							resources,
							'active',
							orgSlug === null ? undefined : { orgSlug },
						)
				: undefined,
		])
	}, [
		actorKey,
		orgSlug,
		queryClient,
		router,
		resources,
		refreshShell,
		refreshRoute,
		href,
	])
}
