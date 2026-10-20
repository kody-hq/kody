import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from 'node:http'
import { isScopedApiToken, notAuthenticatedMessage } from './api-token.js'
import {
	accessTokenSkewMs,
	cliRedirectUrl,
	defaultApiUrl,
	defaultMcpUrl,
	loginTimeoutMs,
} from './defaults.js'
import {
	discoverLoginIdentity,
	type LoginIdentity,
} from './discover-login-identity.js'
import { discoverOrgSlugFromAccessToken } from './discover-org.js'
import {
	loginCallbackErrorFromOAuthError,
	renderLoginCallbackPage,
	type LoginCallbackAccount,
	type LoginCallbackErrorKind,
} from './login-callback-page.js'
import { orgSlugFromFlag } from './oauth-provider.js'
import {
	buildCliAuthorizationUrl,
	createPkcePair,
	discoverCliAuthorizationServer,
	exchangeAuthorizationCode,
	refreshOAuthTokens,
} from './oauth-browser.js'
import { OpenApiError, openApiGet, openApiRequest } from './open-api-client.js'
import { openUrl } from './open-url.js'
import { redactError } from './redact.js'
import {
	loadCredentialStore,
	loadCredentials,
	loadPendingCredentials,
	promotePendingOrg,
	saveCredentials,
	type SecretBackend,
	type StoreResolution,
	type StoredCredentials,
} from './store.js'

export type LoginOptions = {
	mcpUrl?: string
	/** Organization slug. Omit to let the server bind the sole or signup org. */
	org?: string
	openBrowser?: boolean
	backend?: SecretBackend
	resolution?: StoreResolution
	timeoutMs?: number
	now?: () => number
	fetchFn?: typeof fetch
	onAuthorizationUrl?: (url: URL) => void
	/**
	 * Test seam: resolve org + account after the code exchange so the localhost
	 * callback page can show them (and multi-org storage can name the login).
	 * Defaults to `metaGetCurrentUser` via {@link discoverLoginIdentity}.
	 */
	/** Open API origin that mints the device token. Defaults to the paired API. */
	apiUrl?: string
	/** Device token lifetime. Defaults to long (interactive login). */
	lifetime?: 'short' | 'long'
	discoverIdentity?: (input: {
		mcpUrl: string
		accessToken: string
		apiUrl?: string
		org?: string
		fetchFn?: typeof fetch
	}) => Promise<LoginIdentity>
}

export function isAccessTokenExpired(
	credentials: StoredCredentials,
	now: number = Date.now(),
): boolean {
	if (!credentials.expiresAt) return false
	return now + accessTokenSkewMs >= credentials.expiresAt
}

export function credentialsFromTokens(input: {
	mcpUrl: string
	resource: string
	authorizationServerUrl: string
	client: { client_id: string; client_secret?: string }
	tokens: {
		access_token: string
		token_type?: string
		refresh_token?: string
		expires_in?: number
		scope?: string
	}
	previous?: StoredCredentials
	org?: string
	now?: number
}): StoredCredentials {
	const now = input.now ?? Date.now()
	const expiresAt =
		typeof input.tokens.expires_in === 'number'
			? now + input.tokens.expires_in * 1000
			: input.previous?.expiresAt
	const org = input.org ?? input.previous?.org
	return {
		version: 1,
		mcpUrl: input.mcpUrl,
		...(org ? { org } : {}),
		resource: input.resource,
		authorizationServerUrl: input.authorizationServerUrl,
		clientId: input.client.client_id,
		clientSecret:
			'client_secret' in input.client
				? input.client.client_secret
				: input.previous?.clientSecret,
		accessToken: input.tokens.access_token,
		refreshToken: input.tokens.refresh_token ?? input.previous?.refreshToken,
		tokenType: input.tokens.token_type ?? 'bearer',
		expiresAt,
		scope: input.tokens.scope ?? input.previous?.scope,
	}
}

