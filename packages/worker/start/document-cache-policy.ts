import { type AnyRouter } from '@tanstack/react-router'
import { type AnonymousDocumentCachePolicy } from '../src/app/anonymous-html-cache.ts'

declare module '@tanstack/router-core' {
	interface StaticDataRouteOption {
		anonymousDocumentCache?: AnonymousDocumentCachePolicy
	}
}

export function anonymousDocumentCachePolicy(
	router: Pick<AnyRouter, 'getMatchedRoutes'>,
	pathname: string,
) {
	const [routes, params, leaf] = router.getMatchedRoutes(pathname)
	if (!leaf || params['**'] !== undefined || params.kodyId?.endsWith('.git'))
		return undefined
	return [...routes]
		.reverse()
		.find((route) => route.options.staticData?.anonymousDocumentCache)?.options
		.staticData?.anonymousDocumentCache
}
