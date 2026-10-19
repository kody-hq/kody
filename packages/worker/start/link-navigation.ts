import { type AnyRouter } from '@tanstack/react-router'

declare module '@tanstack/router-core' {
	interface StaticDataRouteOption {
		/** A browser document is required to complete this protocol handshake. */
		documentNavigation?: true
	}
}

export function linkNavigation(
	router: Pick<AnyRouter, 'getMatchedRoutes'>,
	pathname: string,
) {
	const [matches, params, route] = router.getMatchedRoutes(pathname)
	const exact = Boolean(route && params['**'] === undefined)
	const redirectOnly =
		exact &&
		Boolean(route?.options.beforeLoad) &&
		!route?.options.component &&
		!route?.options.loader
	return {
		preload: route?.options.preload,
		reloadDocument:
			!exact ||
			matches.some((match) => match.options.staticData?.documentNavigation) ||
			Boolean(route?.options.server?.handlers && !route.options.component) ||
			redirectOnly,
	}
}
