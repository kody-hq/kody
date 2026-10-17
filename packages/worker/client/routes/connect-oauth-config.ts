import {
	base64UrlToBytes,
	bytesToBase64Url,
} from '@kody-internal/shared/base64.ts'
import {
	normalizeProviderKey,
	safeParseHost,
} from '@kody-internal/shared/url-hosts.ts'
import { isBrowserFetchNetworkError } from '#client/browser-fetch-network-error.ts'
import { type AccountIntegrationListItem } from '#universal/loader-data.ts'

export type OAuthFlow = 'pkce' | 'confidential' | 'device'
export type TokenExchangeStyle = 'form' | 'basic-json' | 'basic-form'

export type ConnectOauthQueryConfig = {
	provider: string
	providerKey: string
	authorizeHost: string | null
	authorizeUrl: string | null
	deviceAuthorizationUrl: string | null
	tokenUrl: string | null
	apiBaseUrl: string | null
	scopes: Array<string> | null
	flow: OAuthFlow | null
	usePkce: boolean | null
	tokenExchangeStyle: TokenExchangeStyle | null
	scopeSeparator: string | null
	extraAuthorizeParams: Record<string, string> | null
	providerSetupInstructions: string | null
	dashboardUrl: string | null
	allowedHosts: Array<string>
	/** Prefills Google/OIDC account chooser without replacing stored extra params. */
	loginHint?: string | null
}

export type ConnectOauthConfig = {
	provider: string
	providerKey: string
	authorizeHost: string
	tokenHost: string
	authorizeUrl: string | null
	deviceAuthorizationUrl: string | null
	tokenUrl: string
	apiBaseUrl: string | null
	scopes: Array<string>
	flow: OAuthFlow
	/**
	 * PKCE is orthogonal to `flow`: providers like Canva require S256 PKCE
	 * *and* a client secret on token exchange.
	 */
	usePkce: boolean
	tokenExchangeStyle: TokenExchangeStyle
	scopeSeparator: string
	extraAuthorizeParams: Record<string, string>
	providerSetupInstructions: string | null
	dashboardUrl: string | null
	clientId: string
	hasClientSecret: boolean
	allowedHosts: Array<string>
	/**
	 * Set when connecting through a platform (built-in) OAuth app: the
	 * operator owns the client registration, token exchange runs host-side
	 * with the shared secret, and the client-credential setup step is skipped.
	 */
	platformAppSlug: string | null
	/** Relative path of the operator-uploaded provider logo, when present. */
	platformLogoPath: string | null
	/** Explicit user-uploaded OAuth app logo (beats catalog and favicon). */
	logoPath?: string | null
	/** Auto-fetched favicon (loses to an explicit upload or catalog mark). */
	autoLogoPath?: string | null
	/** Operator-curated provider mark (after upload, before favicon). */
	catalogLogoPath?: string | null
	/** Operator-authored provider note (limitations, caveats), when present. */
	platformDescription: string | null
	/**
	 * Operator-verified scope menu for platform apps. Empty for bring-your-own
	 * connections, where the requested list is the whole editable set.
	 */
	platformAllowedScopes: Array<string>
}

type StoredIntegrationAuthorization = NonNullable<
	NonNullable<AccountIntegrationListItem['authorization']>
>

// Server-returned integration config used to prefill reconnects.
export type StoredIntegrationConfig = Omit<
	AccountIntegrationListItem,
	| 'apiBaseUrl'
	| 'authorization'
	| 'createdAt'
	| 'requiredHosts'
	| 'updatedAt'
	| 'appSlug'
	| 'provider'
	| 'appLabel'
	| 'accountLabel'
> & {
	apiBaseUrl: string | null
	hasClientSecret: boolean
	requiredHosts: Array<string>
	usePkce?: boolean | null
	/** Omitted when unset so persisted JSON stays sparse (matches pre-import shape). */
	tokenExchangeStyle?: TokenExchangeStyle | null
	authorization?: StoredIntegrationAuthorization | null
	/** Platform (built-in) app slug when the record is a platform connection or prefill. */
	platformAppSlug?: string | null
	/** Operator-verified scope menu for platform apps; requested scopes are clamped to it. */
	platformAllowedScopes?: Array<string>
	/** Relative path of the operator-uploaded provider logo. */
	platformLogoPath?: string | null
	logoPath?: string | null
	autoLogoPath?: string | null
	catalogLogoPath?: string | null
	/** Operator-authored provider note (limitations, caveats). */
	platformDescription?: string | null
	/** RFC 8628 device authorization endpoint when flow is `device`. */
	deviceAuthorizationUrl?: string | null
}

