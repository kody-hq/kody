import { getRouterInstance } from '@tanstack/react-start'
import { routeMethodRejection } from '../route-method-policy.ts'

export async function rejectUnsupportedRouteMethod(request: Request) {
	const method = request.method.toUpperCase()
	const router = await getRouterInstance()
	const [, params, route] = router.getMatchedRoutes(
		new URL(request.url).pathname,
	)
	return routeMethodRejection(
		method,
		route,
		Boolean(route && params['**'] === undefined),
	)
}
