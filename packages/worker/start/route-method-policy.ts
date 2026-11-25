import { mediaType } from '@kody-internal/shared/media-type.ts'

type Handlers = Record<string, unknown>
type ServerRoute = {
	path?: string
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
	const contentType = mediaType(request.headers.get('content-type'))
	return (
		accept.includes('application/json') || contentType === 'application/json'
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

/**
 * Start answers 406 to any document render whose Accept excludes HTML, before
 * it knows whether a route matched. A path with no route has no representation
 * in any type, so it is a 404. Mirrors the router's own not-found rule and
 * Start's Accept gate so HTML callers still get the not-found page.
 */
export function unknownPathRejection(
	method: string,
	route: ServerRoute | undefined,
	hasUnmatchedRemainder: boolean,
	request: Pick<Request, 'headers'>,
): Response | undefined {
	if (method !== 'GET' && method !== 'HEAD') return
	if (route && (route.path === '/' || !hasUnmatchedRemainder)) return
	const accept = request.headers.get('accept') || '*/*'
	if (/(^|,)\s*(\*\/\*|text\/html)/.test(accept)) return
	const wantsJson = requestWantsJson(request)
	const headers = new Headers({
		'Content-Type': wantsJson
			? 'application/json; charset=utf-8'
			: 'text/plain; charset=utf-8',
		'Cache-Control': 'no-store',
		Vary: 'Accept',
	})
	const body = wantsJson
		? JSON.stringify({ ok: false, error: 'Not found.' })
		: 'Not found.'
	return new Response(method === 'HEAD' ? null : body, {
		status: 404,
		headers,
	})
}