function deviceCredentials(input: {
	mcpUrl: string
	apiUrl: string
	authorizationServerUrl: string
	token: string
	expiresAt: number | undefined
	scopes: Array<string>
	previous?: StoredCredentials
	org?: string
}): StoredCredentials {
	const org = input.org ?? input.previous?.org
	return {
		version: 1,
		mcpUrl: input.mcpUrl,
		...(org ? { org } : {}),
		resource: input.mcpUrl,
		authorizationServerUrl: input.authorizationServerUrl,
		clientId: new URL(
			'/oauth/cli-client-metadata.json',
			input.authorizationServerUrl,
		).href,
		accessToken: input.token,
		tokenType: 'bearer',
		expiresAt: input.expiresAt,
		scope: input.scopes.join(' '),
	}
}

async function mintDeviceToken(input: {
	apiUrl: string
	oauthAccessToken: string
	lifetime: 'short' | 'long'
	fetchFn?: typeof fetch
}): Promise<{
	token: string
	expiresAt?: number
	scopes: Array<string>
	loginOrg?: string
}> {
	const minted = await openApiRequest({
		token: input.oauthAccessToken,
		apiUrl: input.apiUrl,
		fetchFn: input.fetchFn,
		method: 'POST',
		path: 'v1/tokens/device',
		body: { lifetime: input.lifetime, name: 'kody-cli' },
	})
	if (!minted || typeof minted !== 'object' || Array.isArray(minted)) {
		throw new Error('Device token mint returned no token.')
	}
	const record = minted as {
		token?: unknown
		expires_at?: unknown
		scopes?: unknown
		login_org?: { slug?: unknown } | null
	}
	if (
		typeof record.token !== 'string' ||
		!record.token.startsWith('kody_at_')
	) {
		throw new Error('Device token mint did not return a kody_at_ token.')
	}
	const expiresAt =
		typeof record.expires_at === 'string'
			? Date.parse(record.expires_at)
			: undefined
	const scopes = Array.isArray(record.scopes)
		? record.scopes.filter(
				(scope): scope is string => typeof scope === 'string',
			)
		: []
	const loginOrg =
		typeof record.login_org?.slug === 'string' && record.login_org.slug.trim()
			? record.login_org.slug.trim()
			: undefined
	return {
		token: record.token,
		...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
		scopes,
		...(loginOrg ? { loginOrg } : {}),
	}
}

export async function refreshStoredCredentials(input: {
	credentials: StoredCredentials
	backend?: SecretBackend
	resolution?: StoreResolution
	now?: number
	fetchFn?: typeof fetch
	apiUrl?: string
}): Promise<StoredCredentials> {
	const { credentials } = input
	if (isScopedApiToken(credentials.accessToken)) {
		if (!isAccessTokenExpired(credentials, input.now)) return credentials
		const slid = await adoptSlidingDeviceExpiry(input)
		if (slid) return slid
		throw new Error('Stored API token expired. Run `kody login`.')
	}
	if (!credentials.refreshToken) {
		throw new Error('No refresh token is stored. Run `kody login`.')
	}
	const refreshed = await refreshOAuthTokens({
		issuer: credentials.authorizationServerUrl,
		mcpUrl: credentials.mcpUrl,
		refreshToken: credentials.refreshToken,
		fetchFn: input.fetchFn,
	})
	const apiUrl = input.apiUrl ?? defaultApiUrl
	const device = await mintDeviceToken({
		apiUrl,
		oauthAccessToken: refreshed.accessToken,
		lifetime: 'long',
		fetchFn: input.fetchFn,
	})
	const next = deviceCredentials({
		mcpUrl: credentials.mcpUrl,
		apiUrl,
		authorizationServerUrl: refreshed.issuer,
		token: device.token,
		expiresAt: device.expiresAt,
		scopes: device.scopes,
		previous: credentials,
		org: credentials.org ?? device.loginOrg,
	})
	saveCredentials(next, input.backend, input.resolution, { activate: false })
	return next
}

/**
 * Finish silent v1→multi-org migration when a pending session has no slug yet.
 * Best-effort: failures leave pending in place so commands still work.
 */