export type ConnectOauthHostApprovalLink = {
	secretName: string
	host: string
	approvalUrl: string
}

export type ConnectOauthNextSteps = {
	service: string
	connectionName: string
	prompt: string
}

export function parseScopes(raw: string | null) {
	if (!raw) return []
	const trimmed = raw.trim()
	if (!trimmed) return []
	if (trimmed.startsWith('[')) {
		try {
			const parsed = JSON.parse(trimmed)
			if (Array.isArray(parsed)) {
				return parsed.map((value) => String(value)).filter(Boolean)
			}
		} catch {
			// Invalid JSON falls back to the tolerant delimited-list parser.
		}
	}
	return trimmed
		.split(/[\s,]+/)
		.map((scope) => scope.trim())
		.filter(Boolean)
}

export function normalizeHosts(hosts: Array<string>) {
	return Array.from(
		new Set(
			hosts
				.map((host) => host.trim().toLowerCase())
				.filter((host) => host.length > 0),
		),
	).sort()
}

export function toStoredIntegrationConfig(
	integration: AccountIntegrationListItem,
): StoredIntegrationConfig {
	return {
		name: integration.name,
		tokenUrl: integration.tokenUrl,
		apiBaseUrl: integration.apiBaseUrl?.trim() || null,
		...(integration.flow ? { flow: integration.flow } : {}),
		usePkce:
			typeof integration.usePkce === 'boolean' ? integration.usePkce : null,
		clientId: integration.clientId,
		hasClientSecret: integration.hasClientSecret === true,
		requiredHosts: normalizeHosts(integration.requiredHosts ?? []),
		...(integration.tokenExchangeStyle
			? { tokenExchangeStyle: integration.tokenExchangeStyle }
			: {}),
		...(integration.deviceAuthorizationUrl
			? { deviceAuthorizationUrl: integration.deviceAuthorizationUrl }
			: {}),
		authorization: integration.authorization
			? {
					authorizeUrl: integration.authorization.authorizeUrl,
					scopes: integration.authorization.scopes,
					scopeSeparator: integration.authorization.scopeSeparator ?? null,
					extraAuthorizeParams:
						integration.authorization.extraAuthorizeParams ?? {},
				}
			: null,
		logoPath: integration.logoPath ?? null,
		autoLogoPath: integration.autoLogoPath ?? null,
		catalogLogoPath: integration.catalogLogoPath ?? null,
		...(integration.platform === true
			? {
					platformAppSlug: integration.appSlug,
					platformAllowedScopes: integration.platformAllowedScopes ?? [],
					platformLogoPath: integration.platformLogoPath ?? null,
					platformDescription: integration.platformDescription ?? null,
				}
			: {}),
	}
}

/**
 * Parses a stored/server integration payload for reconnect helpers and tests.
 * Accepts either a JSON string or an already-decoded object with inline
 * `clientId` (the first-class integrations table shape).
 */
