/**
 * RFC 8628 OAuth device authorization grant for integrations.
 *
 * One server backend (`device_start` / `device_poll`) with two entry points:
 * `/connect/oauth` (browser) and MCP `integrationDeviceConnect*`. The
 * provider `device_code` and client secret stay server-side; callers only see
 * an opaque session id plus the user-facing code and verification URI.
 */
import { safeParseHost } from '@kody-internal/shared/url-hosts.ts'
import { checkRateLimit } from '#app/rate-limit.ts'
import { normalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'
import {
	buildOAuthTokenExchangeRequest,
	isOAuthTokenExchangeSoftFailure,
	normalizeOAuthTokenExchangePayload,
	resolveTokenExchangeStyle,
	type TokenExchangeStyle,
} from './oauth-token-exchange.ts'

export const DEVICE_CODE_GRANT_TYPE =
	'urn:ietf:params:oauth:grant-type:device_code' as const

/** RFC 8628 §3.5: increase interval by 5 seconds on `slow_down`. */
export const DEVICE_SLOW_DOWN_INCREMENT_SECONDS = 5

/** Default poll interval when the provider omits `interval`. */
export const DEVICE_DEFAULT_INTERVAL_SECONDS = 5

/** Cap pending session TTL (provider expires_in may be shorter). */
export const DEVICE_SESSION_MAX_TTL_SECONDS = 60 * 30

/** How long a post-persist completion receipt stays retryable. */
export const DEVICE_COMPLETION_RECEIPT_TTL_SECONDS = 5 * 60

/** Starts per user per rolling window. */
export const deviceStartRateLimitConfig = {
	maxRequests: 10,
	windowSeconds: 60,
} as const

export type DeviceFlowClientAuth = 'pkce' | 'confidential'

/**
 * Device grant is orthogonal to client authentication: a device app may be
 * public (no secret) or confidential. Token poll / refresh use confidential
 * auth only when a client secret is available.
 */
export function resolveDeviceClientAuthFlow(input: {
	flow: 'pkce' | 'confidential' | 'device'
	clientSecret: string | null
}): DeviceFlowClientAuth {
	if (input.flow === 'confidential') return 'confidential'
	if (input.flow === 'device' && input.clientSecret) return 'confidential'
	return 'pkce'
}

/** User-facing success payload retained after secrets are stripped from KV. */
export type DeviceCompletionReceipt = {
	refreshTokenSaved: boolean
	allowedHosts: Array<string>
	hostApprovalLinks: Array<{
		secretName: string
		host: string
		approvalUrl: string
	}>
	integrationName: string
	nextSteps: unknown
}

export type DevicePendingSession = {
	userId: string
	deviceCode: string
	intervalSeconds: number
	expiresAtMs: number
	/** Earliest time the next poll may hit the provider. */
	nextPollAtMs: number
	provider: string
	platformAppSlug: string | null
	tokenUrl: string
	apiBaseUrl: string | null
	authorizeUrl: string | null
	deviceAuthorizationUrl: string
	flow: 'device'
	usePkce: boolean | null
	clientId: string
	tokenExchangeStyle: TokenExchangeStyle | null
	allowedHosts: Array<string>
	scopes: Array<string>
	scopeSeparator: string | null
	extraAuthorizeParams: Record<string, string>
	/** BYO confidential secret captured at start; never returned to callers. */
	clientSecret: string | null
	/**
	 * Set once the provider returns tokens. Later polls return this payload
	 * without re-using `device_code` at the provider. Cleared when
	 * `completeDevicePendingSession` writes the completion receipt.
	 */
	approvedTokenPayload?: Record<string, unknown> | null
	/**
	 * Written after tokens are persisted. Survives lost `approved` responses so
	 * a retry poll returns success instead of `invalid_session`.
	 */
	completion?: DeviceCompletionReceipt | null
}

export type DeviceStartSuccess = {
	ok: true
	sessionId: string
	userCode: string
	verificationUri: string
	verificationUriComplete: string | null
	expiresIn: number
	interval: number
}

export type DeviceStartFailure = {
	ok: false
	error: string
	status: number
	retryAfterSeconds?: number
}

export type DevicePollAuthorizationPending = {
	ok: true
	status: 'authorization_pending'
	interval: number
	expiresIn: number
}

export type DevicePollSlowDown = {
	ok: true
	status: 'slow_down'
	interval: number
	expiresIn: number
}

/** Pending poll outcomes before the user approves (RFC 8628 §3.5). */
export type DevicePollPending =
	| DevicePollAuthorizationPending
	| DevicePollSlowDown

export type DevicePollSuccess = {
	ok: true
	status: 'approved'
	tokenPayload: Record<string, unknown>
	/** Session fields needed to persist the connection. */
	session: Omit<
		DevicePendingSession,
		'deviceCode' | 'clientSecret' | 'approvedTokenPayload' | 'completion'
	>
	clientSecret: string | null
}

export type DevicePollFailure = {
	ok: false
	status:
		| 'access_denied'
		| 'expired_token'
		| 'invalid_session'
		| 'rate_limited'
		| 'provider_error'
	error: string
	httpStatus: number
}

export type DevicePollResult =
	| DevicePollPending
	| DevicePollSuccess
	| DevicePollFailure

function isSafeExternalUrl(raw: string) {
	try {
		const url = new URL(raw)
		return url.protocol === 'http:' || url.protocol === 'https:'
	} catch {
		return false
	}
}

function deviceSessionKvKey(userId: string, sessionId: string) {
	return `integration-device-session:${userId}:${sessionId}`
}

function randomOpaqueId() {
	const bytes = crypto.getRandomValues(new Uint8Array(18))
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
		'',
	)
}

