import { createMiddleware } from '@tanstack/react-start'
import { rejectActionPageHead } from './action-page-method.ts'

// Request middleware also supports redirect-only routes, which have no component
// and therefore cannot defer a method handler to the app router.
export const creditTopUpHead = createMiddleware().server(
	({ request, next }) => {
		const search = new URL(request.url).searchParams
		if (
			request.method === 'HEAD' &&
			search.get('topup') === 'success' &&
			search.get('session_id')?.trim()
		)
			return rejectActionPageHead()
		return next()
	},
)
