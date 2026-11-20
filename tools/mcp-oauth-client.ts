import {
	Client as ModernClient,
	StreamableHTTPClientTransport as ModernStreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mcpOauthScopes } from '#worker/mcp-oauth-scopes.ts'

export type AppAuthUser = {
	email: string
	username: string
	password: string
}

export type OAuthClientRegistration = {
	clientId: string
	clientSecret: string
	redirectUri: string
}

export type AppMcpOAuthSession = OAuthClientRegistration & {
	accessToken: string
}

export type McpConnection = {
	client: Client
	transport: StreamableHTTPClientTransport
}

export type FetchLike = typeof fetch

const defaultRedirectUri = 'http://127.0.0.1/oauth/callback'
const defaultOAuthClientName = 'Kody MCP E2E Test Client'
const defaultMcpClientName = 'kody-mcp-e2e-client'
const defaultControlKodyClientName = 'kody-control-kody'
/** `/auth` and `/oauth/authorize` share the per-IP 10/60s bucket. */
const authRateLimitAttempts = 3
const authRateLimitFallbackMs = 60_000

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms))

class AuthRateLimitedError extends Error {
	readonly status = 429
	constructor(message: string) {
		super(message)
		this.name = 'AuthRateLimitedError'
	}
}

/**
 * Honor `Retry-After` seconds. Missing or unparsable headers wait the
 * limiter window; the cap keeps a bad header from parking a job.
 */
function authRetryAfterDelayMs(
	response: Response,
	fallbackMs = authRateLimitFallbackMs,
	maxMs = authRateLimitFallbackMs,
) {
	const header = response.headers.get('Retry-After')?.trim()
	if (header && /^\d+$/.test(header)) {
		return Math.min(Number(header) * 1000, maxMs)
	}
	return fallbackMs
}

async function fetchAuthRateLimited(fetchOnce: () => Promise<Response>) {
	let attempt = 0
	for (;;) {
		attempt += 1
		const response = await fetchOnce()
		if (response.status !== 429 || attempt >= authRateLimitAttempts) {
			return response
		}
		await sleep(authRetryAfterDelayMs(response))
	}
}

export function usernameFromEmail(email: string) {
	const local = email.split('@')[0]?.trim()
	return local && local.length > 0 ? local : 'preview-user'
}

function mcpAccountRejectedMessage(detail: string) {
	return [
		'MCP rejected this account.',
		'The preview seed (me@kentcdodds.com) is already email-verified; this CLI does not mark email verified via D1.',
		`Detail: ${detail}`,
	].join(' ')
}

export async function loginToApp(
	origin: string,
	user: AppAuthUser,
	fetchImpl: FetchLike = fetch,
) {
	// Prefer login. MCP e2e Cloudflare-mock servers seed the user in D1 so
	// authentication never depends on the Email Sending mock (a configured
	// sender that 503s or returns an empty body rolls signup back).
	const loginResponse = await authenticateAppUser(
		origin,
		user,
		'login',
		fetchImpl,
	)
	if (loginResponse.ok) {
		return readCookieHeader(loginResponse)
	}
	// 429 is the shared auth bucket, not a missing account. Signup would
	// burn more slots and still fail.
	if (loginResponse.status === 429) {
		const loginBody = await loginResponse.text()
		throw new AuthRateLimitedError(
			`Failed to authenticate test user.\nLogin: ${loginResponse.status} ${loginBody}`,
		)
	}

	const signupResponse = await authenticateAppUser(
		origin,
		user,
		'signup',
		fetchImpl,
	)
	// An already-registered email gets the same accepted body as a fresh
	// signup but no session cookie (anti-enumeration), so only a response
	// that actually set the session counts as a signup.
	if (
		signupResponse.ok &&
		signupResponse.headers.get('Set-Cookie')?.includes('kody_session=')
	) {
		return readCookieHeader(signupResponse)
	}
	if (signupResponse.status === 429) {
		const signupBody = await signupResponse.text()
		throw new AuthRateLimitedError(
			`Failed to authenticate test user.\nSignup: ${signupResponse.status} ${signupBody}`,
		)
	}

	const retryLoginResponse = await authenticateAppUser(
		origin,
		user,
		'login',
		fetchImpl,
	)
	if (!retryLoginResponse.ok) {
		const signupBody = await signupResponse.text()
		const loginBody = await retryLoginResponse.text()
		throw new Error(
			`Failed to authenticate test user.\nSignup: ${signupResponse.status} ${signupBody}\nLogin: ${retryLoginResponse.status} ${loginBody}`,
		)
	}

	return readCookieHeader(retryLoginResponse)
}