function clampExpiresIn(expiresIn: number) {
	if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
		return DEVICE_DEFAULT_INTERVAL_SECONDS * 60
	}
	return Math.min(Math.floor(expiresIn), DEVICE_SESSION_MAX_TTL_SECONDS)
}

function readPositiveInt(value: unknown, fallback: number) {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		return Math.floor(value)
	}
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value)
		if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
	}
	return fallback
}

function readOptionalStringField(
	record: Record<string, unknown>,
	key: string,
): string | null {
	const value = record[key]
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	return trimmed || null
}

export function assertSafeDeviceAuthorizationUrl(url: string): string | null {
	const trimmed = url.trim()
	if (!trimmed) return 'Device authorization URL is required.'
	if (!isSafeExternalUrl(trimmed)) {
		return 'Device authorization URL must use http or https.'
	}
	if (!safeParseHost(trimmed)) {
		return 'Device authorization URL is invalid.'
	}
	return null
}

export async function storeDevicePendingSession(input: {
	env: Pick<Env, 'OAUTH_KV'>
	sessionId: string
	session: DevicePendingSession
}): Promise<void> {
	if (!input.env.OAUTH_KV) {
		throw new Error('Device authorization storage is unavailable.')
	}
	const remainingSeconds = Math.ceil(
		(input.session.expiresAtMs - Date.now()) / 1000,
	)
	// Completion receipts must survive near/after provider expiry so a lost
	// approved response can retry. Pending sessions with no remaining life go.
	if (remainingSeconds < 1 && !input.session.completion) {
		await deleteDevicePendingSession({
			env: input.env,
			userId: input.session.userId,
			sessionId: input.sessionId,
		})
		return
	}
	// Cloudflare KV rejects expirationTtl < 60. Logical expiry is enforced
	// by `expiresAtMs` in pollDeviceAuthorization (pending) or by the
	// completion receipt TTL.
	const ttlSeconds = Math.max(
		60,
		remainingSeconds,
		input.session.completion ? DEVICE_COMPLETION_RECEIPT_TTL_SECONDS : 0,
	)
	await input.env.OAUTH_KV.put(
		deviceSessionKvKey(input.session.userId, input.sessionId),
		JSON.stringify(input.session),
		{ expirationTtl: ttlSeconds },
	)
}

export async function loadDevicePendingSession(input: {
	env: Pick<Env, 'OAUTH_KV'>
	userId: string
	sessionId: string
}): Promise<DevicePendingSession | null> {
	if (!input.env.OAUTH_KV) return null
	const raw = await input.env.OAUTH_KV.get(
		deviceSessionKvKey(input.userId, input.sessionId),
		{ type: 'json' },
	)
	if (!raw || typeof raw !== 'object') return null
	return raw as DevicePendingSession
}

export async function deleteDevicePendingSession(input: {
	env: Pick<Env, 'OAUTH_KV'>
	userId: string
	sessionId: string
}): Promise<void> {
	if (!input.env.OAUTH_KV) return
	await input.env.OAUTH_KV.delete(
		deviceSessionKvKey(input.userId, input.sessionId),
	)
}

/** Delete the pending session (tests / hard abort). Prefer completion receipt. */
export async function consumeDevicePendingSession(input: {
	env: Pick<Env, 'OAUTH_KV'>
	userId: string
	sessionId: string
}): Promise<void> {
	await deleteDevicePendingSession(input)
}

/**
 * After persist succeeds: strip secrets and keep a completion receipt so a lost
 * `approved` response can be retried without becoming `invalid_session`.
 */