export async function resolvePendingOrgSlug(input: {
	mcpUrl?: string
	apiUrl?: string
	backend?: SecretBackend
	resolution?: StoreResolution
	now?: number
	fetchFn?: typeof fetch
	discoverOrg?: (input: {
		mcpUrl: string
		accessToken: string
		fetchFn?: typeof fetch
	}) => Promise<string>
}): Promise<string | null> {
	const mcpUrl = input.mcpUrl ?? defaultMcpUrl
	const snapshot = loadCredentialStore(mcpUrl, input.backend, input.resolution)
	if (!snapshot?.pending) return snapshot?.activeOrg ?? null
	let pending = loadPendingCredentials(mcpUrl, input.backend, input.resolution)
	if (!pending) return snapshot.activeOrg ?? null
	if (isAccessTokenExpired(pending, input.now)) {
		if (!pending.refreshToken) return null
		try {
			pending = await refreshStoredCredentials({
				credentials: pending,
				backend: input.backend,
				resolution: input.resolution,
				now: input.now,
				fetchFn: input.fetchFn,
				apiUrl: input.apiUrl,
			})
		} catch {
			return null
		}
	}
	const discover = input.discoverOrg ?? discoverOrgSlugFromAccessToken
	try {
		const slug = await discover({
			mcpUrl,
			accessToken: pending.accessToken,
			fetchFn: input.fetchFn,
		})
		promotePendingOrg(mcpUrl, slug, input.backend, input.resolution)
		return slug
	} catch {
		return null
	}
}

export async function ensureFreshCredentials(input: {
	mcpUrl?: string
	apiUrl?: string
	org?: string
	backend?: SecretBackend
	resolution?: StoreResolution
	now?: number
	fetchFn?: typeof fetch
	discoverOrg?: (input: {
		mcpUrl: string
		accessToken: string
		fetchFn?: typeof fetch
	}) => Promise<string>
}): Promise<StoredCredentials> {
	const mcpUrl = input.mcpUrl ?? defaultMcpUrl
	await resolvePendingOrgSlug({
		mcpUrl,
		apiUrl: input.apiUrl,
		backend: input.backend,
		resolution: input.resolution,
		now: input.now,
		fetchFn: input.fetchFn,
		discoverOrg: input.discoverOrg,
	})
	const credentials = loadCredentials(mcpUrl, input.backend, input.resolution, {
		org: input.org,
	})
	if (!credentials) {
		if (input.org) {
			throw new Error(
				`No login stored for org "${input.org}". Run \`kody login --org ${input.org}\` (or \`kody org use ${input.org}\` after logging in).`,
			)
		}
		throw new Error(notAuthenticatedMessage())
	}
	if (!isAccessTokenExpired(credentials, input.now)) {
		return credentials
	}
	return await refreshStoredCredentials({
		credentials,
		backend: input.backend,
		resolution: input.resolution,
		now: input.now,
		fetchFn: input.fetchFn,
		apiUrl: input.apiUrl,
	})
}

/**
 * Credentials for Open API calls. A still-valid OAuth access token is exchanged
 * for a device `kody_at_` immediately — Open API routes reject MCP OAuth.
 * Local execute keeps {@link ensureFreshCredentials} so an unexpired OAuth
 * session can still reach the local-execute routes that allow it.
 */
export async function ensureOpenApiCredentials(
	input: Parameters<typeof ensureFreshCredentials>[0],
): Promise<StoredCredentials> {
	const credentials = await ensureFreshCredentials(input)
	if (isScopedApiToken(credentials.accessToken)) return credentials
	return refreshStoredCredentials({
		credentials,
		backend: input.backend,
		resolution: input.resolution,
		now: input.now,
		fetchFn: input.fetchFn,
		apiUrl: input.apiUrl,
	})
}

async function adoptSlidingDeviceExpiry(input: {
	credentials: StoredCredentials
	backend?: SecretBackend
	resolution?: StoreResolution
	now?: number
	fetchFn?: typeof fetch
	apiUrl?: string
}): Promise<StoredCredentials | null> {
	const { credentials } = input
	try {
		const current = await openApiGet({
			token: credentials.accessToken,
			apiUrl: input.apiUrl ?? defaultApiUrl,
			path: 'v1/tokens/current',
			fetchFn: input.fetchFn,
			...(credentials.org ? { org: credentials.org } : {}),
		})
		if (!current || typeof current !== 'object' || Array.isArray(current)) {
			return null
		}
		const expiresAt = Date.parse(
			typeof (current as { expires_at?: unknown }).expires_at === 'string'
				? (current as { expires_at: string }).expires_at
				: '',
		)
		const now = input.now ?? Date.now()
		if (!Number.isFinite(expiresAt) || expiresAt <= now) return null
		const next = { ...credentials, expiresAt }
		saveCredentials(next, input.backend, input.resolution, { activate: false })
		return next
	} catch (error) {
		if (
			error instanceof OpenApiError &&
			(error.status === 401 || error.status === 403)
		) {
			return null
		}
		throw error
	}
}

