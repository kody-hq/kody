import { useServerFn } from '@tanstack/react-start'
import {
	readConnectIntegration,
	readConnectChooser,
} from '#start/server/connect-integration'
import {
	connectOAuth,
	exchangeOAuthToken,
	pollDeviceConnect,
	saveOAuthApp,
	startDeviceConnect,
} from '#start/server/account-mutations'
import {
	normalizeProviderKey,
	safeParseHost,
} from '@kody-internal/shared/url-hosts.ts'
import { type ConnectOauthLoaderData } from '#universal/loader-data.ts'
import { isConnectOauthCallbackUrl } from '#universal/oauth-connect.ts'
import { readOrgSlugFromUrl } from '#universal/org-binding/url.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import {
	cardCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	insetCardCss,
	pageEyebrowCss,
	pageHeaderCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import { accountDisclosureCss } from './account-management-components.tsx'
import {
	type ConnectOauthConfig,
	type ConnectOauthQueryConfig,
	createCodeChallenge,
	createCodeVerifier,
	isSafeExternalUrl,
	normalizeHosts,
	parseAllowedHosts,
	parseExtraParams,
	parseOptionalBoolean,
	parseOptionalUrl,
	parseProviderSetupInstructions,
	parseScopes,
	parseSessionConnectOauthConfig,
	parseTokenExchangeStyle,
} from '#client/routes/connect-oauth-config.ts'

export type ConnectOauthStatusTone = 'info' | 'warn' | 'error'
export type ConnectOauthStep =
	| 'setup'
	| 'connect'
	| 'device'
	| 'callback'
	| 'success'

export type ConnectOauthDeviceStartResult =
	| {
			ok: true
			sessionId: string
			userCode: string
			verificationUri: string
			verificationUriComplete: string | null
			expiresIn: number
			interval: number
	  }
	| { ok: false; error: string }

export type ConnectOauthDevicePollResult =
	| {
			ok: true
			status: 'authorization_pending' | 'slow_down'
			interval: number
			expiresIn: number
	  }
	| {
			ok: true
			status: 'approved'
			accessTokenSaved: boolean
			refreshTokenSaved: boolean
			hostApprovalLinks: unknown
			nextSteps: unknown
	  }
	| {
			ok: false
			status:
				| 'access_denied'
				| 'expired_token'
				| 'invalid_session'
				| 'rate_limited'
				| 'provider_error'
				| 'persist_failed'
				| 'unknown'
			error: string
	  }

type OAuthExchangeResult =
	| { ok: true; data: Record<string, unknown>; status: number }
	| { ok: false; status: number; error: string }

type SaveOauthAppResult =
	| { ok: true; clientId: string }
	| { ok: false; error: string }

export type OAuthCallback =
	| { kind: 'none' }
	| { kind: 'error'; error: string; description: string | null }
	| { kind: 'success'; code: string; state: string | null }

// These operations run imperatively during setup and callback completion.
// Start owns redirects before the page's normal error handling sees failures.
export function useConnectOauthOperations() {
	return {
		readIntegration: useServerFn(readConnectIntegration),
		readChooser: useServerFn(readConnectChooser),
		saveApp: useServerFn(saveConnectOauthApp),
		exchangeCode: useServerFn(exchangeConnectOauthCode),
		saveConnection: useServerFn(saveConnectOauthConnection),
	}
}

export type ConnectOauthQueryConfigResult =
	| { ok: true; value: ConnectOauthQueryConfig }
	| { ok: false; error: string }

export type ConnectOauthChooserOption = NonNullable<
	ConnectOauthLoaderData['chooser']
>['options'][number]

const connectOauthConfigStorageKey = 'connect-oauth:config'
const connectOauthOrgStorageKey = 'connect-oauth:org'

const reservedAuthorizeParams = new Set([
	'client_id',
	'code_challenge',
	'code_challenge_method',
	'redirect_uri',
	'response_type',
	'scope',
	'state',
])

