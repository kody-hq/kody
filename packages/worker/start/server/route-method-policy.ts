import { getRouterInstance } from '@tanstack/react-start'
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
	return (
		unknownPathRejection(method, route, hasUnmatchedRemainder, request) ??
		routeMethodRejection(
			method,
			route,
			Boolean(route && !hasUnmatchedRemainder),
			request,
		)
	)
}
