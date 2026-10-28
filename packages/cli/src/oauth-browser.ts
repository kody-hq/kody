import * as oauth from 'oauth4webapi'
import {
	cliClientMetadataUrl,
	cliRedirectUrl,
	defaultScopes,
} from './defaults.js'
import { orgSlugFromFlag } from './org-slug.js'

export type OAuthTokenSet = {
	accessToken: string
	refreshToken?: string
	tokenType: string
	expiresIn?: number
	scope?: string
	issuer: string
}

function fetchFrom(fetchFn: typeof fetch | undefined): typeof fetch {
	return fetchFn ?? fetch
}

function discoveryOptions(issuer: URL, fetchFn: typeof fetch | undefined) {
	return {
		algorithm: 'oauth2' as const,
		[oauth.customFetch]: fetchFrom(fetchFn),
		...(issuer.protocol === 'http:'
			? { [oauth.allowInsecureRequests]: true }
			: {}),
	}
}

export async function discoverCliAuthorizationServer(input: {
	issuer: URL
	fetchFn?: typeof fetch
}): Promise<oauth.AuthorizationServer> {
	const options = discoveryOptions(input.issuer, input.fetchFn)
	const response = await oauth.discoveryRequest(input.issuer, options)
	return oauth.processDiscoveryResponse(input.issuer, response)
}

export function cliOAuthClient(mcpUrl: string): oauth.Client {
	return {
		client_id: cliClientMetadataUrl(mcpUrl),
		token_endpoint_auth_method: 'none',
	}
}

export async function buildCliAuthorizationUrl(input: {
	authorizationServer: oauth.AuthorizationServer
	mcpUrl: string
	redirectUri?: URL
	state: string
	codeChallenge: string
	org?: string
	scope?: string
}): Promise<URL> {
	if (!input.authorizationServer.authorization_endpoint) {
		throw new Error('OAuth authorization server has no authorization_endpoint.')
	}
	const url = new URL(input.authorizationServer.authorization_endpoint)
	url.searchParams.set('client_id', cliOAuthClient(input.mcpUrl).client_id)
	url.searchParams.set(
		'redirect_uri',
		(input.redirectUri ?? cliRedirectUrl()).href,
	)
	url.searchParams.set('response_type', 'code')
	url.searchParams.set('scope', input.scope ?? defaultScopes.join(' '))
	url.searchParams.set('code_challenge', input.codeChallenge)
	url.searchParams.set('code_challenge_method', 'S256')
	url.searchParams.set('state', input.state)
	url.searchParams.set('resource', input.mcpUrl)
	if (input.org !== undefined) {
		url.searchParams.set('org', orgSlugFromFlag(input.org))
	}
	return url
}

function insecure(issuer: string) {
	return new URL(issuer).protocol === 'http:'
		? { [oauth.allowInsecureRequests]: true }
		: {}
}

export async function exchangeAuthorizationCode(input: {
	authorizationServer: oauth.AuthorizationServer
	mcpUrl: string
	redirectUri: URL
	callback: URL
	state: string
	codeVerifier: string
	fetchFn?: typeof fetch
}): Promise<OAuthTokenSet> {
	const client = cliOAuthClient(input.mcpUrl)
	const params = oauth.validateAuthResponse(
		input.authorizationServer,
		client,
		input.callback,
		input.state,
	)
	const resource = new URLSearchParams()
	resource.set('resource', input.mcpUrl)
	const response = await oauth.authorizationCodeGrantRequest(
		input.authorizationServer,
		client,
		oauth.None(),
		params,
		input.redirectUri.href,
		input.codeVerifier,
		{
			...insecure(input.authorizationServer.issuer),
			[oauth.customFetch]: fetchFrom(input.fetchFn),
			additionalParameters: resource,
		},
	)
	const tokens = await oauth.processAuthorizationCodeResponse(
		input.authorizationServer,
		client,
		response,
	)
	return tokenSetFromResult(input.authorizationServer.issuer, tokens)
}

export async function refreshOAuthTokens(input: {
	issuer: string
	mcpUrl: string
	refreshToken: string
	fetchFn?: typeof fetch
}): Promise<OAuthTokenSet> {
	const issuer = new URL(input.issuer)
	const authorizationServer = await discoverCliAuthorizationServer({
		issuer,
		fetchFn: input.fetchFn,
	})
	const client = cliOAuthClient(input.mcpUrl)
	const response = await oauth.refreshTokenGrantRequest(
		authorizationServer,
		client,
		oauth.None(),
		input.refreshToken,
		{
			...insecure(authorizationServer.issuer),
			[oauth.customFetch]: fetchFrom(input.fetchFn),
		},
	)
	const tokens = await oauth.processRefreshTokenResponse(
		authorizationServer,
		client,
		response,
	)
	return tokenSetFromResult(authorizationServer.issuer, tokens)
}

