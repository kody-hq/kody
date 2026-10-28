import {
	parseApiToken,
	readBearerApiToken,
} from '@kody-internal/shared/api-token-format.ts'
import {
	ecpRunHeader,
	ecpSignatureHeader,
} from '@kody-internal/shared/execution-context-protocol/index.ts'

/**
 * Edge half of `api.kody.codes`. Everything here runs before the request
 * reaches origin: CORS, rate limits, header stripping, and the body cap.
 * Authentication and the operation itself run in origin's `KodyApi`
 * entrypoint (`packages/worker/src/open-api/`), next to D1.
 */

export type ApiWorkerEnv = {
	KODY_API: Fetcher
	API_IP_RATE_LIMITER?: RateLimit
	API_TOKEN_RATE_LIMITER?: RateLimit
	APP_COMMIT_SHA?: string
}

/** Matches `maxApiRequestBodyBytes` in origin's open-api request parsing. */
export const maxApiRequestBodyBytes = 5 * 1024 * 1024

/**
 * Cloudflare Worker request upload limit on Free/Pro. Matches origin's
 * `maxGatewayFetchUploadBytes` for `POST /v1/capability-proxy/gateway-fetch`.
 */
export const maxGatewayFetchUploadBytes = 100 * 1024 * 1024

export const capabilityProxyGatewayFetchPath =
	'/v1/capability-proxy/gateway-fetch'

const forwardedPathPattern = /^\/(?:|openapi\.json|v1(?:\/.*)?)$/
const allowedMethods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']
const bodyMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const gatewayFetchForwardHeaderNames = [
	'X-Kody-Gateway-Url',
	'X-Kody-Gateway-Method',
	'X-Kody-Gateway-Package-Id',
	'X-Kody-Gateway-Headers',
	'x-kody-secret-resolution',
	'Content-Length',
	'Transfer-Encoding',
] as const

const corsAllowHeaders = [
	'Authorization',
	'Content-Type',
	'If-None-Match',
	'X-Kody-Gateway-Url',
	'X-Kody-Gateway-Method',
	'X-Kody-Gateway-Package-Id',
	'X-Kody-Gateway-Headers',
	'x-kody-secret-resolution',
].join(', ')

/** Static policy advertisement (CF RateLimit binding does not expose remaining). */
export const apiEdgeRateLimitPolicy = 'ip;q=600;w=60, token;q=300;w=60'

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Expose-Headers':
		'WWW-Authenticate, Retry-After, RateLimit-Policy, Allow, ETag, X-Kody-Request-Id',
} as const

const corsPreflightHeaders = {
	...corsHeaders,
	'Access-Control-Allow-Methods': allowedMethods.join(', '),
	'Access-Control-Allow-Headers': corsAllowHeaders,
	'Access-Control-Max-Age': '600',
} as const

function errorResponse(
	status: number,
	code: string,
	message: string,
	headers: Record<string, string> = {},
) {
	return withEdgeHeaders(
		Response.json(
			{ error: { code, message } },
			{ status, headers: { 'Cache-Control': 'no-store', ...headers } },
		),
	)
}

function withEdgeHeaders(response: Response) {
	const headers = new Headers(response.headers)
	for (const [name, value] of Object.entries(corsHeaders)) {
		headers.set(name, value)
	}
	headers.set('X-Content-Type-Options', 'nosniff')
	headers.delete('Set-Cookie')
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

function isCapabilityProxyGatewayFetchRequest(
	method: string,
	pathname: string,
) {
	return method === 'POST' && pathname === capabilityProxyGatewayFetchPath
}

export function gatewayFetchDeclaredBodyExceedsUploadLimit(headers: Headers) {
	const declared = Number(headers.get('Content-Length') ?? '0')
	return Number.isFinite(declared) && declared > maxGatewayFetchUploadBytes
}

export function gatewayFetchUploadLimitMessage() {
	return `Request body exceeds the Worker upload limit of ${maxGatewayFetchUploadBytes} bytes (100 MiB).`
}

/**
 * Only the API credential (a bearer token or a signed execution context
 * request), content negotiation and cache validators reach origin. Cookies
 * never authenticate the API, and `X-Kody-*` headers are internal fleet
 * signals a public caller must not be able to set. Gateway-fetch also
 * forwards the allowlisted hop metadata headers.
 */
function buildForwardHeaders(
	headers: Headers,
	extraNames: ReadonlyArray<string> = [],
) {
	const forwarded = new Headers()
	for (const name of [
		'Authorization',
		ecpSignatureHeader,
		ecpRunHeader,
		'Content-Type',
		'Accept',
		'If-None-Match',
		'User-Agent',
		'CF-Connecting-IP',
		...extraNames,
	]) {
		const value = headers.get(name)
		if (value !== null) forwarded.set(name, value)
	}
	return forwarded
}

async function readCappedBody(request: Request) {
	const declared = Number(request.headers.get('Content-Length') ?? '0')
	if (declared > maxApiRequestBodyBytes) return null
	if (!request.body) return new Uint8Array(0)
	const reader = request.body.getReader()
	const chunks: Array<Uint8Array> = []
	let total = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		total += value.byteLength
		if (total > maxApiRequestBodyBytes) {
			await reader.cancel()
			return null
		}
		chunks.push(value)
	}
	const body = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		body.set(chunk, offset)
		offset += chunk.byteLength
	}
	return body
}

