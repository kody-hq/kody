import { createCookie } from 'remix/cookie'
import { create as createQrCode } from 'qrcode/lib/core/qrcode.js'
import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'
import {
	getAuthSessionExpiresAtMs,
	isSecureRequest,
} from '#app/auth-session.ts'
import {
	formatPackageAppOauthClientId,
	parsePackageAppOauthClientId,
} from '#app/package-app-oauth-client-id.ts'
import { resolvePackageAppOauthClient } from '#app/package-app-oauth-client-resolve.ts'
import { mintPackageAppOauthCode } from '#app/package-app-oauth-codes.ts'
import {
	loadConsentPackageMeta,
	parseAndValidateAuthorizeRequest,
	readAuthorizeQuery,
} from '#app/package-app-oauth-authorize.ts'
import { packageAppOauthAppDomain } from '#app/package-app-oauth-consent-copy.ts'
import { parsePackageAppOauthScopes } from '#app/package-app-oauth-scopes.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { deviceAuthorizationStartRateLimit } from '#worker/oauth-device/authorization-endpoint.ts'
import {
	deviceCodeTtlSeconds,
	devicePollIntervalSeconds,
	formatUserCode,
	generateDeviceCode,
	generateUserCode,
	hashDeviceCode,
} from '#worker/oauth-device/device-grant.ts'
import {
	consumeApprovedDeviceAuthorization,
	findDeviceAuthorizationByDeviceCodeHash,
	insertDeviceAuthorization,
	nowSeconds,
	purgeExpiredDeviceAuthorizations,
	type DeviceAuthorizationRow,
} from '#worker/oauth-device/store.ts'
import { checkRateLimit } from '#worker/rate-limit.ts'
import { oauthPaths } from '#universal/oauth-paths.ts'
import {
	packageAppDeviceIntentCookieName,
	packageAppDeviceIntentCookieNameInsecure,
	packageAppDeviceSignInCookieName,
	packageAppDeviceSignInCookieNameInsecure,
	packageAppOauthPaths,
} from '#universal/package-app-oauth-paths.ts'
import { parsePackageAppPath } from '#worker/package-runtime/package-app-serve.ts'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import {
	describeRequestingBrowser,
	parsePackageAppDeviceRequest,
	type PackageAppDeviceRequest,
} from '#app/package-app-device-request.ts'

/**
 * "Sign in on another device" for package-app visitors on limited browsers
 * (ADR 0094). The limited browser starts an RFC 8628 style request from the
 * app's sign-in page, shows the user code and a QR code, and checks back with
 * plain page reloads. The visitor approves on a device where they are signed
 * in to Kody, on the app's normal consent screen. The limited browser then
 * gets an ordinary package-app authorization code for the redirect_uri and
 * PKCE challenge its own app host started, so the session it ends up with is
 * the same one the normal sign-in produces.
 */

const cookieSecretPurpose = 'kody-package-app-device-sign-in:v1'

/** Seconds between the limited browser's automatic checks. */
export const packageAppDeviceRefreshSeconds = devicePollIntervalSeconds

/** Seconds a "sign in on another device" intent survives the app host hop. */
const deviceIntentTtlSeconds = 10 * 60

let cachedCookies: {
	sourceSecret: string
	secure: ReturnType<typeof createCookie>
	insecure: ReturnType<typeof createCookie>
	intentSecure: ReturnType<typeof createCookie>
	intentInsecure: ReturnType<typeof createCookie>
} | null = null

async function getCookies(env: Env) {
	const secret = env.COOKIE_SECRET?.trim()
	if (!secret) {
		throw new Error('Missing COOKIE_SECRET for package app device sign-in.')
	}
	if (cachedCookies?.sourceSecret === secret) return cachedCookies
	const derived = await sha256Base64Url(`${cookieSecretPurpose}:${secret}`)
	const shared = {
		httpOnly: true,
		sameSite: 'Lax' as const,
		path: '/',
		maxAge: deviceCodeTtlSeconds,
		secrets: [derived],
	}
	cachedCookies = {
		sourceSecret: secret,
		secure: createCookie(packageAppDeviceSignInCookieName, {
			...shared,
			secure: true,
		}),
		insecure: createCookie(packageAppDeviceSignInCookieNameInsecure, shared),
		intentSecure: createCookie(packageAppDeviceIntentCookieName, {
			...shared,
			maxAge: deviceIntentTtlSeconds,
			secure: true,
		}),
		intentInsecure: createCookie(packageAppDeviceIntentCookieNameInsecure, {
			...shared,
			maxAge: deviceIntentTtlSeconds,
		}),
	}
	return cachedCookies
}