export async function completeDevicePendingSession(input: {
	env: Pick<Env, 'OAUTH_KV'>
	userId: string
	sessionId: string
	completion: DeviceCompletionReceipt
}): Promise<void> {
	const session = await loadDevicePendingSession({
		env: input.env,
		userId: input.userId,
		sessionId: input.sessionId,
	})
	if (!session || session.userId !== input.userId) return
	const now = Date.now()
	session.deviceCode = ''
	session.clientSecret = null
	session.approvedTokenPayload = null
	session.completion = input.completion
	// Extend past provider expiry so late approve + lost response can retry.
	session.expiresAtMs = Math.max(
		session.expiresAtMs,
		now + DEVICE_COMPLETION_RECEIPT_TTL_SECONDS * 1000,
	)
	await storeDevicePendingSession({
		env: input.env,
		sessionId: input.sessionId,
		session,
	})
}

function toApprovedPollResult(
	session: DevicePendingSession,
	tokenPayload: Record<string, unknown>,
): DevicePollSuccess {
	const {
		deviceCode: _deviceCode,
		clientSecret,
		approvedTokenPayload: _approved,
		completion: _completion,
		...safeSession
	} = session
	return {
		ok: true,
		status: 'approved',
		tokenPayload,
		session: safeSession,
		clientSecret,
	}
}

export async function startDeviceAuthorization(input: {
	env: Pick<Env, 'OAUTH_KV' | 'APP_DB'>
	userId: string
	deviceAuthorizationUrl: string
	tokenUrl: string
	apiBaseUrl: string | null
	authorizeUrl: string | null
	clientId: string
	clientSecret: string | null
	scopes: Array<string>
	scopeSeparator: string | null
	extraAuthorizeParams: Record<string, string>
	allowedHosts: Array<string>
	provider: string
	platformAppSlug: string | null
	usePkce: boolean | null
	tokenExchangeStyle: TokenExchangeStyle | null
	fetchImpl?: typeof fetch
}): Promise<DeviceStartSuccess | DeviceStartFailure> {
	const urlError = assertSafeDeviceAuthorizationUrl(
		input.deviceAuthorizationUrl,
	)
	if (urlError) {
		return { ok: false, error: urlError, status: 400 }
	}
	const deviceHost = safeParseHost(input.deviceAuthorizationUrl)
	const tokenHost = safeParseHost(input.tokenUrl)
	if (!tokenHost) {
		return { ok: false, error: 'Token URL is invalid.', status: 400 }
	}
	const allowedHosts = normalizeAllowedHosts([
		...input.allowedHosts,
		...(deviceHost ? [deviceHost] : []),
		tokenHost,
		...(input.authorizeUrl ? [safeParseHost(input.authorizeUrl) ?? ''] : []),
		...(input.apiBaseUrl ? [safeParseHost(input.apiBaseUrl) ?? ''] : []),
	])
	if (deviceHost && !allowedHosts.includes(deviceHost)) {
		return {
			ok: false,
			error: 'Device authorization host is not in allowed hosts.',
			status: 400,
		}
	}

	const rate = await checkRateLimit(
		input.env.APP_DB,
		`integration-device-start:${input.userId}`,
		deviceStartRateLimitConfig,
	)
	if (!rate.allowed) {
		return {
			ok: false,
			error: 'Too many device authorization starts. Try again shortly.',
			status: 429,
			retryAfterSeconds: rate.retryAfterSeconds ?? undefined,
		}
	}

	const scopeSeparator = input.scopeSeparator ?? ' '
	const params = new URLSearchParams()
	params.set('client_id', input.clientId)
	if (input.scopes.length > 0) {
		params.set('scope', input.scopes.join(scopeSeparator))
	}
	for (const [key, value] of Object.entries(input.extraAuthorizeParams)) {
		if (!params.has(key)) params.set(key, value)
	}
	// Public device clients omit the secret; confidential ones may include it
	// on the device authorization request (RFC 8628 §3.1).
	if (input.clientSecret) {
		params.set('client_secret', input.clientSecret)
	}

	const fetchImpl = input.fetchImpl ?? fetch
	let response: Response
	try {
		response = await fetchImpl(input.deviceAuthorizationUrl, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: params.toString(),
			signal: AbortSignal.timeout(30_000),
		})
	} catch (error) {
		return {
			ok: false,
			error:
				error instanceof Error
					? `Device authorization request failed: ${error.message}`
					: 'Device authorization request failed.',
			status: 502,
		}
	}

	const payload = (await response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null
	if (!response.ok || !payload) {
		const error =
			(payload && readOptionalStringField(payload, 'error_description')) ||
			(payload && readOptionalStringField(payload, 'error')) ||
			'Device authorization request was rejected.'
		return { ok: false, error, status: 502 }
	}

	const deviceCode = readOptionalStringField(payload, 'device_code')
	const userCode = readOptionalStringField(payload, 'user_code')
	const verificationUri =
		readOptionalStringField(payload, 'verification_uri') ||
		readOptionalStringField(payload, 'verification_url')
	if (!deviceCode || !userCode || !verificationUri) {
		return {
			ok: false,
			error:
				'Device authorization response was missing device_code, user_code, or verification_uri.',
			status: 502,
		}
	}
	if (!isSafeExternalUrl(verificationUri)) {
		return {
			ok: false,
			error: 'Provider returned an unsafe verification URI.',
			status: 502,
		}
	}
	const verificationUriComplete =
		readOptionalStringField(payload, 'verification_uri_complete') ||
		readOptionalStringField(payload, 'verification_url_complete')
	if (verificationUriComplete && !isSafeExternalUrl(verificationUriComplete)) {
		return {
			ok: false,
			error: 'Provider returned an unsafe verification_uri_complete.',
			status: 502,
		}
	}

	const expiresIn = clampExpiresIn(readPositiveInt(payload.expires_in, 600))
	const intervalSeconds = Math.max(
		1,
		readPositiveInt(payload.interval, DEVICE_DEFAULT_INTERVAL_SECONDS),
	)
	const now = Date.now()
	const sessionId = randomOpaqueId()
	const session: DevicePendingSession = {
		userId: input.userId,
		deviceCode,
		intervalSeconds,
		expiresAtMs: now + expiresIn * 1000,
		nextPollAtMs: now,
		provider: input.provider,
		platformAppSlug: input.platformAppSlug,
		tokenUrl: input.tokenUrl,
		apiBaseUrl: input.apiBaseUrl,
		authorizeUrl: input.authorizeUrl,
		deviceAuthorizationUrl: input.deviceAuthorizationUrl,
		flow: 'device',
		usePkce: input.usePkce,
		clientId: input.clientId,
		tokenExchangeStyle: input.tokenExchangeStyle,
		allowedHosts,
		scopes: input.scopes,
		scopeSeparator: input.scopeSeparator,
		extraAuthorizeParams: input.extraAuthorizeParams,
		clientSecret: input.clientSecret,
	}
	await storeDevicePendingSession({
		env: input.env,
		sessionId,
		session,
	})

	return {
		ok: true,
		sessionId,
		userCode,
		verificationUri,
		verificationUriComplete,
		expiresIn,
		interval: intervalSeconds,
	}
}