async function isRateLimited(limiter: RateLimit | undefined, key: string) {
	if (!limiter) return false
	try {
		const { success } = await limiter.limit({ key })
		return !success
	} catch (error) {
		console.warn('api-worker-rate-limit-failed', error)
		return false
	}
}

/**
 * Per-credential rate-limit key. `kody_at_` tokens use the public id (never
 * the secret). Opaque bearers (CLI MCP OAuth) are hashed so the limiter can
 * still key per credential without storing the token value.
 */
async function credentialRateLimitKey(authorization: string | null) {
	const bearer = readBearerApiToken(authorization)
	if (!bearer) return null
	const parsed = parseApiToken(bearer)
	if (parsed) return `token:${parsed.tokenId}`
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(bearer),
	)
	const hex = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0'),
	)
		.join('')
		.slice(0, 32)
	return `bearer:${hex}`
}

async function rateLimitKeys(request: Request) {
	const ip = request.headers.get('CF-Connecting-IP')
	return {
		ip: ip ? `ip:${ip}` : null,
		token: await credentialRateLimitKey(request.headers.get('Authorization')),
	}
}

/** Response header that names one API request, for support and logs. */
export const apiRequestIdHeader = 'X-Kody-Request-Id'

/**
 * Cloudflare's ray id when present (it also keys the Workers logs for this
 * request), otherwise a random id.
 */
function readRequestId(request: Request) {
	return request.headers.get('CF-Ray')?.trim() || crypto.randomUUID()
}

export async function handleApiEdgeRequest(
	request: Request,
	env: ApiWorkerEnv,
): Promise<Response> {
	const requestId = readRequestId(request)
	const response = await routeApiEdgeRequest(request, env, requestId)
	// A 101 WebSocket upgrade from origin passes through untouched.
	if (response.status === 101) return response
	response.headers.set(apiRequestIdHeader, requestId)
	return response
}

async function routeApiEdgeRequest(
	request: Request,
	env: ApiWorkerEnv,
	requestId: string,
): Promise<Response> {
	const url = new URL(request.url)
	if (url.pathname === '/health') {
		return withEdgeHeaders(
			Response.json(
				{ ok: true, commit: env.APP_COMMIT_SHA ?? null },
				{ headers: { 'Cache-Control': 'no-store' } },
			),
		)
	}
	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: corsPreflightHeaders })
	}
	if (!forwardedPathPattern.test(url.pathname)) {
		return errorResponse(
			404,
			'not_found',
			`No route for ${url.pathname}. See /openapi.json.`,
		)
	}
	if (!allowedMethods.includes(request.method)) {
		return errorResponse(
			405,
			'method_not_allowed',
			`Method ${request.method} is not allowed.`,
			{ Allow: allowedMethods.join(', ') },
		)
	}

	if (isExecutionContextConnectRequest(request, url.pathname)) {
		return forwardExecutionContextConnect({ request, env, url, requestId })
	}

	const keys = await rateLimitKeys(request)
	if (
		(keys.ip && (await isRateLimited(env.API_IP_RATE_LIMITER, keys.ip))) ||
		(keys.token &&
			(await isRateLimited(env.API_TOKEN_RATE_LIMITER, keys.token)))
	) {
		return errorResponse(
			429,
			'rate_limited',
			'Too many requests. Retry after a minute.',
			{
				'Retry-After': '60',
				'RateLimit-Policy': apiEdgeRateLimitPolicy,
			},
		)
	}

	if (isCapabilityProxyGatewayFetchRequest(request.method, url.pathname)) {
		if (gatewayFetchDeclaredBodyExceedsUploadLimit(request.headers)) {
			return errorResponse(
				413,
				'payload_too_large',
				gatewayFetchUploadLimitMessage(),
			)
		}
		const requestInit: RequestInit & { duplex?: 'half' } = {
			method: request.method,
			headers: buildForwardHeaders(
				request.headers,
				gatewayFetchForwardHeaderNames,
			),
		}
		if (request.body) {
			requestInit.body = request.body
			requestInit.duplex = 'half'
		}
		return fetchOrigin(env, new Request(url.toString(), requestInit), requestId)
	}

	let body: Uint8Array<ArrayBuffer> | undefined
	if (bodyMethods.has(request.method)) {
		const capped = await readCappedBody(request)
		if (!capped) {
			return errorResponse(
				413,
				'payload_too_large',
				`Request body exceeds ${maxApiRequestBodyBytes} bytes.`,
			)
		}
		body = capped
	}

	const forwarded = new Request(url.toString(), {
		method: request.method,
		headers: buildForwardHeaders(request.headers),
		...(body && body.byteLength > 0 ? { body } : {}),
	})
	return fetchOrigin(env, forwarded, requestId)
}

