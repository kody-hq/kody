import {
	type Agent as HttpAgent,
	type IncomingMessage,
	type request as httpRequest,
} from 'node:http'
import { type Socket } from 'node:net'
import { Readable } from 'node:stream'
import {
	capabilityProxyForbiddenMessage,
	currentStoredTokenLifetimeAlias,
	featureDisabledMessage,
	insufficientScopeMessage,
	readInsufficientScopeDetails,
	isScopedApiToken,
	rejectedApiTokenMessage,
	rejectedOauthBearerMessage,
} from './api-token.js'
import {
	formatCredentialClientError,
	type CredentialCallMapInput,
} from './credential-call-map.js'
import { cliName } from './defaults.js'
import {
	formatUnreachableApiMessage,
	requestSentStatus,
	type RequestSentStatus,
} from './network-error.js'
import { readPackageVersion } from './package-info.js'

/**
 * HTTP contract for Kody's CapabilityProxy (Open API `/v1`). Local execute
 * runs user code in workerd and forwards every `kody:runtime` call here with
 * a Bearer from `--token` / `KODY_API_TOKEN` or (when unset) `kody login`
 * OAuth access token.
 *
 * - `GET  /v1/capability-proxy/session` validates the token up front for
 *   token-only cloud execute (and local `--credential` feature detection).
 *   200 → `{ scopes?: string[], expiresAt?: string, features?: string[] }`.
 *   Ordinary local execute skips it: `POST /v1/local-execute/package-graph`
 *   runs the same authentication and `org:execute` authorization and is needed
 *   anyway.
 * - `POST /v1/capability-proxy/call` with
 *   `{ path, args, conversationId?, credentials? }` where `path` is the runtime
 *   property path (`['kody', 'emailSend']`, `['kody', 'mcp', server, tool]`,
 *   `['workflows', 'create']`) and `args` is the positional argument list.
 *   `credentials` is the ADR 0068 call map (CLI `--credential`); local code
 *   controls only `args`, so it cannot pick by name. 200 → `{ result }`.
 *
 * Errors use `{ error: { code, message } }` (a bare string is accepted too).
 * 401 means the token is expired/revoked (or MCP OAuth until the platform
 * accepts it); 403 `feature_disabled` means the `local-execute` flag is off.
 */
export const capabilityProxySessionPath = 'v1/capability-proxy/session'
export const capabilityProxyCallPath = 'v1/capability-proxy/call'
/** Streaming ambient/secret fetch hop (raw body; not JSON `/call`). */
export const capabilityProxyGatewayFetchPath =
	'v1/capability-proxy/gateway-fetch'

/** Allowlisted metadata headers for {@link capabilityProxyGatewayFetchPath}. */
export const gatewayFetchUrlHeaderName = 'X-Kody-Gateway-Url'
export const gatewayFetchMethodHeaderName = 'X-Kody-Gateway-Method'
export const gatewayFetchPackageIdHeaderName = 'X-Kody-Gateway-Package-Id'
export const gatewayFetchHeadersHeaderName = 'X-Kody-Gateway-Headers'
export const secretResolutionHeaderName = 'x-kody-secret-resolution'

/**
 * Origin runs a placeholder `fetch` under a 5-minute deadline that starts only
 * after quota checks and placeholder fill, buffers the whole upstream body,
 * and sends headers once that body has ended. Node's global fetch gives up
 * after 300s without headers and that limit cannot be raised without the
 * undici package, so CapabilityProxy requests go through Node's own HTTP
 * client (`node:http` / `node:https`) with an idle timeout that outlasts the
 * deadline plus origin overhead.
 */
export const capabilityProxyGatewayDeadlineMs = 5 * 60_000
export const capabilityProxyHttpTimeoutMs = 7 * 60_000
/** Bound DNS / TCP / TLS before the idle timer (undici Agent default was 10s). */
export const capabilityProxyConnectTimeoutMs = 10_000

/**
 * Node routes global fetch through `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`
 * only when `NODE_USE_ENV_PROXY=1` or `--use-env-proxy` is set. The
 * CapabilityProxy agents mirror the same opt-in through the Agent `proxyEnv`
 * option.
 */
export function nodeUsesEnvProxy(
	env: NodeJS.ProcessEnv = process.env,
	execArgv: ReadonlyArray<string> = process.execArgv,
): boolean {
	if (env.NODE_USE_ENV_PROXY === '1') return true
	const flags = [...execArgv, ...(env.NODE_OPTIONS ?? '').split(/\s+/)]
	return flags.includes('--use-env-proxy')
}

