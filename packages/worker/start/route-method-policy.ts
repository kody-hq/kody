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

function requestWantsJson(request?: Pick<Request, 'headers'>) {
	if (!request) return false
	const accept = request.headers.get('accept')?.toLowerCase() ?? ''
	const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
	return (
		accept.includes('application/json') ||
		contentType.includes('application/json')
	)
}

/** Use the matched Start route's declared protocol methods, not a second URL table. */
export function routeMethodRejection(
	method: string,
	route: ServerRoute | undefined,
	exact: boolean,
	request?: Pick<Request, 'headers'>,
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
	const headers = new Headers({ Allow: allowed.join(', ') })
	// Sibling retired `/account/*.json` companions fuzzy-match document routes.
	// JSON callers must get a JSON body, never an empty 405 that breaks `.json()`.
	if (requestWantsJson(request)) {
		headers.set('Content-Type', 'application/json; charset=utf-8')
		headers.set('Cache-Control', 'no-store')
		return new Response(
			JSON.stringify({ ok: false, error: 'Method not allowed.' }),
			{ status: 405, headers },
		)
	}
	return new Response(null, {
		status: 405,
		headers,
	})
}