export function parseStoredIntegrationConfig(
	raw: string | Record<string, unknown>,
	fallbackProvider: string | null,
): StoredIntegrationConfig | null {
	try {
		const parsed =
			typeof raw === 'string'
				? (JSON.parse(raw) as Record<string, unknown>)
				: raw
		const name =
			typeof parsed.name === 'string' && parsed.name.trim()
				? parsed.name.trim()
				: (fallbackProvider?.trim() ?? '')
		const tokenUrl =
			typeof parsed.tokenUrl === 'string' ? parsed.tokenUrl.trim() : ''
		const flow =
			parsed.flow === 'confidential' || parsed.flow === 'device'
				? parsed.flow
				: 'pkce'
		const usePkce = typeof parsed.usePkce === 'boolean' ? parsed.usePkce : null
		const clientId =
			typeof parsed.clientId === 'string' ? parsed.clientId.trim() : ''
		const hasClientSecret = parsed.hasClientSecret === true
		const tokenExchangeStyle = parseTokenExchangeStyle(
			parsed.tokenExchangeStyle,
		)
		const deviceAuthorizationUrl =
			typeof parsed.deviceAuthorizationUrl === 'string' &&
			parsed.deviceAuthorizationUrl.trim() &&
			isSafeExternalUrl(parsed.deviceAuthorizationUrl.trim())
				? parsed.deviceAuthorizationUrl.trim()
				: null
		const requiredHosts = Array.isArray(parsed.requiredHosts)
			? parsed.requiredHosts.filter(
					(value): value is string => typeof value === 'string',
				)
			: []
		const authorization = parseStoredIntegrationAuthorization(
			parsed.authorization,
		)
		const platformAppSlug =
			typeof parsed.platformAppSlug === 'string' &&
			parsed.platformAppSlug.trim()
				? parsed.platformAppSlug.trim()
				: null
		const platformAllowedScopes = Array.isArray(parsed.platformAllowedScopes)
			? parsed.platformAllowedScopes.filter(
					(value): value is string =>
						typeof value === 'string' && Boolean(value),
				)
			: []
		const platformLogoPath = parsePlatformLogoPath(parsed.platformLogoPath)
		const platformDescription =
			typeof parsed.platformDescription === 'string' &&
			parsed.platformDescription.trim()
				? parsed.platformDescription.trim()
				: null
		if (!name || !tokenUrl || !clientId) {
			return null
		}
		return {
			...(platformAppSlug
				? {
						platformAppSlug,
						platformAllowedScopes,
						platformLogoPath,
						platformDescription,
					}
				: {}),
			name,
			tokenUrl,
			apiBaseUrl:
				typeof parsed.apiBaseUrl === 'string' && parsed.apiBaseUrl.trim()
					? parsed.apiBaseUrl.trim()
					: null,
			flow,
			usePkce,
			clientId,
			hasClientSecret,
			requiredHosts: normalizeHosts(requiredHosts),
			...(tokenExchangeStyle ? { tokenExchangeStyle } : {}),
			...(deviceAuthorizationUrl ? { deviceAuthorizationUrl } : {}),
			authorization,
		}
	} catch {
		return null
	}
}

function parseStoredIntegrationAuthorization(
	raw: unknown,
): StoredIntegrationAuthorization | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
	const parsed = raw as Record<string, unknown>
	const authorizeUrl =
		typeof parsed.authorizeUrl === 'string' ? parsed.authorizeUrl.trim() : ''
	if (
		!authorizeUrl ||
		!isSafeExternalUrl(authorizeUrl) ||
		!safeParseHost(authorizeUrl)
	) {
		return null
	}
	const scopes = Array.isArray(parsed.scopes)
		? parsed.scopes.filter(
				(value): value is string => typeof value === 'string' && Boolean(value),
			)
		: []
	const scopeSeparator =
		typeof parsed.scopeSeparator === 'string' && parsed.scopeSeparator
			? parsed.scopeSeparator
			: null
	const extraAuthorizeParams =
		parsed.extraAuthorizeParams &&
		typeof parsed.extraAuthorizeParams === 'object' &&
		!Array.isArray(parsed.extraAuthorizeParams)
			? Object.fromEntries(
					Object.entries(parsed.extraAuthorizeParams)
						.filter(
							(entry): entry is [string, string] =>
								typeof entry[1] === 'string',
						)
						.map(([key, value]) => [key, value]),
				)
			: {}
	return {
		authorizeUrl,
		scopes,
		scopeSeparator,
		extraAuthorizeParams,
	}
}