/**
 * Destination org for `/connect/oauth`. The redirect URI stays org-less; the
 * creation handoff mirrors `org` in sessionStorage only for the in-flight
 * provider round-trip. Fresh visits use the URL alone (or the signup org).
 */
export function persistConnectOauthOrgSlug(orgSlug: string | null) {
	if (typeof window === 'undefined') return
	try {
		if (!orgSlug) {
			sessionStorage.removeItem(connectOauthOrgStorageKey)
			return
		}
		sessionStorage.setItem(connectOauthOrgStorageKey, orgSlug)
	} catch {
		// Org caching is best-effort; fetches without it stay on the signup org.
	}
}

function readStoredConnectOauthOrgSlug(): string | null {
	if (typeof window === 'undefined') return null
	try {
		const raw = sessionStorage.getItem(connectOauthOrgStorageKey)?.trim()
		return raw || null
	} catch {
		return null
	}
}

/**
 * Explicit `?org=` wins. Storage is only consulted on the provider callback
 * (registered redirect URI has no org), so a later org-less visit cannot
 * inherit a previous team handoff.
 */
export function readConnectOauthOrgSlug(url: URL): string | null {
	const fromUrl = readOrgSlugFromUrl(url)
	if (fromUrl) return fromUrl
	if (isConnectOauthCallbackUrl(url)) {
		return readStoredConnectOauthOrgSlug()
	}
	return null
}

/** Drop code/error from the URL while keeping the handoff `org` for account binds. */
export function connectOauthCallbackHref(
	ssrRedirectUri: string | null,
	orgSlug: string | null,
) {
	const clean = new URL(
		getConnectOauthRedirectUri(ssrRedirectUri),
		window.location.origin,
	)
	if (orgSlug) clean.searchParams.set('org', orgSlug)
	return `${clean.pathname}${clean.search}`
}

async function saveConnectOauthConnection(input: {
	config: ConnectOauthConfig
	callbackUrl: string
	tokenPayload: Record<string, unknown>
	orgSlug: string | null
}): Promise<
	| {
			ok: true
			accessTokenSaved: boolean
			refreshTokenSaved: boolean
			nextSteps: unknown
	  }
	| { ok: false; error: string }
> {
	const { config, orgSlug } = input
	const payload = (await connectOAuth({
		data: {
			orgSlug: orgSlug ?? undefined,
			fields: {
				provider: config.provider,
				...(config.platformAppSlug
					? { platformAppSlug: config.platformAppSlug }
					: {}),
				authorizeUrl: config.authorizeUrl,
				...(config.deviceAuthorizationUrl
					? { deviceAuthorizationUrl: config.deviceAuthorizationUrl }
					: {}),
				tokenUrl: config.tokenUrl,
				apiBaseUrl: config.apiBaseUrl,
				scopes: config.scopes,
				scopeSeparator: config.scopeSeparator,
				extraAuthorizeParams: config.extraAuthorizeParams,
				flow: config.flow,
				usePkce: config.usePkce,
				tokenExchangeStyle: config.tokenExchangeStyle,
				clientId: config.clientId,
				allowedHosts: config.allowedHosts,
				tokenPayload: input.tokenPayload,
			},
		},
	})) as Record<string, unknown>

	return {
		ok: true,
		accessTokenSaved: payload.accessTokenSaved === true,
		refreshTokenSaved: payload.refreshTokenSaved === true,
		nextSteps: payload.nextSteps,
	}
}

/** Keep the page's org on chooser links from org-less integrations.json. */
export function withConnectOauthChooserOrg(
	options: ReadonlyArray<ConnectOauthChooserOption>,
	orgSlug: string | null,
): Array<ConnectOauthChooserOption> {
	if (!orgSlug) return [...options]
	return options.map((option) => {
		const url = new URL(option.href, 'https://kody.local')
		url.searchParams.set('org', orgSlug)
		return { ...option, href: `${url.pathname}${url.search}` }
	})
}