export async function registerOAuthClient(
	origin: string,
	options: {
		clientName?: string
		redirectUri?: string
		fetchImpl?: FetchLike
	} = {},
): Promise<OAuthClientRegistration> {
	const redirectUri = options.redirectUri ?? defaultRedirectUri
	const fetchImpl = options.fetchImpl ?? fetch
	const payload = await fetchJson<Record<string, unknown>>(
		origin,
		'/oauth/register',
		{
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				client_name: options.clientName ?? defaultOAuthClientName,
				redirect_uris: [redirectUri],
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
				token_endpoint_auth_method: 'client_secret_post',
			}),
		},
		fetchImpl,
	)
	const clientId = readStringField(payload, 'client_id')
	const clientSecret = readStringField(payload, 'client_secret')
	return {
		clientId,
		clientSecret,
		redirectUri,
	}
}

export async function authorizeOAuthClient(
	origin: string,
	client: OAuthClientRegistration,
	cookieHeader: string,
	fetchImpl: FetchLike = fetch,
	orgSlug?: string,
) {
	const authorizeUrl = new URL('/oauth/authorize', origin)
	const resource = new URL('/mcp', origin).toString()
	authorizeUrl.searchParams.set('response_type', 'code')
	authorizeUrl.searchParams.set('client_id', client.clientId)
	authorizeUrl.searchParams.set('redirect_uri', client.redirectUri)
	authorizeUrl.searchParams.set('scope', mcpOauthScopes.join(' '))
	authorizeUrl.searchParams.set('state', 'kody-mcp-e2e-state')
	authorizeUrl.searchParams.set('resource', resource)
	if (orgSlug) authorizeUrl.searchParams.set('org', orgSlug)

	const response = await fetchAuthRateLimited(() =>
		fetchImpl(authorizeUrl, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				Cookie: cookieHeader,
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				decision: 'approve',
			}),
		}),
	)
	const rawBody = await response.text()
	if (response.status === 429) {
		throw new AuthRateLimitedError(
			`OAuth authorize request failed with ${response.status}: ${rawBody}`,
		)
	}
	if (!response.ok) {
		throw new Error(
			`OAuth authorize request failed with ${response.status}: ${rawBody}`,
		)
	}
	const payload = JSON.parse(rawBody) as Record<string, unknown>
	const redirectTo = readStringField(payload, 'redirectTo')
	const code = new URL(redirectTo).searchParams.get('code')
	if (!code) {
		throw new Error(
			`OAuth authorize response did not include a code: ${rawBody}`,
		)
	}
	return code
}

export async function exchangeAuthorizationCode(
	origin: string,
	client: OAuthClientRegistration,
	code: string,
	fetchImpl: FetchLike = fetch,
) {
	const resource = new URL('/mcp', origin).toString()
	const response = await fetchImpl(new URL('/oauth/token', origin), {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			client_id: client.clientId,
			client_secret: client.clientSecret,
			redirect_uri: client.redirectUri,
			resource,
		}),
	})
	const rawBody = await response.text()
	if (!response.ok) {
		throw new Error(
			`OAuth token exchange failed with ${response.status}: ${rawBody}`,
		)
	}
	const payload = JSON.parse(rawBody) as Record<string, unknown>
	return readStringField(payload, 'access_token')
}

export async function connectMcpClient(
	origin: string,
	headers: Record<string, string>,
	options: { name?: string; version?: string } = {},
): Promise<McpConnection> {
	const client = new Client(
		{
			name: options.name ?? defaultMcpClientName,
			version: options.version ?? '1.0.0',
		},
		{ capabilities: {} },
	)
	const transport = new StreamableHTTPClientTransport(new URL('/mcp', origin), {
		requestInit: {
			headers,
		},
	})
	await client.connect(transport)
	return { client, transport }
}

export async function closeMcpConnection(input: McpConnection) {
	await input.client.close().catch(() => undefined)
	await input.transport.terminateSession().catch(() => undefined)
	await input.transport.close().catch(() => undefined)
}

export async function resolveAppMcpAuth(
	origin: string,
	user: AppAuthUser,
	options: {
		clientName?: string
		fetchImpl?: FetchLike
		cookieHeader?: string
		oauth?: AppMcpOAuthSession
		/** Bind the connection to this org (`?org=` on authorize). */
		orgSlug?: string
	} = {},
): Promise<{ cookieHeader: string; oauth: AppMcpOAuthSession }> {
	if (options.cookieHeader && options.oauth) {
		return {
			cookieHeader: options.cookieHeader,
			oauth: options.oauth,
		}
	}

	const fetchImpl = options.fetchImpl ?? fetch
	let cookieHeader =
		options.cookieHeader ?? (await loginToApp(origin, user, fetchImpl))
	const clientRegistration = options.oauth
		? {
				clientId: options.oauth.clientId,
				clientSecret: options.oauth.clientSecret,
				redirectUri: options.oauth.redirectUri,
			}
		: await registerOAuthClient(origin, {
				clientName: options.clientName,
				fetchImpl,
			})
	try {
		return {
			cookieHeader,
			oauth: {
				...clientRegistration,
				accessToken: await mintAccessToken(
					origin,
					clientRegistration,
					cookieHeader,
					fetchImpl,
					options.orgSlug,
				),
			},
		}
	} catch (error) {
		if (!options.cookieHeader || error instanceof AuthRateLimitedError) {
			throw error
		}
		cookieHeader = await loginToApp(origin, user, fetchImpl)
		return {
			cookieHeader,
			oauth: {
				...clientRegistration,
				accessToken: await mintAccessToken(
					origin,
					clientRegistration,
					cookieHeader,
					fetchImpl,
					options.orgSlug,
				),
			},
		}
	}
}