export function mergeConnectOauthConfig(input: {
	queryConfig: ConnectOauthQueryConfig
	storedIntegration: StoredIntegrationConfig | null
}): ConnectOauthConfig | null {
	const provider =
		input.storedIntegration?.name.trim() || input.queryConfig.provider.trim()
	const providerKey = normalizeProviderKey(
		provider || input.queryConfig.providerKey,
	)
	const authorizeUrl =
		input.queryConfig.authorizeUrl ??
		input.storedIntegration?.authorization?.authorizeUrl ??
		null
	const deviceAuthorizationUrl =
		input.queryConfig.deviceAuthorizationUrl ??
		input.storedIntegration?.deviceAuthorizationUrl ??
		null
	// Empty string means "family prefill could not agree" — fall through to
	// the query/default rather than wiping a known endpoint.
	const tokenUrl =
		input.storedIntegration?.tokenUrl?.trim() ||
		input.queryConfig.tokenUrl ||
		null
	const tokenHost = tokenUrl ? safeParseHost(tokenUrl) : null
	const flow =
		input.storedIntegration?.flow ??
		input.queryConfig.flow ??
		(tokenUrl ? defaultConnectOauthFlow(tokenUrl) : 'pkce')
	const isDevice = flow === 'device'
	if (isDevice) {
		if (
			!provider ||
			!deviceAuthorizationUrl ||
			!isSafeExternalUrl(deviceAuthorizationUrl) ||
			!tokenUrl ||
			!tokenHost ||
			!providerKey
		) {
			return null
		}
		if (authorizeUrl && !isSafeExternalUrl(authorizeUrl)) {
			return null
		}
	} else if (
		!provider ||
		!authorizeUrl ||
		!isSafeExternalUrl(authorizeUrl) ||
		!tokenUrl ||
		!tokenHost ||
		!providerKey
	) {
		return null
	}
	const authorizeHost =
		(authorizeUrl ? safeParseHost(authorizeUrl) : null) ||
		(deviceAuthorizationUrl ? safeParseHost(deviceAuthorizationUrl) : null)
	if (!authorizeHost) return null
	const deviceHost = deviceAuthorizationUrl
		? safeParseHost(deviceAuthorizationUrl)
		: null
	const usePkce =
		input.queryConfig.usePkce ??
		input.storedIntegration?.usePkce ??
		defaultConnectOauthUsePkce({ flow, tokenUrl })
	const platformAppSlug = input.storedIntegration?.platformAppSlug ?? null
	const platformAllowedScopes = platformAppSlug
		? (input.storedIntegration?.platformAllowedScopes ?? [])
		: null
	// Platform apps clamp requested scopes to the operator-verified menu, so
	// query-supplied scopes can never widen the authorize request. The server
	// re-validates before persisting anything.
	const scopes =
		platformAllowedScopes === null
			? resolveConnectOauthScopes(input)
			: resolveConnectOauthScopes(input).filter((scope) =>
					platformAllowedScopes.includes(scope),
				)
	const extraAuthorizeParams = {
		...resolveConnectOauthExtraAuthorizeParams(input),
	}
	const loginHint = input.queryConfig.loginHint?.trim()
	if (loginHint) {
		extraAuthorizeParams.login_hint = loginHint
	}
	const allowedHosts = normalizeHosts([
		tokenHost,
		...(deviceHost ? [deviceHost] : []),
		...input.queryConfig.allowedHosts,
		...(input.storedIntegration?.requiredHosts ?? []),
	])
	if (allowedHosts.length === 0) return null
	return {
		platformAppSlug,
		platformLogoPath: platformAppSlug
			? parsePlatformLogoPath(input.storedIntegration?.platformLogoPath)
			: null,
		logoPath: input.storedIntegration?.logoPath?.trim() || null,
		autoLogoPath: input.storedIntegration?.autoLogoPath?.trim() || null,
		catalogLogoPath: input.storedIntegration?.catalogLogoPath?.trim() || null,
		platformDescription: platformAppSlug
			? input.storedIntegration?.platformDescription?.trim() || null
			: null,
		platformAllowedScopes: platformAllowedScopes ?? [],
		provider,
		providerKey,
		authorizeHost,
		tokenHost,
		authorizeUrl,
		deviceAuthorizationUrl,
		tokenUrl,
		apiBaseUrl:
			input.storedIntegration?.apiBaseUrl ?? input.queryConfig.apiBaseUrl,
		scopes,
		flow,
		usePkce,
		tokenExchangeStyle: resolveConnectOauthTokenExchangeStyle({
			tokenUrl,
			queryStyle: input.queryConfig.tokenExchangeStyle,
			storedStyle: input.storedIntegration?.tokenExchangeStyle ?? null,
		}),
		scopeSeparator:
			input.queryConfig.scopeSeparator ??
			input.storedIntegration?.authorization?.scopeSeparator ??
			' ',
		extraAuthorizeParams,
		providerSetupInstructions: input.queryConfig.providerSetupInstructions,
		dashboardUrl: input.queryConfig.dashboardUrl,
		clientId: input.storedIntegration?.clientId?.trim() || '',
		hasClientSecret: input.storedIntegration?.hasClientSecret === true,
		allowedHosts,
	}
}

function resolveConnectOauthScopes(input: {
	queryConfig: ConnectOauthQueryConfig
	storedIntegration: StoredIntegrationConfig | null
}) {
	if (input.queryConfig.scopes && input.queryConfig.scopes.length > 0) {
		return input.queryConfig.scopes
	}
	return input.storedIntegration?.authorization?.scopes ?? []
}

