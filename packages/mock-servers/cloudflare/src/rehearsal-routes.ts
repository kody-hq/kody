import { sha256Hex } from '@kody-internal/shared/sha256.ts'

/**
 * Public, stateless routes for the preview migration rehearsal
 * (`docs/contributing/preview-migration-rehearsal.md`).
 *
 * - `/__mocks/rehearsal/echo` returns SHA-256 hashes of the secret-bearing
 *   request headers, so a package can prove a `{{secret:…}}` placeholder (or
 *   an integration token) decrypted to the value seeded earlier without the
 *   value ever leaving Kody.
 * - `/__mocks/rehearsal/oauth/token` is an OAuth token endpoint that accepts
 *   authorization_code, refresh_token, or RFC 8628 device_code grants.
 * - `/__mocks/rehearsal/oauth/device/authorize` starts a device authorization.
 *
 * Device sessions live in-memory for the life of the isolate so polls can
 * walk through pending → success (or delayed / denied / expired scenarios).
 */
export const rehearsalEchoPath = '/__mocks/rehearsal/echo'
export const rehearsalOauthTokenPath = '/__mocks/rehearsal/oauth/token'
export const rehearsalOauthDeviceAuthorizePath =
	'/__mocks/rehearsal/oauth/device/authorize'
export const rehearsalSecretHeader = 'x-rehearsal-secret'

export const DEVICE_CODE_GRANT_TYPE =
	'urn:ietf:params:oauth:grant-type:device_code' as const

const echoedHeaders = ['authorization', rehearsalSecretHeader] as const

type DeviceScenario =
	| 'default'
	| 'slow_down'
	| 'access_denied'
	| 'expired_token'

type DeviceSession = {
	deviceCode: string
	userCode: string
	clientId: string
	scenario: DeviceScenario
	pollCount: number
	expiresAtMs: number
	intervalSeconds: number
}

const deviceSessions = new Map<string, DeviceSession>()

