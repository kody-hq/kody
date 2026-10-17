import {
	type AnyRouter,
	type createMemoryHistory,
} from '@tanstack/react-router'
export const persistentShellNavSelector = '[data-account-nav], [data-docs-nav]'

type MotionGroup =
	| 'account'
	| 'admin'
	| 'docs'
	| 'onboarding'
	| 'profile'
	| 'package'
declare module '@tanstack/router-core' {
	interface StaticDataRouteOption {
		motionGroup?: MotionGroup
	}
}

/** Resolve chrome identity from the routes that own it, not URL patterns. */
export function navigationMotionGroup(
	router: Pick<AnyRouter, 'getMatchedRoutes'>,
	pathname: string,
) {
	const [routes, params, leaf] = router.getMatchedRoutes(pathname)
	if (!leaf || params['**'] !== undefined) return null
	const group = [...routes]
		.reverse()
		.find((route) => route.options.staticData?.motionGroup)?.options
		.staticData?.motionGroup
	if (group === 'profile') return `profile:${pathname}`
	if (group === 'package') {
		const { username, kodyId } = params
		return typeof username === 'string' &&
			typeof kodyId === 'string' &&
			kodyId !== '-'
			? `package:${username.toLowerCase()}/${kodyId.toLowerCase()}`
			: null
	}
	return group ?? null
}

export function shouldUseViewTransition(input: {
	from: string | null
	to: string
	fromGroup: string | null
	toGroup: string | null
	canStart: boolean
	prefersReducedMotion: boolean
	hasPersistentShell?: boolean
}) {
	if (!input.canStart || input.prefersReducedMotion || input.from === input.to)
		return false
	if (input.fromGroup && input.fromGroup === input.toGroup) return false
	if (
		input.from === null &&
		(input.toGroup === 'onboarding' ||
			(input.hasPersistentShell &&
				['account', 'admin', 'docs'].includes(input.toGroup ?? '')))
	)
		return false
	return true
}

type MotionEnvironment = {
	canStart: () => boolean
	prefersReducedMotion: () => boolean
	hasPersistentShell: () => boolean
	markSpaNavigation: () => void
}

/** Use foreground lifecycle events, covering links, history and redirects.
 * Keep the policy boolean so browsers without typed view transitions obey it. */
export function installNavigationMotion(
	router: Pick<AnyRouter, 'subscribe' | 'update' | 'getMatchedRoutes'> & {
		history: ReturnType<typeof createMemoryHistory>
	},
	environment: MotionEnvironment,
) {
	let isHistoryTraversal = false
	const stopHistory = router.history.subscribe(({ action }) => {
		isHistoryTraversal =
			action.type === 'BACK' ||
			action.type === 'FORWARD' ||
			action.type === 'GO'
	})
	const stopBefore = router.subscribe('onBeforeNavigate', (event) => {
		const from = event.fromLocation
		router.update({
			defaultViewTransition:
				!isHistoryTraversal &&
				Boolean(from) &&
				shouldUseViewTransition({
					from: from ? `${from.pathname}${from.searchStr}` : null,
					to: `${event.toLocation.pathname}${event.toLocation.searchStr}`,
					fromGroup: from ? navigationMotionGroup(router, from.pathname) : null,
					toGroup: navigationMotionGroup(router, event.toLocation.pathname),
					canStart: environment.canStart(),
					prefersReducedMotion: environment.prefersReducedMotion(),
					hasPersistentShell: environment.hasPersistentShell(),
				}),
		})
	})
	const stopMount = router.subscribe('onBeforeRouteMount', (event) => {
		const from = event.fromLocation
		const to = event.toLocation
		// Hydration, hash-only movement and focus refresh retain initial motion.
		if (
			from &&
			(from.pathname !== to.pathname || from.searchStr !== to.searchStr)
		)
			environment.markSpaNavigation()
	})
	return () => {
		stopHistory()
		stopBefore()
		stopMount()
	}
}