function resolveConnectOauthExtraAuthorizeParams(input: {
	queryConfig: ConnectOauthQueryConfig
	storedIntegration: StoredIntegrationConfig | null
}) {
	const queryParams = input.queryConfig.extraAuthorizeParams
	if (queryParams && Object.keys(queryParams).length > 0) {
		return queryParams
	}
	return input.storedIntegration?.authorization?.extraAuthorizeParams ?? {}
}

/**
 * Parses the sessionStorage config persisted before redirecting to the
 * provider. Validation is deliberately strict with no back-compat for older
 * shapes: the snapshot lives for a single authorize round trip, so a stale
 * shape can only exist for a flow in-flight across a deploy, and the recovery
 * is simply restarting the connect flow from its URL.
 */
export function parseSessionConnectOauthConfig(
	raw: string,
): ConnectOauthConfig | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== 'object') return null
	const record = parsed as Record<string, unknown>
	const flowOk =
		record.flow === 'pkce' ||
		record.flow === 'confidential' ||
		record.flow === 'device'
	const authorizeUrlOk =
		record.authorizeUrl == null || typeof record.authorizeUrl === 'string'
	const deviceUrlOk =
		record.deviceAuthorizationUrl == null ||
		typeof record.deviceAuthorizationUrl === 'string'
	const deviceRequiresDeviceUrl =
		record.flow !== 'device' ||
		(typeof record.deviceAuthorizationUrl === 'string' &&
			Boolean(record.deviceAuthorizationUrl.trim()))
	const codeFlowRequiresAuthorize =
		record.flow === 'device' ||
		(typeof record.authorizeUrl === 'string' &&
			Boolean(record.authorizeUrl.trim()))
	const isValid =
		typeof record.provider === 'string' &&
		typeof record.providerKey === 'string' &&
		authorizeUrlOk &&
		deviceUrlOk &&
		deviceRequiresDeviceUrl &&
		codeFlowRequiresAuthorize &&
		typeof record.tokenUrl === 'string' &&
		typeof record.authorizeHost === 'string' &&
		typeof record.tokenHost === 'string' &&
		flowOk &&
		typeof record.usePkce === 'boolean' &&
		typeof record.scopeSeparator === 'string' &&
		typeof record.clientId === 'string' &&
		Array.isArray(record.scopes) &&
		Array.isArray(record.allowedHosts) &&
		record.scopes.every((value) => typeof value === 'string') &&
		record.allowedHosts.every((value) => typeof value === 'string') &&
		(record.platformAppSlug == null ||
			typeof record.platformAppSlug === 'string')
	if (!isValid) return null
	return {
		...(record as unknown as ConnectOauthConfig),
		authorizeUrl:
			typeof record.authorizeUrl === 'string' ? record.authorizeUrl : null,
		deviceAuthorizationUrl:
			typeof record.deviceAuthorizationUrl === 'string'
				? record.deviceAuthorizationUrl
				: null,
		hasClientSecret: record.hasClientSecret === true,
		platformAppSlug:
			typeof record.platformAppSlug === 'string'
				? record.platformAppSlug
				: null,
		platformLogoPath: parsePlatformLogoPath(record.platformLogoPath),
		logoPath: parsePlatformLogoPath(record.logoPath),
		autoLogoPath: parsePlatformLogoPath(record.autoLogoPath),
		catalogLogoPath: parseCatalogLogoPath(record.catalogLogoPath),
		platformDescription:
			typeof record.platformDescription === 'string' &&
			record.platformDescription.trim()
				? record.platformDescription.trim()
				: null,
		platformAllowedScopes: Array.isArray(record.platformAllowedScopes)
			? record.platformAllowedScopes.filter(
					(value): value is string =>
						typeof value === 'string' && Boolean(value.trim()),
				)
			: [],
	}
}

const sameOriginLogoSlug = '[A-Za-z0-9._~%-]+'
const sameOriginLogoCacheTag = '(?:\\?v=[0-9a-f]{1,64})?'

function parseSameOriginLogoPath(raw: unknown, pattern: RegExp): string | null {
	if (typeof raw !== 'string') return null
	return pattern.test(raw) ? raw : null
}

/**
 * Logo paths render as <img src>; only same-origin serving paths from the
 * integration-logo route are accepted — one clean slug segment plus an
 * optional cache tag, so tampered session snapshots cannot point the img at
 * other same-origin paths via `..` or extra segments.
 */
