import { createCsrfMiddleware } from '@tanstack/react-start'

/** Only externally invoked protocol POSTs bypass browser origin checks. */
export const protocolCsrf = createCsrfMiddleware({
	filter: ({ request, handlerType }) => {
		if (handlerType === 'serverFn') return false
		if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return false
		const pathname = new URL(request.url).pathname
		return !(
			pathname === '/webhooks/stripe' ||
			/^\/@[^/]+\/webhooks\/[^/]+\/[^/]+\/[^/]+$/.test(pathname) ||
			pathname === '/sentry-tunnel' ||
			pathname === '/unsubscribe/tips'
		)
	},
	secFetchSite: ['same-origin', 'none'],
	// CLI clients have no browser origin. Browser requests still require a
	// matching origin or Fetch Metadata value. RPCs use the stricter policy.
	allowRequestsWithoutOriginCheck: true,
})