export async function pollDeviceAuthorization(input: {
	env: Pick<Env, 'OAUTH_KV'>
	userId: string
	sessionId: string
	fetchImpl?: typeof fetch
	nowMs?: number
}): Promise<DevicePollResult> {
	const session = await loadDevicePendingSession({
		env: input.env,
		userId: input.userId,
		sessionId: input.sessionId,
	})
	if (!session || session.userId !== input.userId) {
		return {
			ok: false,
			status: 'invalid_session',
			error: 'Device authorization session was not found or has expired.',
			httpStatus: 404,
		}
	}

	// Tokens already persisted — connect-layer poll returns the receipt instead.
	if (session.completion) {
		return {
			ok: false,
			status: 'invalid_session',
			error: 'Device authorization session was already completed.',
			httpStatus: 404,
		}
	}

	const now = input.nowMs ?? Date.now()
	const expiresIn = Math.max(0, Math.ceil((session.expiresAtMs - now) / 1000))
	if (expiresIn <= 0) {
		await deleteDevicePendingSession({
			env: input.env,
			userId: input.userId,
			sessionId: input.sessionId,
		})
		return {
			ok: false,
			status: 'expired_token',
			error: 'The device code has expired. Start a new device authorization.',
			httpStatus: 400,
		}
	}

	// Provider already approved: return cached tokens without re-hitting
	// the token endpoint (device_code is single-use).
	if (session.approvedTokenPayload) {
		const cachedAccess = readOptionalStringField(
			session.approvedTokenPayload,
			'access_token',
		)
		if (cachedAccess) {
			return toApprovedPollResult(session, session.approvedTokenPayload)
		}
	}

	if (now < session.nextPollAtMs) {
		return {
			ok: true,
			status: 'authorization_pending',
			interval: session.intervalSeconds,
			expiresIn,
		}
	}

	const params = new URLSearchParams()
	params.set('grant_type', DEVICE_CODE_GRANT_TYPE)
	params.set('device_code', session.deviceCode)
	params.set('client_id', session.clientId)

	const clientAuthFlow = resolveDeviceClientAuthFlow({
		flow: session.flow,
		clientSecret: session.clientSecret,
	})
	const style = resolveTokenExchangeStyle({
		tokenUrl: session.tokenUrl,
		tokenExchangeStyle: session.tokenExchangeStyle,
	})
	let exchangeRequest: { headers: Record<string, string>; body: string }
	try {
		exchangeRequest = buildOAuthTokenExchangeRequest({
			params,
			flow: clientAuthFlow,
			clientSecret: session.clientSecret,
			style,
		})
	} catch (error) {
		return {
			ok: false,
			status: 'provider_error',
			error:
				error instanceof Error
					? error.message
					: 'Unable to build device token request.',
			httpStatus: 400,
		}
	}

	const fetchImpl = input.fetchImpl ?? fetch
	let response: Response
	try {
		response = await fetchImpl(session.tokenUrl, {
			method: 'POST',
			headers: exchangeRequest.headers,
			body: exchangeRequest.body,
			signal: AbortSignal.timeout(30_000),
		})
	} catch (error) {
		// RFC 8628 §3.5: increase the interval after a connection timeout.
		session.intervalSeconds += DEVICE_SLOW_DOWN_INCREMENT_SECONDS
		session.nextPollAtMs = now + session.intervalSeconds * 1000
		await storeDevicePendingSession({
			env: input.env,
			sessionId: input.sessionId,
			session,
		})
		return {
			ok: false,
			status: 'provider_error',
			error:
				error instanceof Error
					? `Device token poll failed: ${error.message}`
					: 'Device token poll failed.',
			httpStatus: 502,
		}
	}

	const payload = (await response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null
	const errorCode = payload ? readOptionalStringField(payload, 'error') : null
	const errorDescription = payload
		? readOptionalStringField(payload, 'error_description')
		: null

	if (
		errorCode === 'authorization_pending' ||
		(response.status === 400 && errorCode === 'authorization_pending')
	) {
		session.nextPollAtMs = now + session.intervalSeconds * 1000
		await storeDevicePendingSession({
			env: input.env,
			sessionId: input.sessionId,
			session,
		})
		return {
			ok: true,
			status: 'authorization_pending',
			interval: session.intervalSeconds,
			expiresIn,
		}
	}

	if (errorCode === 'slow_down') {
		session.intervalSeconds += DEVICE_SLOW_DOWN_INCREMENT_SECONDS
		session.nextPollAtMs = now + session.intervalSeconds * 1000
		await storeDevicePendingSession({
			env: input.env,
			sessionId: input.sessionId,
			session,
		})
		return {
			ok: true,
			status: 'slow_down',
			interval: session.intervalSeconds,
			expiresIn,
		}
	}

	if (errorCode === 'access_denied') {
		await deleteDevicePendingSession({
			env: input.env,
			userId: input.userId,
			sessionId: input.sessionId,
		})
		return {
			ok: false,
			status: 'access_denied',
			error:
				errorDescription || 'The user denied the device authorization request.',
			httpStatus: 403,
		}
	}

	if (errorCode === 'expired_token') {
		await deleteDevicePendingSession({
			env: input.env,
			userId: input.userId,
			sessionId: input.sessionId,
		})
		return {
			ok: false,
			status: 'expired_token',
			error:
				errorDescription ||
				'The device code has expired. Start a new device authorization.',
			httpStatus: 400,
		}
	}

	if (
		!response.ok ||
		!payload ||
		isOAuthTokenExchangeSoftFailure(payload) ||
		errorCode
	) {
		return {
			ok: false,
			status: 'provider_error',
			error:
				errorDescription ||
				errorCode ||
				'Device token poll was rejected by the provider.',
			httpStatus: 502,
		}
	}

	const tokenPayload = normalizeOAuthTokenExchangePayload(payload)
	const accessToken = readOptionalStringField(tokenPayload, 'access_token')
	if (!accessToken) {
		return {
			ok: false,
			status: 'provider_error',
			error: 'Device token response did not include an access_token.',
			httpStatus: 502,
		}
	}

	// Keep tokens in KV until persist succeeds so a failed persist can retry
	// without re-using the provider device_code.
	session.approvedTokenPayload = tokenPayload
	await storeDevicePendingSession({
		env: input.env,
		sessionId: input.sessionId,
		session,
	})

	return toApprovedPollResult(session, tokenPayload)
}