function startCallbackServer(redirectUri: URL): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer()
		const port = Number(redirectUri.port)
		server.listen(port, redirectUri.hostname, () => resolve(server))
		server.on('error', (error) => {
			if ('code' in error && error.code === 'EADDRINUSE') {
				reject(
					new Error(
						`Login callback port ${port} is in use. Stop the other listener and retry.`,
					),
				)
				return
			}
			reject(error)
		})
	})
}

type CallbackSuccess = {
	code: string
	iss?: string
	/**
	 * Hold the browser response open until exchange + identity resolve, then
	 * write the designed success/error page (never echoes code/tokens).
	 */
	complete: (page: Parameters<typeof renderLoginCallbackPage>[0]) => void
}

function sendCallbackHtml(
	response: ServerResponse,
	status: number,
	page: Parameters<typeof renderLoginCallbackPage>[0],
): void {
	if (response.headersSent) return
	response.writeHead(status, {
		'Content-Type': 'text/html; charset=utf-8',
		'Cache-Control': 'no-store',
	})
	response.end(renderLoginCallbackPage(page))
}

function waitForCallback(input: {
	server: Server
	redirectUri: URL
	expectedState: string
	timeoutMs: number
}): Promise<CallbackSuccess> {
	return new Promise((resolve, reject) => {
		let settled = false
		let pendingResponse: ServerResponse | undefined

		const closeServer = () => {
			input.server.close()
		}

		const rejectOnce = (error: Error) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			closeServer()
			reject(error)
		}

		const resolveOnce = (result: CallbackSuccess) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve(result)
		}

		const timer = setTimeout(() => {
			if (pendingResponse && !pendingResponse.headersSent) {
				sendCallbackHtml(pendingResponse, 408, {
					kind: 'error',
					error: 'expired',
				})
			}
			rejectOnce(new Error('Timed out waiting for the browser login.'))
		}, input.timeoutMs)

		input.server.on(
			'request',
			(request: IncomingMessage, response: ServerResponse) => {
				try {
					const url = new URL(request.url ?? '/', input.redirectUri)
					if (url.pathname !== input.redirectUri.pathname) {
						response.writeHead(404).end('Not found')
						return
					}
					const error = url.searchParams.get('error')
					if (error) {
						const description = url.searchParams.get('error_description') ?? ''
						const kind = loginCallbackErrorFromOAuthError(error)
						sendCallbackHtml(response, 400, { kind: 'error', error: kind })
						rejectOnce(new Error(description || error))
						return
					}
					const state = url.searchParams.get('state')
					const code = url.searchParams.get('code')
					const iss = url.searchParams.get('iss') ?? undefined
					if (state !== input.expectedState || !code) {
						const kind: LoginCallbackErrorKind =
							state && state !== input.expectedState
								? 'state_mismatch'
								: 'failed'
						sendCallbackHtml(response, 400, { kind: 'error', error: kind })
						rejectOnce(new Error('OAuth callback missing code or state.'))
						return
					}
					pendingResponse = response
					resolveOnce({
						code,
						...(iss ? { iss } : {}),
						complete(page) {
							sendCallbackHtml(
								response,
								page.kind === 'success' ? 200 : 400,
								page,
							)
							closeServer()
						},
					})
				} catch (error) {
					rejectOnce(redactError(error))
				}
			},
		)
	})
}

