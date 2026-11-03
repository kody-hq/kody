import type { AnyRouter } from '@tanstack/react-router'

/** Suppress repeated entrance animations after committed client navigation. */
export function installNavigationMotion(
	router: Pick<AnyRouter, 'subscribe'>,
	environment: { markSpaNavigation: () => void },
) {
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
	return stopMount
}