function randomToken(prefix: string) {
	const bytes = crypto.getRandomValues(new Uint8Array(24))
	return `${prefix}${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function randomUserCode() {
	const alphabet = 'BCDFGHJKLMNPQRSTVWXZ'
	const bytes = crypto.getRandomValues(new Uint8Array(8))
	let code = ''
	for (const byte of bytes) {
		code += alphabet[byte % alphabet.length]
	}
	return `${code.slice(0, 4)}-${code.slice(4)}`
}

function resolveDeviceScenario(input: {
	scenarioField: string | null
	userCodePrefix: string | null
}): DeviceScenario {
	const fromField = input.scenarioField?.trim().toLowerCase()
	if (
		fromField === 'default' ||
		fromField === 'slow_down' ||
		fromField === 'access_denied' ||
		fromField === 'expired_token'
	) {
		return fromField
	}
	const prefix = (input.userCodePrefix ?? '').trim().toUpperCase()
	if (prefix.startsWith('SLOW')) return 'slow_down'
	if (prefix.startsWith('DENY')) return 'access_denied'
	if (prefix.startsWith('EXPIRE')) return 'expired_token'
	return 'default'
}

async function handleEcho(request: Request) {
	const hashes: Record<string, string | null> = {}
	for (const name of echoedHeaders) {
		const value = request.headers.get(name)
		hashes[name] = value ? await sha256Hex(value) : null
	}
	return Response.json(
		{ ok: true, method: request.method, sha256: hashes },
		{ headers: { 'Cache-Control': 'no-store' } },
	)
}

async function readTokenRequest(request: Request) {
	const text = await request.text()
	const contentType = request.headers.get('content-type') ?? ''
	if (contentType.includes('application/json')) {
		try {
			const parsed = JSON.parse(text) as Record<string, unknown>
			return new URLSearchParams(
				Object.entries(parsed).flatMap(([key, value]) =>
					typeof value === 'string' ? [[key, value]] : [],
				),
			)
		} catch {
			return new URLSearchParams()
		}
	}
	return new URLSearchParams(text)
}

async function handleDeviceAuthorize(request: Request) {
	const params = await readTokenRequest(request)
	const clientId = params.get('client_id')?.trim()
	if (!clientId) {
		return Response.json(
			{
				error: 'invalid_request',
				error_description: 'client_id is required.',
			},
			{ status: 400 },
		)
	}
	const scenario = resolveDeviceScenario({
		scenarioField: params.get('scenario'),
		userCodePrefix: params.get('user_code'),
	})
	const deviceCode = randomToken('rehearsal_dc_')
	const userCode =
		params.get('user_code')?.trim() ||
		(scenario === 'slow_down'
			? `SLOW-${randomUserCode().slice(5)}`
			: scenario === 'access_denied'
				? `DENY-${randomUserCode().slice(5)}`
				: scenario === 'expired_token'
					? `EXPIRE-${randomUserCode().slice(7)}`
					: randomUserCode())
	const expiresIn = 600
	const intervalSeconds = 5
	const origin = new URL(request.url).origin
	deviceSessions.set(deviceCode, {
		deviceCode,
		userCode,
		clientId,
		scenario,
		pollCount: 0,
		expiresAtMs: Date.now() + expiresIn * 1000,
		intervalSeconds,
	})
	return Response.json(
		{
			device_code: deviceCode,
			user_code: userCode,
			verification_uri: `${origin}/__mocks/rehearsal/oauth/device/verify`,
			verification_uri_complete: `${origin}/__mocks/rehearsal/oauth/device/verify?user_code=${encodeURIComponent(userCode)}`,
			expires_in: expiresIn,
			interval: intervalSeconds,
		},
		{ headers: { 'Cache-Control': 'no-store' } },
	)
}

function handleDeviceTokenPoll(params: URLSearchParams) {
	const deviceCode = params.get('device_code')?.trim()
	if (!deviceCode) {
		return Response.json(
			{
				error: 'invalid_request',
				error_description: 'device_code is required.',
			},
			{ status: 400 },
		)
	}
	const session = deviceSessions.get(deviceCode)
	if (!session) {
		return Response.json(
			{
				error: 'expired_token',
				error_description: 'Unknown or expired device_code.',
			},
			{ status: 400 },
		)
	}
	if (Date.now() >= session.expiresAtMs) {
		deviceSessions.delete(deviceCode)
		return Response.json(
			{
				error: 'expired_token',
				error_description: 'The device code has expired.',
			},
			{ status: 400 },
		)
	}
	session.pollCount += 1

	switch (session.scenario) {
		case 'expired_token':
			deviceSessions.delete(deviceCode)
			return Response.json(
				{
					error: 'expired_token',
					error_description: 'The device code has expired.',
				},
				{ status: 400 },
			)
		case 'access_denied':
			deviceSessions.delete(deviceCode)
			return Response.json(
				{
					error: 'access_denied',
					error_description: 'The user denied the request.',
				},
				{ status: 400 },
			)
		case 'slow_down':
			if (session.pollCount === 1) {
				return Response.json(
					{
						error: 'slow_down',
						error_description: 'Polling too frequently.',
					},
					{ status: 400 },
				)
			}
			if (session.pollCount === 2) {
				return Response.json(
					{
						error: 'authorization_pending',
						error_description: 'The user has not finished authorizing.',
					},
					{ status: 400 },
				)
			}
			break
		case 'default':
			if (session.pollCount < 3) {
				return Response.json(
					{
						error: 'authorization_pending',
						error_description: 'The user has not finished authorizing.',
					},
					{ status: 400 },
				)
			}
			break
		default: {
			const _exhaustive: never = session.scenario
			return Response.json(
				{
					error: 'server_error',
					error_description: `Unhandled scenario: ${String(_exhaustive)}`,
				},
				{ status: 500 },
			)
		}
	}

	deviceSessions.delete(deviceCode)
	return Response.json(
		{
			access_token: randomToken('rehearsal_at_'),
			refresh_token: randomToken('rehearsal_rt_'),
			token_type: 'bearer',
			expires_in: 3600,
			scope: params.get('scope') ?? 'rehearsal.read',
		},
		{ headers: { 'Cache-Control': 'no-store' } },
	)
}

async function handleOauthToken(request: Request) {
	const params = await readTokenRequest(request)
	const grantType = params.get('grant_type')
	if (grantType === DEVICE_CODE_GRANT_TYPE) {
		return handleDeviceTokenPoll(params)
	}
	const credential =
		grantType === 'authorization_code'
			? params.get('code')
			: grantType === 'refresh_token'
				? params.get('refresh_token')
				: null
	if (!credential) {
		return Response.json(
			{
				error: 'invalid_request',
				error_description:
					'Send grant_type=authorization_code with a code, grant_type=refresh_token with a refresh_token, or the device_code grant.',
			},
			{ status: 400 },
		)
	}
	return Response.json(
		{
			access_token: randomToken('rehearsal_at_'),
			refresh_token: randomToken('rehearsal_rt_'),
			token_type: 'bearer',
			expires_in: 3600,
			scope: params.get('scope') ?? 'rehearsal.read',
		},
		{ headers: { 'Cache-Control': 'no-store' } },
	)
}

/** Test helper: drop in-memory device sessions between cases. */
export function resetRehearsalDeviceSessions() {
	deviceSessions.clear()
}

export async function routeRehearsal(request: Request, url: URL) {
	if (url.pathname === rehearsalEchoPath) return handleEcho(request)
	if (
		url.pathname === rehearsalOauthDeviceAuthorizePath &&
		request.method === 'POST'
	) {
		return handleDeviceAuthorize(request)
	}
	if (url.pathname === rehearsalOauthTokenPath && request.method === 'POST') {
		return handleOauthToken(request)
	}
	return null
}