async function serializeDeviceIntentCookie(input: {
	env: Env
	secure: boolean
	clientId: string | null
}) {
	const cookies = await getCookies(input.env)
	const cookie = input.secure ? cookies.intentSecure : cookies.intentInsecure
	return input.clientId
		? await cookie.serialize(input.clientId.toLowerCase(), {
				secure: input.secure,
				maxAge: deviceIntentTtlSeconds,
			})
		: await cookie.serialize('', {
				secure: input.secure,
				maxAge: 0,
				expires: new Date(0),
			})
}

/**
 * The package-app client id a limited browser asked to sign in to on another
 * device, when the authorize request that comes back from the app host should
 * start that sign-in instead of showing the password form.
 */
export async function readPackageAppDeviceIntent(request: Request, env: Env) {
	const header = request.headers.get('Cookie')
	if (!header) return null
	const cookies = await getCookies(env)
	for (const cookie of [cookies.intentSecure, cookies.intentInsecure]) {
		const value = await cookie.parse(header)
		if (typeof value === 'string' && value) return value
	}
	return null
}

async function serializeDeviceCookie(input: {
	env: Env
	secure: boolean
	deviceCode: string
}) {
	const cookies = await getCookies(input.env)
	const cookie = input.secure ? cookies.secure : cookies.insecure
	return await cookie.serialize(input.deviceCode, {
		secure: input.secure,
		maxAge: deviceCodeTtlSeconds,
	})
}

export async function destroyPackageAppDeviceCookie(input: {
	env: Env
	secure: boolean
}) {
	const cookies = await getCookies(input.env)
	const cookie = input.secure ? cookies.secure : cookies.insecure
	return await cookie.serialize('', {
		secure: input.secure,
		maxAge: 0,
		expires: new Date(0),
	})
}

async function readDeviceCode(request: Request, env: Env) {
	const header = request.headers.get('Cookie')
	if (!header) return null
	const cookies = await getCookies(env)
	for (const cookie of [cookies.secure, cookies.insecure]) {
		const value = await cookie.parse(header)
		if (typeof value === 'string' && value.startsWith('kody_dc_')) return value
	}
	return null
}

function isSameOriginPost(request: Request, env: Env) {
	const appOrigin = new URL(getAppBaseUrl({ env, requestUrl: request.url }))
		.origin
	const origin = request.headers.get('Origin')
	if (origin) return origin === appOrigin
	return request.headers.get('Sec-Fetch-Site') === 'same-origin'
}

function seeOther(location: string, setCookies: Array<string> = []) {
	const headers = new Headers({
		Location: location,
		'Cache-Control': 'no-store',
		'Referrer-Policy': 'no-referrer',
	})
	for (const cookie of setCookies) headers.append('Set-Cookie', cookie)
	return new Response(null, { status: 303, headers })
}

function devicePagePath(error?: 'rate_limited' | 'invalid_request') {
	return error
		? `${packageAppOauthPaths.device}?error=${error}`
		: packageAppOauthPaths.device
}

/**
 * `POST /oauth/package-app/device` from the app's sign-in page. `authorize`
 * is the package-app authorize path the sign-in page was resuming; it is
 * validated exactly like a normal authorize request before anything is
 * stored.
 */
export async function startPackageAppDeviceSignIn(input: {
	request: Request
	env: Env
}): Promise<Response> {
	const { request, env } = input
	if (!isSameOriginPost(request, env)) {
		return new Response('Cross-origin sign-in requests are not allowed.', {
			status: 403,
			headers: { 'Cache-Control': 'no-store' },
		})
	}
	const contentType = request.headers.get('Content-Type') ?? ''
	const form = contentType.includes('application/x-www-form-urlencoded')
		? await request.formData().catch(() => null)
		: null
	const target = normalizeRedirectTo(
		typeof form?.get('authorize') === 'string'
			? String(form?.get('authorize'))
			: null,
	)
	const appOrigin = getAppBaseUrl({ env, requestUrl: request.url })
	const targetUrl = target ? new URL(target, appOrigin) : null
	if (targetUrl?.pathname === packageAppOauthPaths.authorize) {
		const validated = await parseAndValidateAuthorizeRequest({
			env,
			query: readAuthorizeQuery(targetUrl),
			requestUrl: request.url,
			request,
		})
		if (!validated.ok) return validated.response
		return await createPackageAppDeviceSignIn({ request, env, validated })
	}
	const packagePath = targetUrl ? parsePackageAppPath(targetUrl.pathname) : null
	if (!targetUrl || !packagePath) {
		return seeOther(devicePagePath('invalid_request'))
	}
	// A Kody package path (the app's Open link) has no PKCE request yet. Send
	// the browser through the app's own sign-in start, remembering that it
	// asked for another device; the authorize request it comes back with
	// starts the device sign-in (see `handlePackageAppOauthAuthorizeRequest`).
	const { resolvePackageAppSignInStartUrl } =
		await import('#app/package-app-origin.ts')
	const signInStart = await resolvePackageAppSignInStartUrl({
		env,
		requestUrl: targetUrl,
		packagePath,
	})
	const signInStartLocation =
		signInStart.origin === new URL(appOrigin).origin
			? `${signInStart.pathname}${signInStart.search}`
			: signInStart.toString()
	return seeOther(signInStartLocation, [
		await serializeDeviceIntentCookie({
			env,
			secure: isSecureRequest(request),
			clientId: formatPackageAppOauthClientId({
				username: packagePath.username,
				kodyId: packagePath.kodyId,
			}),
		}),
	])
}