export function readConnectOauthQueryConfig(
	url: URL,
): ConnectOauthQueryConfigResult {
	const readRequired = (key: string) => {
		const value = url.searchParams.get(key)
		return value && value.trim() ? value.trim() : null
	}
	const readOptional = (key: string) => {
		const value = url.searchParams.get(key)
		return value && value.trim() ? value.trim() : null
	}
	const provider = readRequired('provider')
	const authorizeUrl = readOptional('authorizeUrl')
	const deviceAuthorizationUrlRaw = readOptional('deviceAuthorizationUrl')
	const tokenUrl = readOptional('tokenUrl')
	const apiBaseUrl = parseOptionalUrl(readOptional('apiBaseUrl'))
	if (!provider) {
		return {
			ok: false,
			error: 'Missing required OAuth configuration parameters.',
		}
	}
	const authorizeHost = authorizeUrl ? safeParseHost(authorizeUrl) : null
	if (authorizeUrl && (!isSafeExternalUrl(authorizeUrl) || !authorizeHost)) {
		return { ok: false, error: 'Authorize URL must be valid.' }
	}
	let deviceAuthorizationUrl: string | null = null
	if (deviceAuthorizationUrlRaw) {
		if (!isSafeExternalUrl(deviceAuthorizationUrlRaw)) {
			return { ok: false, error: 'Device authorization URL must be valid.' }
		}
		deviceAuthorizationUrl = deviceAuthorizationUrlRaw
	}
	const tokenHost = tokenUrl ? safeParseHost(tokenUrl) : null
	if (tokenUrl && !tokenHost) {
		return { ok: false, error: 'Token URL must be valid when provided.' }
	}
	const rawFlow = readOptional('flow')?.toLowerCase() ?? null
	const flow =
		rawFlow === 'pkce' || rawFlow === 'confidential' || rawFlow === 'device'
			? rawFlow
			: null
	const usePkce = parseOptionalBoolean(readOptional('pkce'))
	const tokenExchangeStyle = parseTokenExchangeStyle(
		readOptional('tokenExchangeStyle'),
	)
	const rawScopes = readOptional('scopes')
	const scopes = rawScopes == null ? null : parseScopes(rawScopes)
	const scopeSeparator = readOptional('scopeSeparator')
	const rawExtraAuthorizeParams = readOptional('extraAuthorizeParams')
	const extraAuthorizeParams =
		rawExtraAuthorizeParams == null
			? null
			: parseExtraParams(rawExtraAuthorizeParams)
	const dashboardUrl = parseOptionalUrl(readOptional('dashboardUrl'))
	const loginHint = readOptional('loginHint')
	const providerKey = normalizeProviderKey(provider)
	if (!providerKey) {
		return { ok: false, error: 'Provider must contain letters or numbers.' }
	}
	const providerSetupInstructions = parseProviderSetupInstructions(
		readOptional('providerSetupInstructions'),
	)
	const deviceHost = deviceAuthorizationUrl
		? safeParseHost(deviceAuthorizationUrl)
		: null
	const allowedHosts = normalizeHosts([
		...(tokenHost ? [tokenHost] : []),
		...(deviceHost ? [deviceHost] : []),
		...parseAllowedHosts(readOptional('allowedHosts')),
	])
	return {
		ok: true,
		value: {
			provider,
			providerKey,
			authorizeHost:
				authorizeHost ||
				(deviceAuthorizationUrl ? safeParseHost(deviceAuthorizationUrl) : null),
			authorizeUrl,
			deviceAuthorizationUrl,
			tokenUrl,
			apiBaseUrl,
			scopes,
			flow,
			usePkce,
			tokenExchangeStyle,
			scopeSeparator,
			extraAuthorizeParams,
			providerSetupInstructions,
			dashboardUrl,
			allowedHosts,
			loginHint,
		},
	}
}

export function readConnectOauthCallback(search?: string): OAuthCallback {
	if (search === undefined && typeof window === 'undefined')
		return { kind: 'none' }
	const params = new URLSearchParams(search ?? window.location.search)
	const error = params.get('error')
	const description = params.get('error_description')
	if (error) {
		return { kind: 'error', error, description }
	}
	const code = params.get('code')
	if (!code) return { kind: 'none' }
	return { kind: 'success', code, state: params.get('state') }
}