/** `http.Agent({ proxyEnv })` exists from these releases; older Node ignores the option. */
const envProxyAgentMinimumNode: Record<number, number> = { 22: 21, 24: 5 }

export function nodeAgentHonorsEnvProxy(
	version: string = process.versions.node,
): boolean {
	const [major = 0, minor = 0] = version.split('.').map(Number)
	const minimumMinor = envProxyAgentMinimumNode[major]
	if (minimumMinor === undefined) return major > 24
	return minor >= minimumMinor
}

export type CapabilityProxyFetchOptions = {
	/** Idle limit while waiting for headers or between body chunks. */
	timeoutMs?: number
	/** Bound for DNS / TCP / TLS before the socket is ready. */
	connectTimeoutMs?: number
	useEnvProxy?: boolean
}

/**
 * fetch-shaped sender for CapabilityProxy built on `node:http(s)`: keep-alive
 * across the session, package-graph and proxied calls, `timeoutMs` as the
 * only idle limit, and `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` when Node's
 * env-proxy opt-in is set. Bodies are strings; responses are buffered.
 */
export function createCapabilityProxyFetch(
	options: CapabilityProxyFetchOptions = {},
): typeof fetch {
	const timeoutMs = options.timeoutMs ?? capabilityProxyHttpTimeoutMs
	const connectTimeoutMs =
		options.connectTimeoutMs ?? capabilityProxyConnectTimeoutMs
	const useEnvProxy = options.useEnvProxy ?? nodeUsesEnvProxy()
	if (useEnvProxy && !nodeAgentHonorsEnvProxy()) {
		throw new Error(
			`Node ${process.version} cannot route CapabilityProxy requests through HTTP_PROXY / HTTPS_PROXY: env-proxy support needs Node 22.21 or 24.5 and later. Upgrade Node or unset NODE_USE_ENV_PROXY / --use-env-proxy.`,
		)
	}
	let transports: Promise<Transports> | null = null
	return async (input, init = {}) => {
		const url =
			input instanceof URL
				? input
				: new URL(input instanceof Request ? input.url : input)
		// node:http and node:https cost ~7ms to load, so only commands that send a request pay for it.
		transports ??= loadTransports(useEnvProxy)
		const transport = (await transports)[url.protocol as keyof Transports]
		if (!transport) {
			throw new TypeError(
				`Unsupported protocol for the Kody API: ${url.protocol}`,
			)
		}
		const body = init.body
		if (body !== undefined && body !== null && typeof body !== 'string') {
			throw new TypeError('CapabilityProxy requests send string bodies.')
		}
		return new Promise<Response>((resolve, reject) => {
			const request = transport.request(
				url,
				{
					agent: transport.agent,
					method: init.method ?? 'GET',
					headers: Object.fromEntries(new Headers(init.headers)),
				},
				(response) => {
					clearTimeout(connectTimer)
					const chunks: Array<Buffer> = []
					response.on('data', (chunk: Buffer) => chunks.push(chunk))
					response.on('error', reject)
					response.on('end', () =>
						resolve(toResponse(response, Buffer.concat(chunks))),
					)
				},
			)
			// request.setTimeout only arms after the socket is connected; bound DNS/TCP/TLS separately.
			const connectTimer = setTimeout(() => {
				request.destroy(
					new Error(
						`Kody API did not connect within ${connectTimeoutMs}ms (${url.pathname}).`,
					),
				)
			}, connectTimeoutMs)
			request.on('socket', (socket) => {
				const clearConnectTimer = () => clearTimeout(connectTimer)
				if (url.protocol === 'https:') {
					// `encrypted` is always true on TLSSocket; secureConnecting is the
					// handshake flag (not always in @types/node). Keep-alive reuse skips
					// secureConnect.
					if (tlsHandshakePending(socket) === false) {
						clearConnectTimer()
						return
					}
					socket.once('secureConnect', clearConnectTimer)
					return
				}
				if (!socket.connecting) {
					clearConnectTimer()
					return
				}
				socket.once('connect', clearConnectTimer)
			})
			request.setTimeout(timeoutMs, () =>
				request.destroy(
					new Error(
						`Kody API sent nothing for ${timeoutMs}ms (${url.pathname}).`,
					),
				),
			)
			request.on('error', (error) => {
				clearTimeout(connectTimer)
				reject(error)
			})
			const { signal } = init
			if (signal) {
				const abort = () => {
					clearTimeout(connectTimer)
					request.destroy(abortError(signal.reason))
				}
				if (signal.aborted) {
					abort()
				} else {
					signal.addEventListener('abort', abort, { once: true })
					request.once('close', () =>
						signal.removeEventListener('abort', abort),
					)
				}
			}
			request.end(body ?? undefined)
		})
	}
}