type ValidatedAuthorizeRequest = Extract<
	Awaited<ReturnType<typeof parseAndValidateAuthorizeRequest>>,
	{ ok: true }
>

/**
 * Store a pending package-app device sign-in for a validated authorize
 * request and send the limited browser to its code page. Shared by the
 * sign-in page's POST and the authorize request that resumes a package-path
 * start.
 */
export async function createPackageAppDeviceSignIn(input: {
	request: Request
	env: Env
	validated: ValidatedAuthorizeRequest
	clearIntent?: boolean
}): Promise<Response> {
	const { request, env, validated } = input
	const ip = getRequestIp(request) ?? 'unknown'
	const limit = await checkRateLimit(
		env.APP_DB,
		`oauth-device:start:ip:${ip}`,
		deviceAuthorizationStartRateLimit,
	)
	if (!limit.allowed) return seeOther(devicePagePath('rate_limited'))

	const now = nowSeconds()
	await purgeExpiredDeviceAuthorizations(env.APP_DB, now)
	const deviceCode = generateDeviceCode()
	const deviceCodeHash = await hashDeviceCode(deviceCode)
	const requestJson: PackageAppDeviceRequest = {
		v: 1,
		state: validated.state,
		codeChallenge: validated.codeChallenge,
		requester: describeRequestingBrowser(request.headers.get('User-Agent')),
		rememberMe: true,
	}
	let inserted = false
	for (let attempt = 0; attempt < 5 && !inserted; attempt += 1) {
		inserted = await insertDeviceAuthorization(env.APP_DB, {
			id: crypto.randomUUID(),
			device_code_hash: deviceCodeHash,
			user_code: generateUserCode(),
			client_id: validated.client.clientId,
			scope: validated.scopes.join(' '),
			resource: validated.redirectUri,
			requested_org_slug: null,
			interval_seconds: devicePollIntervalSeconds,
			created_at: now,
			expires_at: now + deviceCodeTtlSeconds,
			kind: 'package_app',
			request_json: JSON.stringify(requestJson),
		})
	}
	if (!inserted) {
		return new Response('Could not allocate a sign-in code. Try again.', {
			status: 503,
			headers: { 'Cache-Control': 'no-store' },
		})
	}
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'oauth',
		action: 'device_authorization',
		result: 'success',
		ip,
		clientId: validated.client.clientId,
	})
	const secure = isSecureRequest(request)
	return seeOther(devicePagePath(), [
		await serializeDeviceCookie({ env, secure, deviceCode }),
		...(input.clearIntent
			? [await serializeDeviceIntentCookie({ env, secure, clientId: null })]
			: []),
	])
}

async function readDeviceRow(request: Request, env: Env) {
	const deviceCode = await readDeviceCode(request, env)
	if (!deviceCode) return null
	const row = await findDeviceAuthorizationByDeviceCodeHash(
		env.APP_DB,
		await hashDeviceCode(deviceCode),
	)
	return row?.kind === 'package_app' ? row : null
}

/** Where "Start again" sends the visitor: the app's own sign-in start. */
function appSignInStartUrl(row: DeviceAuthorizationRow) {
	const client = parsePackageAppOauthClientId(row.client_id)
	try {
		const url = new URL(packageAppOauthPaths.login, row.resource)
		if (client) {
			url.searchParams.set('app', client.kodyId)
			url.searchParams.set('org', client.username)
		}
		return url.toString()
	} catch {
		return '/'
	}
}

/** QR code as one SVG path in module units, quiet zone included. */
export function buildQrCodePath(text: string) {
	const { modules } = createQrCode(text, { errorCorrectionLevel: 'M' })
	const quiet = 2
	let path = ''
	for (let row = 0; row < modules.size; row += 1) {
		for (let column = 0; column < modules.size; column += 1) {
			if (modules.data[row * modules.size + column]) {
				path += `M${column + quiet} ${row + quiet}h1v1h-1z`
			}
		}
	}
	return { size: modules.size + quiet * 2, path }
}

export type PackageAppDeviceSignInView =
	| { kind: 'none'; error: 'rate_limited' | 'invalid_request' | null }
	| {
			kind: 'pending'
			appName: string
			appDomain: string | null
			userCode: string
			verificationUri: string
			verificationUriComplete: string
			qr: { size: number; path: string }
			expiresAt: number
			refreshSeconds: number
	  }
	| {
			kind: 'denied' | 'expired'
			appName: string
			startAgainUrl: string
	  }