export async function login(options: LoginOptions = {}): Promise<{
	credentials: StoredCredentials
	authorizationUrl: URL
	backendKind: 'keyring' | 'file'
	backendPath?: string
	org?: string
	account?: LoginCallbackAccount
}> {
	const mcpUrl = options.mcpUrl ?? defaultMcpUrl
	const apiUrl = options.apiUrl ?? defaultApiUrl
	const orgHint =
		options.org === undefined ? undefined : orgSlugFromFlag(options.org)
	const redirectUri = cliRedirectUrl()
	const expectedState = crypto.randomUUID()
	const issuer = new URL(mcpUrl).origin
	const authorizationServer = await discoverCliAuthorizationServer({
		issuer: new URL(issuer),
		fetchFn: options.fetchFn,
	})
	const pkce = await createPkcePair()
	const authorizationUrl = await buildCliAuthorizationUrl({
		authorizationServer,
		mcpUrl,
		redirectUri,
		state: expectedState,
		codeChallenge: pkce.challenge,
		...(orgHint ? { org: orgHint } : {}),
	})
	const server = await startCallbackServer(redirectUri)
	options.onAuthorizationUrl?.(authorizationUrl)
	if (options.openBrowser !== false) {
		await openUrl(authorizationUrl.href)
	}
	let completeCallback: CallbackSuccess['complete'] | undefined
	try {
		const callback = await waitForCallback({
			server,
			redirectUri,
			expectedState,
			timeoutMs: options.timeoutMs ?? loginTimeoutMs,
		})
		completeCallback = callback.complete
		const callbackUrl = new URL(redirectUri.href)
		callbackUrl.searchParams.set('code', callback.code)
		callbackUrl.searchParams.set('state', expectedState)
		if (callback.iss) callbackUrl.searchParams.set('iss', callback.iss)
		const tokens = await exchangeAuthorizationCode({
			authorizationServer,
			mcpUrl,
			redirectUri,
			callback: callbackUrl,
			state: expectedState,
			codeVerifier: pkce.verifier,
			fetchFn: options.fetchFn,
		})
		const device = await mintDeviceToken({
			apiUrl,
			oauthAccessToken: tokens.accessToken,
			lifetime: options.lifetime ?? 'long',
			fetchFn: options.fetchFn,
		})

		let org = device.loginOrg ?? orgHint
		let account: LoginCallbackAccount | undefined
		const discover = options.discoverIdentity ?? discoverLoginIdentity
		try {
			const boundOrg = org
			const identity = await discover({
				mcpUrl,
				apiUrl,
				accessToken: device.token,
				fetchFn: options.fetchFn,
				...(boundOrg ? { org: boundOrg } : {}),
			})
			if (orgHint && identity.org !== orgHint) {
				completeCallback?.({ kind: 'error', error: 'failed' })
				completeCallback = undefined
				throw new Error(
					`Login was bound to org "${identity.org}" but \`--org ${orgHint}\` was requested.`,
				)
			}
			org = identity.org
			account = identity.account
		} catch (error) {
			// Org mismatch always fails. Soft-fail other discovery errors only
			// when we can still name the login (--org) or park a sole pending
			// migration (no named orgs yet). Otherwise a nameless pending
			// beside existing orgs would never become active.
			if (
				error instanceof Error &&
				error.message.startsWith('Login was bound to org ')
			) {
				throw error
			}
			if (!org) {
				const existing = loadCredentialStore(
					mcpUrl,
					options.backend,
					options.resolution,
				)
				if (existing && Object.keys(existing.orgs).length > 0) {
					completeCallback?.({ kind: 'error', error: 'failed' })
					completeCallback = undefined
					throw new Error(
						'Could not determine the organization for this login. Re-run with `kody login --org <slug>`.',
					)
				}
			}
		}

		const credentials = deviceCredentials({
			mcpUrl,
			apiUrl,
			authorizationServerUrl: tokens.issuer,
			token: device.token,
			expiresAt: device.expiresAt,
			scopes: device.scopes,
			org,
		})
		const saved = saveCredentials(
			credentials,
			options.backend,
			options.resolution,
		)

		completeCallback?.({
			kind: 'success',
			...(org ? { org } : {}),
			...(account ? { account } : {}),
		})
		completeCallback = undefined

		return {
			credentials,
			authorizationUrl,
			backendKind: saved.backend.kind,
			backendPath: saved.backend.path,
			...(org ? { org } : {}),
			...(account ? { account } : {}),
		}
	} catch (error) {
		completeCallback?.({ kind: 'error', error: 'failed' })
		server.close()
		throw redactError(error)
	}
}