type Transport = { agent: HttpAgent; request: typeof httpRequest }
type Transports = { 'http:': Transport; 'https:': Transport }

async function loadTransports(useEnvProxy: boolean): Promise<Transports> {
	const [http, https] = await Promise.all([
		import('node:http'),
		import('node:https'),
	])
	const agentOptions = {
		keepAlive: true,
		...(useEnvProxy ? { proxyEnv: process.env } : {}),
	}
	return {
		'http:': {
			agent: unrefFreeSockets(new http.Agent(agentOptions)),
			request: http.request,
		},
		'https:': {
			agent: unrefFreeSockets(new https.Agent(agentOptions)),
			request: https.request,
		},
	}
}

/** Keep-alive free sockets must not pin the event loop after the last request. */
function unrefFreeSockets(agent: HttpAgent): HttpAgent {
	agent.on('free', (socket) => {
		socket.unref()
	})
	return agent
}

/** `true` while TLS handshake is in progress; `false` once established; else unknown. */
function tlsHandshakePending(socket: Socket): boolean | null {
	if (!('secureConnecting' in socket)) return null
	return (socket as Socket & { secureConnecting: boolean }).secureConnecting
}

function abortError(reason: unknown): Error {
	if (reason instanceof Error) return reason
	return new DOMException(
		typeof reason === 'string' ? reason : 'This operation was aborted',
		'AbortError',
	)
}

function toResponse(response: IncomingMessage, body: Buffer): Response {
	const headers = new Headers()
	for (const [name, value] of Object.entries(response.headers)) {
		if (Array.isArray(value)) {
			for (const entry of value) headers.append(name, entry)
		} else if (value !== undefined) {
			headers.set(name, value)
		}
	}
	const status = response.statusCode ?? 0
	const bodyless = status === 204 || status === 205 || status === 304
	return new Response(bodyless ? null : body, {
		status,
		statusText: response.statusMessage ?? '',
		headers,
	})
}

let defaultCapabilityProxyFetch: typeof fetch | null = null

function capabilityProxyFetch(): typeof fetch {
	defaultCapabilityProxyFetch ??= createCapabilityProxyFetch()
	return defaultCapabilityProxyFetch
}

export type CapabilityProxySession = {
	scopes: Array<string>
	expiresAt: string | null
	/** Host features, e.g. `credential-call-map` for `--credential`. */
	features: Array<string>
}

export type CapabilityProxyCall = {
	path: Array<string>
	args: Array<unknown>
	conversationId?: string
	/** ADR 0068 call map; top-level only (never nested under `args`). */
	credentials?: CredentialCallMapInput
}

export type CapabilityProxyClientInput = {
	apiUrl: string
	token: string
	/** Defaults to the shared `createCapabilityProxyFetch()` sender. */
	fetchFn?: typeof fetch
	signal?: AbortSignal
	/**
	 * User-owned API token org selection (ADR 0070). Appended as `?org=<slug>`
	 * on CapabilityProxy / package-graph requests.
	 */
	org?: string
}

export class CapabilityProxyError extends Error {
	readonly status: number | null
	readonly code: string | null
	/**
	 * Set when the hop failed before an HTTP response. `false` = connect
	 * phase (nothing sent); `"unknown"` = body may have reached the server.
	 */
	readonly sent?: RequestSentStatus

	constructor(
		message: string,
		options: {
			status?: number | null
			code?: string | null
			sent?: RequestSentStatus
		} = {},
	) {
		super(message)
		this.name = 'CapabilityProxyError'
		this.status = options.status ?? null
		this.code = options.code ?? null
		if (options.sent !== undefined) this.sent = options.sent
	}
}

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The bearer token must not cross the network in cleartext. */
export function assertTokenSafeApiUrl(apiUrl: string): void {
	let url: URL
	try {
		url = new URL(apiUrl)
	} catch {
		throw new Error(`Invalid Kody API URL: ${apiUrl}`)
	}
	if (url.protocol === 'https:') return
	if (url.protocol === 'http:' && loopbackHosts.has(url.hostname)) return
	throw new Error(
		`Refusing to send the API token to ${url.origin}: use https (plain http is only allowed for localhost).`,
	)
}

