import { type AnyRouter } from '@tanstack/react-router'

declare module '@tanstack/router-core' {
	interface StaticDataRouteOption {
		/**
		 * Links here load a browser document: protocol handshakes and
		 * server-only resources (.md, .txt, .xml, images, redirects). Start
		 * prunes routes whose only option is `server` from the client route
		 * tree, so server-only routes declare this to stay matchable there.
		 */
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
			redirectOnly,
	}
}