async function appNameFor(env: Env, row: DeviceAuthorizationRow) {
	const client = parsePackageAppOauthClientId(row.client_id)
	if (!client) return 'this app'
	const meta = await loadConsentPackageMeta({
		env,
		orgUsername: client.username,
		kodyId: client.kodyId,
	})
	return meta.packageName
}

/** Loader view for the limited browser's device sign-in page. */
export async function loadPackageAppDeviceSignInView(input: {
	request: Request
	env: Env
	error: string | null
}): Promise<PackageAppDeviceSignInView> {
	const row = await readDeviceRow(input.request, input.env)
	const error =
		input.error === 'rate_limited' || input.error === 'invalid_request'
			? input.error
			: null
	if (!row || row.status === 'consumed') return { kind: 'none', error }
	const appName = await appNameFor(input.env, row)
	const expired = row.expires_at <= nowSeconds()
	if (row.status === 'denied' || expired) {
		return {
			kind: row.status === 'denied' ? 'denied' : 'expired',
			appName,
			startAgainUrl: appSignInStartUrl(row),
		}
	}
	const appOrigin = getAppBaseUrl({
		env: input.env,
		requestUrl: input.request.url,
	})
	const userCode = formatUserCode(row.user_code)
	const verificationUri = new URL(oauthPaths.device, appOrigin)
	const verificationUriComplete = new URL(verificationUri)
	verificationUriComplete.searchParams.set('user_code', userCode)
	return {
		kind: 'pending',
		appName,
		appDomain: packageAppOauthAppDomain(row.resource),
		userCode,
		verificationUri: verificationUri.href,
		verificationUriComplete: verificationUriComplete.href,
		qr: buildQrCodePath(verificationUriComplete.href),
		expiresAt: row.expires_at,
		refreshSeconds: packageAppDeviceRefreshSeconds,
	}
}

/**
 * Document GET for the device sign-in page. An approved request is consumed
 * once and turned into a package-app authorization code for the redirect_uri
 * and PKCE challenge the app host started; the limited browser is sent there
 * like a normal consent. Returns `{ pending: true }` while the page should
 * keep checking and `{ pending: false }` when it should just render.
 */
export async function handlePackageAppDeviceSignInDocument(input: {
	request: Request
	env: Env
}): Promise<Response | { pending: boolean }> {
	const { request, env } = input
	const row = await readDeviceRow(request, env)
	if (!row) return { pending: false }
	const now = nowSeconds()
	if (row.status === 'pending' && row.expires_at > now) {
		return { pending: true }
	}
	if (row.status !== 'approved') return { pending: false }
	const secure = isSecureRequest(request)
	if (!(await consumeApprovedDeviceAuthorization(env.APP_DB, row.id, now))) {
		return { pending: false }
	}
	const ip = getRequestIp(request) ?? undefined
	const fail = (reason: string) => {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'oauth',
			action: 'device_token',
			result: 'failure',
			ip,
			clientId: row.client_id,
			reason,
		})
		return { pending: false }
	}
	const details = parsePackageAppDeviceRequest(row)
	const parsedClient = parsePackageAppOauthClientId(row.client_id)
	if (!details || !parsedClient || !row.user_id) return fail('invalid_row')
	const resolved = await resolvePackageAppOauthClient({
		env,
		username: parsedClient.username,
		kodyId: parsedClient.kodyId,
	})
	if (!resolved) return fail('app_unavailable')
	const user = await createDb(env.APP_DB).findOne(usersTable, {
		where: { stable_user_id: row.user_id },
	})
	if (!user || user.deleted_at || typeof user.username !== 'string') {
		return fail('approver_unavailable')
	}
	const { scopes } = parsePackageAppOauthScopes(row.approved_scope)
	const minted = await mintPackageAppOauthCode({
		env,
		record: {
			personId: row.user_id,
			username: user.username,
			orgUsername: resolved.client.username,
			kodyId: resolved.client.kodyId,
			redirectUri: row.resource,
			codeChallenge: details.codeChallenge,
			scopes,
			sessionExpiresAt: getAuthSessionExpiresAtMs({
				rememberMe: details.rememberMe,
				issuedAt: Date.now(),
			}),
		},
	})
	if (!minted) return fail('code_storage_unavailable')
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'oauth',
		action: 'device_token',
		result: 'success',
		email: user.email,
		ip,
		clientId: row.client_id,
	})
	const target = new URL(row.resource)
	target.searchParams.set('code', minted.code)
	if (details.state) target.searchParams.set('state', details.state)
	return seeOther(target.toString(), [
		await destroyPackageAppDeviceCookie({ env, secure }),
	])
}