export function capabilityProxyUrl(apiUrl: string, path: string): URL {
	const base = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`
	return new URL(path, base)
}

/** Attach `?org=` for user-owned tokens without clobbering other query params. */
export function withOrgQuery(url: URL, org?: string): URL {
	if (org) url.searchParams.set('org', org)
	return url
}

export async function openCapabilityProxySession(
	input: CapabilityProxyClientInput,
): Promise<CapabilityProxySession> {
	const url = withOrgQuery(
		capabilityProxyUrl(input.apiUrl, capabilityProxySessionPath),
		input.org,
	)
	const response = await send(input, url, { method: 'GET' })
	const body = await readJson(response)
	if (!response.ok) {
		throw describeFailure(response.status, body, url, 'session', input.token)
	}
	const record = isRecord(body) ? body : {}
	return {
		scopes: Array.isArray(record.scopes)
			? record.scopes.filter(
					(scope): scope is string => typeof scope === 'string',
				)
			: [],
		expiresAt: typeof record.expiresAt === 'string' ? record.expiresAt : null,
		features: Array.isArray(record.features)
			? record.features.filter(
					(feature): feature is string => typeof feature === 'string',
				)
			: [],
	}
}

export async function callCapabilityProxy(
	input: CapabilityProxyClientInput & CapabilityProxyCall,
): Promise<unknown> {
	const url = withOrgQuery(
		capabilityProxyUrl(input.apiUrl, capabilityProxyCallPath),
		input.org,
	)
	const payload: CapabilityProxyCall = { path: input.path, args: input.args }
	if (input.conversationId !== undefined)
		payload.conversationId = input.conversationId
	if (input.credentials !== undefined) payload.credentials = input.credentials
	const response = await send(input, url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
	})
	const body = await readJson(response)
	if (!response.ok) {
		throw describeFailure(response.status, body, url, 'call', input.token)
	}
	const failure = readErrorBody(body)
	if (failure) {
		throw new CapabilityProxyError(failure.message, {
			status: response.status,
			code: failure.code,
		})
	}
	return isRecord(body) ? body.result : undefined
}

export type CapabilityProxyGatewayFetchStreamHeaders = {
	url: string
	method?: string
	packageId?: string
	/** Outbound header name → string (may include secret placeholders). */
	headers?: Record<string, string>
	/** Outbound `Content-Type` (set on the Open API request). */
	contentType?: string | null
	/** `on` | `headers-only` | `off`. */
	secretResolution?: string | null
}

/**
 * Streaming CapabilityProxy hop: `POST /v1/capability-proxy/gateway-fetch`.
 * The Open API body is the outbound fetch body (no JSON/base64 wrapper).
 * Returns the upstream `Response` (or an Open API JSON error envelope).
 *
 * Uses Node `http(s)` so duplex streaming works with the same 7-minute idle
 * timeout as JSON CapabilityProxy calls (undici's global fetch caps at 300s).
 */
export async function callCapabilityProxyGatewayFetchStream(
	input: CapabilityProxyClientInput & {
		gateway: CapabilityProxyGatewayFetchStreamHeaders
		/** Raw outbound body stream (may be empty for GET/HEAD). */
		body: IncomingMessage | Readable | null
		contentLength?: string | null
	},
): Promise<Response> {
	assertTokenSafeApiUrl(input.apiUrl)
	const url = withOrgQuery(
		capabilityProxyUrl(input.apiUrl, capabilityProxyGatewayFetchPath),
		input.org,
	)
	const timeoutMs = capabilityProxyHttpTimeoutMs
	const connectTimeoutMs = capabilityProxyConnectTimeoutMs
	const useEnvProxy = nodeUsesEnvProxy()
	if (useEnvProxy && !nodeAgentHonorsEnvProxy()) {
		throw new Error(
			`Node ${process.version} cannot route CapabilityProxy requests through HTTP_PROXY / HTTPS_PROXY: env-proxy support needs Node 22.21 or 24.5 and later. Upgrade Node or unset NODE_USE_ENV_PROXY / --use-env-proxy.`,
		)
	}
	const transports = await loadTransports(useEnvProxy)
	const transport = transports[url.protocol as keyof Transports]
	if (!transport) {
		throw new TypeError(
			`Unsupported protocol for the Kody API: ${url.protocol}`,
		)
	}
	const headers: Record<string, string | number | Array<string>> = {
		accept: '*/*',
		authorization: `Bearer ${input.token}`,
		'user-agent': `${cliName}/${readPackageVersion()}`,
		[gatewayFetchUrlHeaderName]: input.gateway.url,
	}
	if (input.gateway.method) {
		headers[gatewayFetchMethodHeaderName] = input.gateway.method
	}
	if (input.gateway.packageId) {
		headers[gatewayFetchPackageIdHeaderName] = input.gateway.packageId
	}
	if (input.gateway.headers && Object.keys(input.gateway.headers).length > 0) {
		headers[gatewayFetchHeadersHeaderName] = JSON.stringify(
			input.gateway.headers,
		)
	}
	if (input.gateway.secretResolution) {
		headers[secretResolutionHeaderName] = input.gateway.secretResolution
	}
	if (input.gateway.contentType) {
		headers['content-type'] = input.gateway.contentType
	}
	if (input.contentLength) {
		headers['content-length'] = input.contentLength
	}
	const signal = input.signal
	return await new Promise<Response>((resolve, reject) => {
		const request = transport.request(
			url,
			{
				agent: transport.agent,
				method: 'POST',
				headers,
			},
			(response) => {
				clearTimeout(connectTimer)
				resolve(nodeIncomingToWebResponse(response))
			},
		)
		const connectTimer = setTimeout(() => {
			request.destroy(
				new Error(
					`Kody API did not connect within ${connectTimeoutMs}ms (${url.pathname}).`,
				),
			)
		}, connectTimeoutMs)
		request.on('socket', (socket) => {
			const clearConnectTimer = () => clearTimeout(connectTimer)
			if (url.protocol === 'https:') {
				if (tlsHandshakePending(socket) === false) {
					clearConnectTimer()
					return
				}
				socket.once('secureConnect', clearConnectTimer)
				return
			}
			if (!socket.connecting) {
				clearConnectTimer()
				return
			}
			socket.once('connect', clearConnectTimer)
		})
		request.setTimeout(timeoutMs, () =>
			request.destroy(
				new Error(
					`Kody API sent nothing for ${timeoutMs}ms (${url.pathname}).`,
				),
			),
		)
		request.on('error', (error) => {
			clearTimeout(connectTimer)
			reject(
				error instanceof CapabilityProxyError
					? error
					: new CapabilityProxyError(
							formatUnreachableApiMessage({
								origin: url.origin,
								error,
							}),
							{ sent: requestSentStatus(error) },
						),
			)
		})
		if (signal) {
			const abort = () => {
				clearTimeout(connectTimer)
				request.destroy(abortError(signal.reason))
			}
			if (signal.aborted) {
				abort()
			} else {
				signal.addEventListener('abort', abort, { once: true })
				request.once('close', () => signal.removeEventListener('abort', abort))
			}
		}
		if (input.body) {
			input.body.pipe(request)
			input.body.on('error', (error) => {
				clearTimeout(connectTimer)
				request.destroy(error)
			})
		} else {
			request.end()
		}
	})
}

/** Convert a Node response into a streaming Web `Response`. */
export function nodeIncomingToWebResponse(response: IncomingMessage): Response {
	const headers = new Headers()
	for (const [name, value] of Object.entries(response.headers)) {
		if (Array.isArray(value)) {
			for (const entry of value) headers.append(name, entry)
		} else if (value !== undefined) {
			headers.set(name, value)
		}
	}
	const status = response.statusCode ?? 0
	const bodyless =
		status === 101 ||
		status === 103 ||
		status === 204 ||
		status === 205 ||
		status === 304
	if (bodyless) {
		response.resume()
		return new Response(null, {
			status,
			statusText: response.statusMessage ?? '',
			headers,
		})
	}
	return new Response(
		Readable.toWeb(response) as import('node:stream/web').ReadableStream,
		{
			status,
			statusText: response.statusMessage ?? '',
			headers,
		},
	)
}

/**
 * Preflight ADR 0068 call-map picks via `kody.credentialClientCheck` before
 * local code runs. Throws on a structured check failure; returns warnings for
 * ad hoc (non-strict) unknown keys.
 */
export async function checkCredentialCallMap(
	input: CapabilityProxyClientInput & {
		credentials: CredentialCallMapInput
		conversationId?: string
		/** Invoke / package entry: unknown keys are errors. */
		strict?: boolean
		packageId?: string
	},
): Promise<{ warnings: Array<string> }> {
	const args: Record<string, unknown> = {}
	if (input.strict === true) args.strict = true
	if (input.packageId !== undefined) args.packageId = input.packageId
	const result = await callCapabilityProxy({
		apiUrl: input.apiUrl,
		token: input.token,
		fetchFn: input.fetchFn,
		signal: input.signal,
		path: ['kody', 'credentialClientCheck'],
		args: [args],
		conversationId: input.conversationId,
		credentials: input.credentials,
	})
	if (!isRecord(result)) {
		throw new CapabilityProxyError(
			'credentialClientCheck returned an unexpected result.',
		)
	}
	if (result.ok === false) {
		const error = isRecord(result.error) ? result.error : {}
		const code =
			typeof error.code === 'string' ? error.code : 'credential_error'
		throw new CapabilityProxyError(formatCredentialClientError(error), { code })
	}
	const value = isRecord(result.value) ? result.value : null
	const warnings = Array.isArray(value?.warnings)
		? value.warnings.filter(
				(warning): warning is string => typeof warning === 'string',
			)
		: []
	return { warnings }
}

async function send(
	input: CapabilityProxyClientInput,
	url: URL,
	init: RequestInit,
): Promise<Response> {
	const fetchFn = input.fetchFn ?? capabilityProxyFetch()
	try {
		return await fetchFn(url, {
			...init,
			signal: input.signal,
			headers: {
				...(init.headers as Record<string, string> | undefined),
				accept: 'application/json',
				authorization: `Bearer ${input.token}`,
				'user-agent': `${cliName}/${readPackageVersion()}`,
			},
		})
	} catch (error) {
		if (error instanceof CapabilityProxyError) throw error
		throw new CapabilityProxyError(
			formatUnreachableApiMessage({ origin: url.origin, error }),
			{ sent: requestSentStatus(error) },
		)
	}
}

async function readJson(response: Response): Promise<unknown> {
	const text = await response.text()
	if (!text) return null
	try {
		return JSON.parse(text)
	} catch {
		return text
	}
}

function readErrorBody(
	body: unknown,
): { code: string | null; message: string } | null {
	if (!isRecord(body) || body.error == null) return null
	const { error } = body
	if (typeof error === 'string') return { code: null, message: error }
	if (isRecord(error)) {
		const code = typeof error.code === 'string' ? error.code : null
		const message =
			typeof error.message === 'string'
				? error.message
				: (code ?? JSON.stringify(error))
		return { code, message }
	}
	return { code: null, message: String(error) }
}

function describeFailure(
	status: number,
	body: unknown,
	url: URL,
	stage: 'session' | 'call',
	token: string,
): CapabilityProxyError {
	const failure = readErrorBody(body)
	const code = failure?.code ?? null
	const detail = failure?.message ? ` Server said: ${failure.message}` : ''
	if (status === 401) {
		const message = isScopedApiToken(token)
			? rejectedApiTokenMessage(detail)
			: `${rejectedOauthBearerMessage()}${detail}`
		return new CapabilityProxyError(message, { status, code })
	}
	if (code === 'feature_disabled') {
		return new CapabilityProxyError(`${featureDisabledMessage()}${detail}`, {
			status,
			code,
		})
	}
	if (code === 'insufficient_scope') {
		return new CapabilityProxyError(
			`${insufficientScopeMessage({
				...readInsufficientScopeDetails(body),
				currentLifetime: currentStoredTokenLifetimeAlias(url.origin),
			})}${detail}`,
			{ status, code },
		)
	}
	if (status === 403 && stage === 'session') {
		return new CapabilityProxyError(
			capabilityProxyForbiddenMessage({
				code,
				serverMessage: failure?.message,
			}),
			{ status, code },
		)
	}
	if (status === 404 && stage === 'session') {
		return new CapabilityProxyError(
			`CapabilityProxy was not found at ${url.href}. Local execute may not be deployed on this Kody API yet; check --api-url / KODY_API_URL.`,
			{ status, code },
		)
	}
	return new CapabilityProxyError(
		failure?.message ??
			`Kody API request failed with HTTP ${status} (${url.pathname}).`,
		{ status, code },
	)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}