export function getConnectOauthRedirectUri(ssrRedirectUri: string | null) {
	if (typeof window === 'undefined') return ssrRedirectUri ?? ''
	return `${window.location.origin}${window.location.pathname}`
}

export function getConnectOauthStateKey(providerKey: string) {
	return `connect-oauth:${providerKey}`
}

function getConnectOauthPkceKey(providerKey: string) {
	return `connect-oauth:${providerKey}:pkce`
}

export function persistConnectOauthConfig(nextConfig: ConnectOauthConfig) {
	try {
		sessionStorage.setItem(
			connectOauthConfigStorageKey,
			JSON.stringify(nextConfig),
		)
	} catch {
		// Config caching is best-effort; the required OAuth state write below still fails visibly.
	}
}

export function readStoredConnectOauthConfig(): ConnectOauthConfig | null {
	if (typeof window === 'undefined') return null
	const raw = sessionStorage.getItem(connectOauthConfigStorageKey)
	if (!raw) return null
	return parseSessionConnectOauthConfig(raw)
}

function createConnectOauthState(key: string) {
	const value = crypto.randomUUID()
	sessionStorage.setItem(key, value)
	return value
}

export function validateConnectOauthState(
	key: string,
	returned: string | null,
) {
	const expected = sessionStorage.getItem(key)
	return Boolean(expected && returned && expected === returned)
}

export async function buildConnectOauthAuthorizeUrl(input: {
	config: ConnectOauthConfig
	hasConfigError: boolean
	redirectUri: string
}) {
	if (input.hasConfigError) {
		throw new Error('Unable to start OAuth with invalid configuration.')
	}
	persistConnectOauthConfig(input.config)
	if (!input.config.authorizeUrl) {
		throw new Error('Authorize URL is required for this OAuth flow.')
	}
	const url = new URL(input.config.authorizeUrl)
	url.searchParams.set('response_type', 'code')
	const clientId = input.config.clientId.trim()
	if (!clientId) {
		throw new Error('Missing client ID. Save it before connecting.')
	}
	url.searchParams.set('client_id', clientId)
	url.searchParams.set('redirect_uri', input.redirectUri)
	if (input.config.scopes.length > 0) {
		url.searchParams.set(
			'scope',
			input.config.scopes.join(input.config.scopeSeparator),
		)
	}
	const state = createConnectOauthState(
		getConnectOauthStateKey(input.config.providerKey),
	)
	url.searchParams.set('state', state)
	if (input.config.usePkce) {
		const verifier = createCodeVerifier()
		sessionStorage.setItem(
			getConnectOauthPkceKey(input.config.providerKey),
			verifier,
		)
		const challenge = await createCodeChallenge(verifier)
		url.searchParams.set('code_challenge_method', 'S256')
		url.searchParams.set('code_challenge', challenge)
	}
	for (const [key, value] of Object.entries(
		input.config.extraAuthorizeParams,
	)) {
		if (!key) continue
		if (reservedAuthorizeParams.has(key.toLowerCase())) continue
		url.searchParams.set(key, value)
	}
	return url.toString()
}

