type Handlers = Record<string, unknown>
type ServerRoute = {
	options: {
		component?: unknown
		server?: {
			handlers?:
				| Handlers
				| ((helpers: {
						createHandlers: (handlers: Handlers) => Handlers
				  }) => Handlers)
		}
	}
}

/** Use the matched Start route's declared protocol methods, not a second URL table. */
export function routeMethodRejection(
	method: string,
	route: ServerRoute | undefined,
	exact: boolean,
): Response | undefined {
	const configured = exact ? route?.options.server?.handlers : undefined
	const handlers =
		typeof configured === 'function'
			? configured({ createHandlers: (handlers) => handlers })
			: configured
	if (
		handlers?.[method] ||
		handlers?.ANY ||
		(method === 'HEAD' && handlers?.GET)
	)
		return
	if (
		(method === 'GET' || method === 'HEAD') &&
		(!handlers || route?.options.component)
	)
		return
	const allowed = handlers
		? Object.keys(handlers).filter((method) => method !== 'ANY')
		: ['GET', 'HEAD']
	if (allowed.includes('GET') && !allowed.includes('HEAD')) allowed.push('HEAD')
	return new Response(null, {
		status: 405,
		headers: { Allow: allowed.join(', ') },
	})
}