/**
 * Cloudflare rejects the origin call with one of these when the origin
 * invocation ran past its memory or CPU limit. Retrying the same request
 * usually fails the same way, so say so instead of "temporarily unavailable".
 */
const originResourceLimitPattern =
	/exceeded (?:its )?(?:memory|cpu)|memory limit|cpu time limit|resource limits?/i

export function describeOriginForwardFailure(
	error: unknown,
	requestId: string,
) {
	const detail = error instanceof Error ? error.message : String(error)
	if (originResourceLimitPattern.test(detail)) {
		return {
			reason: 'origin_resource_limit' as const,
			message: `The Kody API ran out of server memory or CPU time before it answered this request (request id ${requestId}). This is a server limit, not a login or network problem; retrying the same request usually fails the same way. Quote the request id when you report it.`,
		}
	}
	return {
		reason: 'origin_unreachable' as const,
		message: `The Kody API is temporarily unavailable (request id ${requestId}). Retry in a few seconds; if it keeps failing, quote the request id when you report it.`,
	}
}

export const executionContextConnectPath = '/v1/execution-contexts/connect'

const executionContextConnectHeaderNames = [
	'Upgrade',
	'Connection',
	'Sec-WebSocket-Key',
	'Sec-WebSocket-Version',
	'Sec-WebSocket-Protocol',
	'Sec-WebSocket-Extensions',
] as const

function isExecutionContextConnectRequest(request: Request, pathname: string) {
	return (
		request.method === 'GET' &&
		pathname === executionContextConnectPath &&
		request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
	)
}

/**
 * Daemon WebSocket connect: forwards the upgrade to origin and returns its
 * response as is. Rate limited per context and IP. The `ticket` query
 * param is a bearer secret, so it is never logged here.
 */
async function forwardExecutionContextConnect(input: {
	request: Request
	env: ApiWorkerEnv
	url: URL
	requestId: string
}) {
	const { request, env, url, requestId } = input
	const ecid = (url.searchParams.get('ticket') ?? '').split('.')[0] ?? ''
	const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
	if (
		await isRateLimited(env.API_IP_RATE_LIMITER, `ecp-connect:${ecid}:${ip}`)
	) {
		return errorResponse(
			429,
			'rate_limited',
			'Too many connect attempts. Back off and retry.',
			{ 'Retry-After': '60' },
		)
	}
	const forwarded = new Request(url.toString(), {
		method: 'GET',
		headers: buildForwardHeaders(
			request.headers,
			executionContextConnectHeaderNames,
		),
	})
	try {
		return await env.KODY_API.fetch(forwarded)
	} catch (error) {
		console.error('api-worker-ecp-connect-failed', error, {
			requestId,
			path: url.pathname,
		})
		return errorResponse(
			503,
			'internal_error',
			'Kody could not reach its API origin. Retry in a few seconds.',
			{ 'Retry-After': '5' },
		)
	}
}

async function fetchOrigin(
	env: ApiWorkerEnv,
	forwarded: Request,
	requestId: string,
) {
	try {
		return withEdgeHeaders(await env.KODY_API.fetch(forwarded))
	} catch (error) {
		const failure = describeOriginForwardFailure(error, requestId)
		console.error('api-worker-forward-failed', error, {
			requestId,
			reason: failure.reason,
			path: new URL(forwarded.url).pathname,
		})
		return withEdgeHeaders(
			Response.json(
				{
					error: {
						code: 'internal_error',
						message: failure.message,
						details: { reason: failure.reason, request_id: requestId },
					},
				},
				{
					status: 503,
					// A resource-limit failure usually repeats, so do not invite an
					// automatic retry of the same request.
					headers: {
						'Cache-Control': 'no-store',
						...(failure.reason === 'origin_unreachable'
							? { 'Retry-After': '5' }
							: {}),
					},
				},
			),
		)
	}
}