function parsePlatformLogoPath(raw: unknown): string | null {
	return parseSameOriginLogoPath(
		raw,
		new RegExp(
			`^/integrations/logos/${sameOriginLogoSlug}${sameOriginLogoCacheTag}$`,
		),
	)
}

/**
 * Operator catalog marks live on `/integrations/provider-marks/:slug`, not
 * the per-app logo route. Session restore must keep those paths or the
 * connect callback falls back to the letter after the provider redirect.
 */
function parseCatalogLogoPath(raw: unknown): string | null {
	return parseSameOriginLogoPath(
		raw,
		new RegExp(
			`^/integrations/provider-marks/${sameOriginLogoSlug}${sameOriginLogoCacheTag}$`,
		),
	)
}

export function summarizeStoredSetupState(input: {
	flow: OAuthFlow
	clientId: string | null
	hasStoredClientSecret: boolean
	platform?: boolean
}) {
	// Platform (built-in) apps need no user-provided credentials: the
	// operator registered the app and the shared secret stays server-side.
	if (input.platform === true) {
		return { missingFields: [], isReady: true }
	}
	const missingFields: Array<string> = []
	if (!input.clientId?.trim()) missingFields.push('client ID')
	// Device grant allows public clients (no secret). Confidential still
	// requires a stored client secret.
	if (input.flow === 'confidential' && !input.hasStoredClientSecret) {
		missingFields.push('client secret')
	}
	return {
		missingFields,
		isReady: missingFields.length === 0,
	}
}

/**
 * Map caught client errors to in-page status text. Network fetch TypeErrors
 * become a stable UX string so they never need to escape as unhandledrejection.
 */
export function formatConnectOauthCaughtError(
	error: unknown,
	fallback: string,
): string {
	if (isBrowserFetchNetworkError(error)) {
		return 'Network error. Please try again.'
	}
	const message = error instanceof Error ? error.message.trim() : ''
	if (message) return message
	return fallback
}

/**
 * Distinguish real Kody session expiry (401 Unauthorized) from provider token
 * exchange failures that historically leaked through as HTTP 401.
 */
export function formatOAuthExchangeFailure(input: {
	status: number
	data: Record<string, unknown> | null
}): { treatAsSessionExpired: boolean; error: string } {
	if (isOAuthExchangeSessionExpired(input)) {
		return { treatAsSessionExpired: true, error: 'Session expired.' }
	}
	const errorDescription =
		typeof input.data?.error_description === 'string' &&
		input.data.error_description.trim()
			? input.data.error_description.trim()
			: typeof input.data?.error === 'string' && input.data.error.trim()
				? input.data.error.trim()
				: null
	return {
		treatAsSessionExpired: false,
		error: errorDescription ?? 'Token exchange failed.',
	}
}

export function isOAuthExchangeSessionExpired(input: {
	status: number
	data: Record<string, unknown> | null
}) {
	if (input.status !== 401) return false
	if (hasProviderOAuthExchangeError(input.data)) return false
	return true
}

function hasProviderOAuthExchangeError(data: Record<string, unknown> | null) {
	if (!data) return false
	if (typeof data.providerStatus === 'number') return true
	if (
		typeof data.error_description === 'string' &&
		data.error_description.trim()
	) {
		return true
	}
	return (
		typeof data.error === 'string' &&
		data.error.trim() !== '' &&
		data.error !== 'Unauthorized.'
	)
}

function resolveConnectOauthTokenExchangeStyle(input: {
	tokenUrl: string
	queryStyle: TokenExchangeStyle | null
	storedStyle: TokenExchangeStyle | null
}): TokenExchangeStyle {
	if (input.queryStyle) return input.queryStyle
	if (input.storedStyle) return input.storedStyle
	const host = safeParseHost(input.tokenUrl)
	if (host === 'api.notion.com') return 'basic-json'
	if (host === 'api.canva.com') return 'basic-form'
	return 'form'
}

/**
 * Hosts that require a confidential client even though the default flow is
 * PKCE-only. Canva requires both S256 PKCE and a client secret.
 */
function defaultConnectOauthFlow(tokenUrl: string): OAuthFlow {
	return safeParseHost(tokenUrl) === 'api.canva.com' ? 'confidential' : 'pkce'
}

function defaultConnectOauthUsePkce(input: {
	flow: OAuthFlow
	tokenUrl: string
}): boolean {
	if (input.flow === 'device') return false
	if (input.flow === 'pkce') return true
	return safeParseHost(input.tokenUrl) === 'api.canva.com'
}