async function exchangeConnectOauthCode(
	nextConfig: ConnectOauthConfig,
	code: string,
	redirectUri: string,
	orgSlug: string | null = null,
): Promise<OAuthExchangeResult> {
	const params = new URLSearchParams()
	params.set('grant_type', 'authorization_code')
	const clientId = nextConfig.clientId.trim()
	if (!clientId) {
		return { ok: false, status: 0, error: 'Missing client ID.' }
	}
	params.set('client_id', clientId)
	params.set('code', code)
	params.set('redirect_uri', redirectUri)
	if (nextConfig.usePkce) {
		const verifier = sessionStorage.getItem(
			getConnectOauthPkceKey(nextConfig.providerKey),
		)
		if (!verifier) {
			return { ok: false, status: 0, error: 'Missing PKCE verifier.' }
		}
		params.set('code_verifier', verifier)
	}
	const payload = (await exchangeOAuthToken({
		data: {
			orgSlug: orgSlug ?? undefined,
			fields: {
				tokenUrl: nextConfig.tokenUrl,
				params: params.toString(),
				flow: nextConfig.flow,
				tokenExchangeStyle: nextConfig.tokenExchangeStyle,
				provider: nextConfig.provider,
				allowedHosts: nextConfig.allowedHosts,
				...(nextConfig.platformAppSlug
					? { platformAppSlug: nextConfig.platformAppSlug }
					: {}),
			},
		},
	})) as Record<string, unknown>
	return { ok: true, data: payload, status: 200 }
}

async function saveConnectOauthApp(
	nextConfig: ConnectOauthConfig,
	clientSecret?: string,
	orgSlug: string | null = null,
): Promise<SaveOauthAppResult> {
	const payload = (await saveOAuthApp({
		data: {
			orgSlug: orgSlug ?? undefined,
			fields: {
				provider: nextConfig.provider,
				authorizeUrl: nextConfig.authorizeUrl,
				...(nextConfig.deviceAuthorizationUrl
					? { deviceAuthorizationUrl: nextConfig.deviceAuthorizationUrl }
					: {}),
				tokenUrl: nextConfig.tokenUrl,
				apiBaseUrl: nextConfig.apiBaseUrl,
				flow: nextConfig.flow,
				usePkce: nextConfig.usePkce,
				tokenExchangeStyle: nextConfig.tokenExchangeStyle,
				clientId: nextConfig.clientId,
				...(clientSecret ? { clientSecret } : {}),
				scopeSeparator: nextConfig.scopeSeparator,
				extraAuthorizeParams: nextConfig.extraAuthorizeParams,
			},
		},
	})) as Record<string, unknown>

	const savedClientId =
		payload.app &&
		typeof payload.app === 'object' &&
		'clientId' in payload.app &&
		typeof payload.app.clientId === 'string'
			? payload.app.clientId
			: null
	if (!savedClientId) {
		return { ok: false, error: 'Unable to save OAuth app configuration.' }
	}
	return { ok: true, clientId: savedClientId }
}

/**
 * Start RFC 8628 device authorization. Never logs or returns `device_code`.
 */
export async function startConnectOauthDevice(input: {
	config: ConnectOauthConfig
	orgSlug: string | null
}): Promise<ConnectOauthDeviceStartResult> {
	const { config, orgSlug } = input
	try {
		const payload = (await startDeviceConnect({
			data: {
				orgSlug: orgSlug ?? undefined,
				fields: {
					provider: config.provider,
					...(config.platformAppSlug
						? { platformAppSlug: config.platformAppSlug }
						: {}),
					authorizeUrl: config.authorizeUrl,
					deviceAuthorizationUrl: config.deviceAuthorizationUrl,
					tokenUrl: config.tokenUrl,
					apiBaseUrl: config.apiBaseUrl,
					scopes: config.scopes,
					scopeSeparator: config.scopeSeparator,
					extraAuthorizeParams: config.extraAuthorizeParams,
					usePkce: config.usePkce,
					tokenExchangeStyle: config.tokenExchangeStyle,
					clientId: config.clientId,
					allowedHosts: config.allowedHosts,
				},
			},
		})) as Record<string, unknown>
		if (payload.ok === false) {
			return {
				ok: false,
				error:
					typeof payload.error === 'string'
						? payload.error
						: 'Unable to start device authorization.',
			}
		}
		if (
			typeof payload.sessionId !== 'string' ||
			typeof payload.userCode !== 'string' ||
			typeof payload.verificationUri !== 'string' ||
			typeof payload.expiresIn !== 'number' ||
			typeof payload.interval !== 'number'
		) {
			return { ok: false, error: 'Unable to start device authorization.' }
		}
		return {
			ok: true,
			sessionId: payload.sessionId,
			userCode: payload.userCode,
			verificationUri: payload.verificationUri,
			verificationUriComplete:
				typeof payload.verificationUriComplete === 'string'
					? payload.verificationUriComplete
					: null,
			expiresIn: payload.expiresIn,
			interval: payload.interval,
		}
	} catch (error) {
		return {
			ok: false,
			error:
				error instanceof Error
					? error.message
					: 'Unable to start device authorization.',
		}
	}
}