async function mintAccessToken(
	origin: string,
	client: OAuthClientRegistration,
	cookieHeader: string,
	fetchImpl: FetchLike,
	orgSlug?: string,
) {
	const code = await authorizeOAuthClient(
		origin,
		client,
		cookieHeader,
		fetchImpl,
		orgSlug,
	)
	return exchangeAuthorizationCode(origin, client, code, fetchImpl)
}

export async function connectAppMcpClient(
	origin: string,
	user: AppAuthUser,
	options: {
		extraHeaders?: Record<string, string>
		clientName?: string
		fetchImpl?: FetchLike
		cookieHeader?: string
		oauth?: AppMcpOAuthSession
		orgSlug?: string
	} = {},
) {
	const session = await resolveAppMcpAuth(origin, user, options)
	// Preview and production Workers are multi-isolate: the legacy
	// sessionful SDK v1 client initializes, then hangs on the next request.
	// Pin the stateless 2026-07-28 lane so each tool call is self-contained.
	// Remove when: MCP protocol metrics show no 2025-era lane traffic.
	let client: ModernClient
	let transport: ModernStreamableHTTPClientTransport
	try {
		const connected = await connectStatelessMcpClient(
			origin,
			{
				Authorization: `Bearer ${session.oauth.accessToken}`,
				...options.extraHeaders,
			},
			{ name: options.clientName ?? defaultControlKodyClientName },
		)
		client = connected.client
		transport = connected.transport
	} catch (error) {
		if (options.cookieHeader || options.oauth) {
			return connectAppMcpClient(origin, user, {
				extraHeaders: options.extraHeaders,
				clientName: options.clientName,
				fetchImpl: options.fetchImpl,
				orgSlug: options.orgSlug,
			})
		}
		const detail = error instanceof Error ? error.message : String(error)
		throw new Error(mcpAccountRejectedMessage(detail))
	}
	return {
		cookieHeader: session.cookieHeader,
		oauth: session.oauth,
		client,
		async [Symbol.asyncDispose]() {
			await client.close().catch(() => undefined)
			await transport.close().catch(() => undefined)
		},
	}
}

export async function connectStatelessMcpClient(
	origin: string,
	headers: Record<string, string>,
	options: { name?: string; version?: string; fetch?: typeof fetch } = {},
) {
	const client = new ModernClient(
		{
			name: options.name ?? defaultControlKodyClientName,
			version: options.version ?? '1.0.0',
		},
		{ versionNegotiation: { mode: { pin: '2026-07-28' } } },
	)
	const transport = new ModernStreamableHTTPClientTransport(
		new URL('/mcp', origin),
		{
			...(options.fetch ? { fetch: options.fetch } : {}),
			requestInit: {
				headers,
			},
		},
	)
	await client.connect(transport)
	return { client, transport }
}

async function authenticateAppUser(
	origin: string,
	user: AppAuthUser,
	mode: 'login' | 'signup',
	fetchImpl: FetchLike,
) {
	return fetchAuthRateLimited(() =>
		fetchImpl(new URL('/auth', origin), {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				email: user.email,
				...(mode === 'signup' ? { username: user.username } : {}),
				password: user.password,
				mode,
			}),
		}),
	)
}

function readCookieHeader(response: Response) {
	const cookie = response.headers.get('Set-Cookie')
	if (!cookie) {
		throw new Error('Authentication response did not include a session cookie.')
	}
	return cookie.split(';')[0] ?? cookie
}

async function fetchJson<T = Record<string, unknown>>(
	origin: string,
	pathname: string,
	init: RequestInit | undefined,
	fetchImpl: FetchLike,
): Promise<T> {
	const response = await fetchImpl(new URL(pathname, origin), init)
	const rawBody = await response.text()
	if (!response.ok) {
		throw new Error(
			`Request to ${pathname} failed with ${response.status}: ${rawBody}`,
		)
	}
	return JSON.parse(rawBody) as T
}

function readStringField(record: Record<string, unknown>, key: string) {
	const value = record[key]
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`Expected "${key}" to be a non-empty string.`)
	}
	return value
}