export function parseTokenExchangeStyle(
	raw: unknown,
): TokenExchangeStyle | null {
	return raw === 'form' || raw === 'basic-json' || raw === 'basic-form'
		? raw
		: null
}

export function parseOptionalBoolean(raw: string | null): boolean | null {
	if (raw == null) return null
	const normalized = raw.trim().toLowerCase()
	if (normalized === 'true' || normalized === '1') return true
	if (normalized === 'false' || normalized === '0') return false
	return null
}

export function formatMissingSetupFields(missingFields: Array<string>) {
	if (missingFields.length === 0) return 'Ready to connect.'
	if (missingFields.length === 1) {
		return `Enter your ${missingFields[0]} to continue.`
	}
	return `Enter your ${missingFields.slice(0, -1).join(', ')} and ${missingFields.at(-1)} to continue.`
}

export function parseExtraParams(raw: string | null) {
	if (!raw) return {}
	try {
		const parsed = JSON.parse(raw)
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return Object.fromEntries(
				Object.entries(parsed).map(([key, value]) => [key, String(value)]),
			) as Record<string, string>
		}
	} catch {
		// Invalid JSON is tolerated as an empty parameter map.
	}
	return {}
}

export function parseAllowedHosts(raw: string | null) {
	if (!raw) return []
	return raw
		.split(/[\s,]+/)
		.map((host) => host.trim())
		.filter(Boolean)
}

export function parseHostApprovalLinks(
	raw: unknown,
): Array<ConnectOauthHostApprovalLink> {
	if (!Array.isArray(raw)) return []
	return raw.filter(
		(entry): entry is ConnectOauthHostApprovalLink =>
			Boolean(entry) &&
			typeof entry === 'object' &&
			typeof (entry as { secretName?: unknown }).secretName === 'string' &&
			typeof (entry as { host?: unknown }).host === 'string' &&
			typeof (entry as { approvalUrl?: unknown }).approvalUrl === 'string' &&
			isSafeExternalUrl((entry as { approvalUrl?: string }).approvalUrl ?? ''),
	)
}

export function parseConnectOauthNextSteps(
	raw: unknown,
): ConnectOauthNextSteps | null {
	if (!raw || typeof raw !== 'object') return null
	const record = raw as Record<string, unknown>
	if (
		typeof record.service !== 'string' ||
		typeof record.connectionName !== 'string' ||
		typeof record.prompt !== 'string'
	) {
		return null
	}
	return {
		service: record.service,
		connectionName: record.connectionName,
		prompt: record.prompt,
	}
}

export function parseOptionalUrl(raw: string | null) {
	if (!raw) return null
	try {
		return new URL(raw).toString()
	} catch {
		return null
	}
}

export function isSafeExternalUrl(raw: string) {
	try {
		const url = new URL(raw)
		return url.protocol === 'http:' || url.protocol === 'https:'
	} catch {
		return false
	}
}

export function parseProviderSetupInstructions(raw: string | null) {
	if (!raw) return null
	const trimmed = raw.trim()
	if (!trimmed) return null
	if (trimmed.startsWith('base64:')) {
		return decodeBase64Payload(trimmed.slice('base64:'.length)) ?? trimmed
	}
	const decoded = decodeBase64Payload(trimmed)
	return decoded && isMostlyPrintable(decoded) ? decoded : trimmed
}

export function decodeBase64Payload(raw: string) {
	if (!/^[A-Za-z0-9+/=_-]+$/.test(raw)) return null
	try {
		return new TextDecoder().decode(base64UrlToBytes(raw))
	} catch {
		return null
	}
}

export function isMostlyPrintable(text: string) {
	if (!text) return false
	let printable = 0
	for (const char of text) {
		const code = char.charCodeAt(0)
		if (code === 9 || code === 10 || code === 13 || code >= 32) {
			printable += 1
		}
	}
	return printable / text.length > 0.85
}

export async function createCodeChallenge(verifier: string) {
	const data = new TextEncoder().encode(verifier)
	const digest = await crypto.subtle.digest('SHA-256', data)
	return bytesToBase64Url(new Uint8Array(digest))
}

export function createCodeVerifier() {
	const bytes = new Uint8Array(64)
	crypto.getRandomValues(bytes)
	return bytesToBase64Url(bytes)
}