/**
 * Poll device authorization. Never logs or returns `device_code`.
 */
export async function pollConnectOauthDevice(input: {
	sessionId: string
	orgSlug: string | null
}): Promise<ConnectOauthDevicePollResult> {
	try {
		const payload = (await pollDeviceConnect({
			data: {
				orgSlug: input.orgSlug ?? undefined,
				fields: { sessionId: input.sessionId },
			},
		})) as Record<string, unknown>
		if (payload.ok === false) {
			const status = typeof payload.status === 'string' ? payload.status : null
			const failureStatus =
				status === 'access_denied' ||
				status === 'expired_token' ||
				status === 'invalid_session' ||
				status === 'rate_limited' ||
				status === 'provider_error' ||
				status === 'persist_failed'
					? status
					: 'unknown'
			return {
				ok: false,
				status: failureStatus,
				error:
					typeof payload.error === 'string'
						? payload.error
						: 'Unable to poll device authorization.',
			}
		}
		const status = typeof payload.status === 'string' ? payload.status : null
		if (status === 'authorization_pending' || status === 'slow_down') {
			return {
				ok: true,
				status,
				interval: typeof payload.interval === 'number' ? payload.interval : 5,
				expiresIn:
					typeof payload.expiresIn === 'number' ? payload.expiresIn : 0,
			}
		}
		if (status === 'approved') {
			return {
				ok: true,
				status: 'approved',
				accessTokenSaved: payload.accessTokenSaved === true,
				refreshTokenSaved: payload.refreshTokenSaved === true,
				hostApprovalLinks: payload.hostApprovalLinks,
				nextSteps: payload.nextSteps,
			}
		}
		const failureStatus =
			status === 'access_denied' ||
			status === 'expired_token' ||
			status === 'invalid_session' ||
			status === 'rate_limited' ||
			status === 'provider_error' ||
			status === 'persist_failed'
				? status
				: 'unknown'
		return {
			ok: false,
			status: failureStatus,
			error:
				typeof payload.error === 'string'
					? payload.error
					: 'Unable to poll device authorization.',
		}
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: 'Unable to poll device authorization.'
		const lower = message.toLowerCase()
		const status = lower.includes('denied')
			? 'access_denied'
			: lower.includes('expired')
				? 'expired_token'
				: lower.includes('invalid session') || lower.includes('session')
					? 'invalid_session'
					: lower.includes('persist')
						? 'persist_failed'
						: lower.includes('rate')
							? 'rate_limited'
							: 'unknown'
		return { ok: false, status, error: message }
	}
}

export const connectOauthPageCss = {
	...stackedPageCss,
	maxWidth: '32rem',
	margin: '0 auto',
}

export const connectOauthHeaderCss = {
	...pageHeaderCss,
	justifyItems: 'center',
	textAlign: 'center' as const,
}

export const connectOauthEyebrowCss = pageEyebrowCss

export const connectOauthAdvancedDetailsCss = {
	...accountDisclosureCss,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

export const connectOauthRedirectUriCardCss = {
	...cardCss,
	border: `1px solid ${colors.primary}`,
}

export const connectOauthRedirectUriValueCss = {
	...insetCardCss,
	margin: 0,
	whiteSpace: 'pre-wrap' as const,
	wordBreak: 'break-all' as const,
	fontFamily: 'monospace',
	fontSize: typography.fontSize.base,
	fontWeight: typography.fontWeight.medium,
}

export const connectOauthPrimaryButtonCss = getPrimaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})

export const connectOauthSecondaryButtonCss = getSecondaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})
