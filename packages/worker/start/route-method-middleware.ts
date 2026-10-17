import { createMiddleware } from '@tanstack/react-start'

// Route middleware runs after Start creates its request-scoped router context.
// Global request middleware runs before that context exists.
export const routeMethods = createMiddleware().server(
	async ({ request, next }) => {
		const { rejectUnsupportedRouteMethod } =
			await import('#start/server/route-method-policy')
		const rejected = await rejectUnsupportedRouteMethod(request)
		return rejected ?? next()
	},
)
