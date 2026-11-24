import { getRouterInstance } from '@tanstack/react-start'
import { allowReplicaReads } from '../../src/d1-replica-reads.ts'
import {
	routeMethodRejection,
	unknownPathRejection,
} from '../route-method-policy.ts'

export async function rejectUnsupportedRouteMethod(request: Request) {
	const method = request.method.toUpperCase()
	const router = await getRouterInstance()
	const [, params, route] = router.getMatchedRoutes(
		new URL(request.url).pathname,
	)
	const hasUnmatchedRemainder = params['**'] !== undefined
	const rejected =
		unknownPathRejection(method, route, hasUnmatchedRemainder, request) ??
		routeMethodRejection(
			method,
			route,
			Boolean(route && !hasUnmatchedRemainder),
			request,
		)
	// A page with its own server handler may act on what it reads (token
	// links, OAuth callbacks), so only plain pages read from a replica.
	if (
		!rejected &&
		route &&
		!hasUnmatchedRemainder &&
		!route.options.server?.handlers
	)
		allowReplicaReads(request)
	return rejected
}