function tokenSetFromResult(
	issuer: string,
	tokens: oauth.TokenEndpointResponse,
): OAuthTokenSet {
	return {
		accessToken: tokens.access_token,
		...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
		tokenType: tokens.token_type ?? 'bearer',
		...(typeof tokens.expires_in === 'number'
			? { expiresIn: tokens.expires_in }
			: {}),
		...(tokens.scope ? { scope: tokens.scope } : {}),
		issuer,
	}
}

export async function createPkcePair(): Promise<{
	verifier: string
	challenge: string
}> {
	const verifier = oauth.generateRandomCodeVerifier()
	const challenge = await oauth.calculatePKCECodeChallenge(verifier)
	return { verifier, challenge }
}

/** RFC 8628 section 3.1: ask the server for a device_code and user_code. */
export async function startDeviceAuthorization(input: {
	authorizationServer: oauth.AuthorizationServer
	mcpUrl: string
	org?: string
	scope?: string
	fetchFn?: typeof fetch
}): Promise<oauth.DeviceAuthorizationResponse> {
	if (!input.authorizationServer.device_authorization_endpoint) {
		throw new Error(
			'This Kody server does not support `kody login --device` yet. Use `kody login` instead.',
		)
	}
	const client = cliOAuthClient(input.mcpUrl)
	const parameters = new URLSearchParams()
	parameters.set('scope', input.scope ?? defaultScopes.join(' '))
	parameters.set('resource', input.mcpUrl)
	if (input.org !== undefined) parameters.set('org', orgSlugFromFlag(input.org))
	const response = await oauth.deviceAuthorizationRequest(
		input.authorizationServer,
		client,
		oauth.None(),
		parameters,
		{
			...insecure(input.authorizationServer.issuer),
			[oauth.customFetch]: fetchFrom(input.fetchFn),
		},
	)
	return oauth.processDeviceAuthorizationResponse(
		input.authorizationServer,
		client,
		response,
	)
}

/** Terminal device-grant outcomes, as readable errors. */
export function deviceGrantErrorMessage(code: string): string | null {
	switch (code) {
		case 'access_denied':
			return 'The sign-in was denied in the browser. Run `kody login --device` to try again.'
		case 'expired_token':
			return 'The sign-in code expired before it was approved. Run `kody login --device` to get a new code.'
		case 'invalid_grant':
			return 'The sign-in code is no longer valid. Run `kody login --device` to get a new code.'
		case 'unauthorized_client':
			return 'This Kody server does not allow device sign-in for the CLI.'
		default:
			return null
	}
}

/**
 * RFC 8628 section 3.4/3.5: poll the token endpoint at the server's interval,
 * adding five seconds on every `slow_down`, until approval, denial, or expiry.
 */
export async function pollDeviceAuthorization(input: {
	authorizationServer: oauth.AuthorizationServer
	mcpUrl: string
	deviceCode: string
	intervalSeconds: number
	expiresInSeconds: number
	fetchFn?: typeof fetch
	now?: () => number
	sleep?: (ms: number) => Promise<void>
}): Promise<OAuthTokenSet> {
	const client = cliOAuthClient(input.mcpUrl)
	const now = input.now ?? Date.now
	const sleep =
		input.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
	const deadline = now() + input.expiresInSeconds * 1000
	let intervalSeconds = Math.max(5, input.intervalSeconds)
	const resource = new URLSearchParams()
	resource.set('resource', input.mcpUrl)
	while (true) {
		await sleep(intervalSeconds * 1000)
		if (now() >= deadline) {
			throw new Error(deviceGrantErrorMessage('expired_token') ?? 'expired')
		}
		const response = await oauth.deviceCodeGrantRequest(
			input.authorizationServer,
			client,
			oauth.None(),
			input.deviceCode,
			{
				...insecure(input.authorizationServer.issuer),
				[oauth.customFetch]: fetchFrom(input.fetchFn),
				additionalParameters: resource,
			},
		)
		try {
			const tokens = await oauth.processDeviceCodeResponse(
				input.authorizationServer,
				client,
				response,
			)
			return tokenSetFromResult(input.authorizationServer.issuer, tokens)
		} catch (error) {
			if (!(error instanceof oauth.ResponseBodyError)) throw error
			if (error.error === 'authorization_pending') continue
			if (error.error === 'slow_down') {
				intervalSeconds += 5
				continue
			}
			throw new Error(
				deviceGrantErrorMessage(error.error) ??
					`Device sign-in failed: ${error.error_description ?? error.error}`,
			)
		}
	}
}
