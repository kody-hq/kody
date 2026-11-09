import { createCookie } from 'remix/cookie'
import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { createAuthCookie, isSecureRequest } from '#app/auth-session.ts'
import { buildAccountDeviceSignInApprovedEmail } from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { buildQrCodePath } from '#app/package-app-device-sign-in.ts'
import { describeRequestingBrowser } from '#app/package-app-device-request.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { getSystemEmailDomain } from '#worker/email/platform-address.ts'
import { sendGatedTransactionalEmail } from '#worker/email/transactional-send-policy.ts'
import { touchLastActiveAt } from '#worker/identity/activation-stamps.ts'
import {
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
import { checkRateLimit, type RateLimitConfig } from '#worker/rate-limit.ts'
import {
	accountDeviceSignInCookieName,
	accountDeviceSignInCookieNameInsecure,
	accountDeviceSignInPath,
	oauthPaths,
} from '#universal/oauth-paths.ts'
import {
	normalizeRedirectTo,
	resolvePostAuthLandingPath,
} from '#universal/safe-redirect.ts'

/**
 * "Sign in on another device" for Kody's own full-account sign-in (ADR 0094).
 * A browser that cannot finish `/login` (an e-reader, JavaScript off) asks
 * for a short code; the person approves it on `/device` from a browser that
 * is already signed in, after an explicit full-account confirmation; the
 * asking browser then gets an ordinary Kody session on its next check.
 *
 * Phishing is the risk: anyone who gets a signed-in person to approve a code
 * gets their whole account. So the code lives five minutes, the approval
 * screen shows the asking browser, its approximate location and the time it
 * asked, approving needs a separate confirmation, starts, checks and
 * approvals are rate limited, and every approval emails the account.
 */

/** `client_id` stored on account rows; it is never an OAuth client. */
export const accountDeviceClientId = 'kody-account'

/** Full-account codes live half as long as CLI and app codes. */
export const accountDeviceCodeTtlSeconds = 5 * 60

/** Seconds between the asking browser's automatic checks. */
export const accountDeviceRefreshSeconds = devicePollIntervalSeconds

/** Seconds between checks once a network has checked too often. */
export const accountDeviceSlowRefreshSeconds = 30

/** Full-account sign-in requests per IP. */
export const accountDeviceStartRateLimit: RateLimitConfig = {
	maxRequests: 5,
	windowSeconds: 15 * 60,
}

/**
 * Checks from the asking browser per IP: a code checked every five seconds
 * for its whole life is 60, so this leaves room for two at once.
 */
export const accountDevicePollRateLimit: RateLimitConfig = {
	maxRequests: 150,
	windowSeconds: accountDeviceCodeTtlSeconds,
}

/** Full-account approvals per approving person. */
export const accountDeviceApproveRateLimit: RateLimitConfig = {
	maxRequests: 5,
	windowSeconds: 60 * 60,
}

export type AccountDeviceLocation = {
	city: string | null
	region: string | null
	country: string | null
}

export type AccountDeviceRequest = {
	v: 1
	/** Plain label for the browser that asked, e.g. "Chrome 80 on Linux". */
	requester: string
	/** Cloudflare's IP geolocation for the asking browser. */
	location: AccountDeviceLocation | null
	redirectTo: string | null
	rememberMe: boolean
}

function cleanLocationPart(value: unknown) {
	if (typeof value !== 'string') return null
	const trimmed = value.trim().slice(0, 80)
	// `XX` / `T1` are Cloudflare's unknown and Tor country codes.
	return trimmed && trimmed !== 'XX' && trimmed !== 'T1' ? trimmed : null
}

/** Approximate location of a request from Cloudflare's `request.cf`. */
export function readRequestLocation(
	request: Request,
): AccountDeviceLocation | null {
	const cf = (request as Request & { cf?: Record<string, unknown> }).cf
	const location = {
		city: cleanLocationPart(cf?.city),
		region: cleanLocationPart(cf?.region),
		country: cleanLocationPart(cf?.country),
	}
	return location.city || location.region || location.country ? location : null
}

/** "Salt Lake City, Utah, US", or null when nothing is known. */
export function formatDeviceLocation(location: AccountDeviceLocation | null) {
	if (!location) return null
	const parts = [location.city, location.region, location.country].filter(
		(part): part is string => Boolean(part),
	)
	return parts.length > 0 ? [...new Set(parts)].join(', ') : null
}

export function parseAccountDeviceRequest(
	row: Pick<DeviceAuthorizationRow, 'request_json'>,
): AccountDeviceRequest | null {
	try {
		const parsed = JSON.parse(
			row.request_json ?? '',
		) as Partial<AccountDeviceRequest>
		if (parsed?.v !== 1) return null
		const location =
			parsed.location && typeof parsed.location === 'object'
				? {
						city: cleanLocationPart(parsed.location.city),
						region: cleanLocationPart(parsed.location.region),
						country: cleanLocationPart(parsed.location.country),
					}
				: null
		return {
			v: 1,
			requester:
				typeof parsed.requester === 'string'
					? parsed.requester
					: 'An unknown browser',
			location,
			redirectTo: normalizeRedirectTo(
				typeof parsed.redirectTo === 'string' ? parsed.redirectTo : null,
			),
			rememberMe: parsed.rememberMe === true,
		}
	} catch {
		return null
	}
}

const cookieSecretPurpose = 'kody-account-device-sign-in:v1'

let cachedCookies: {
	sourceSecret: string
	secure: ReturnType<typeof createCookie>
	insecure: ReturnType<typeof createCookie>
} | null = null

async function getCookies(env: Env) {
	const secret = env.COOKIE_SECRET?.trim()
	if (!secret) {
		throw new Error('Missing COOKIE_SECRET for account device sign-in.')
	}
	if (cachedCookies?.sourceSecret === secret) return cachedCookies
	const derived = await sha256Base64Url(`${cookieSecretPurpose}:${secret}`)
	const shared = {
		httpOnly: true,
		sameSite: 'Lax' as const,
		path: '/',
		maxAge: accountDeviceCodeTtlSeconds,
		secrets: [derived],
	}
	cachedCookies = {
		sourceSecret: secret,
		secure: createCookie(accountDeviceSignInCookieName, {
			...shared,
			secure: true,
		}),
		insecure: createCookie(accountDeviceSignInCookieNameInsecure, shared),
	}
	return cachedCookies
}

async function serializeDeviceCookie(input: {
	env: Env
	secure: boolean
	deviceCode: string | null
}) {
	const cookies = await getCookies(input.env)
	const cookie = input.secure ? cookies.secure : cookies.insecure
	return input.deviceCode
		? await cookie.serialize(input.deviceCode, {
				secure: input.secure,
				maxAge: accountDeviceCodeTtlSeconds,
			})
		: await cookie.serialize('', {
				secure: input.secure,
				maxAge: 0,
				expires: new Date(0),
			})
}

async function readDeviceRow(request: Request, env: Env) {
	const header = request.headers.get('Cookie')
	if (!header) return null
	const cookies = await getCookies(env)
	for (const cookie of [cookies.secure, cookies.insecure]) {
		const value = await cookie.parse(header)
		if (typeof value !== 'string' || !value.startsWith('kody_dc_')) continue
		const row = await findDeviceAuthorizationByDeviceCodeHash(
			env.APP_DB,
			await hashDeviceCode(value),
		)
		return row?.kind === 'account' ? row : null
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

export type AccountDeviceSignInError = 'rate_limited' | 'invalid_request'

function devicePagePath(error?: AccountDeviceSignInError) {
	return error
		? `${accountDeviceSignInPath}?error=${error}`
		: accountDeviceSignInPath
}

/** `POST /login/device` from `/login`: ask for a full-account sign-in code. */
export async function startAccountDeviceSignIn(input: {
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
	if (!form) return seeOther(devicePagePath('invalid_request'))
	const redirectToValue = form.get('redirectTo')
	const redirectTo = normalizeRedirectTo(
		typeof redirectToValue === 'string' ? redirectToValue : null,
	)
	const ip = getRequestIp(request) ?? 'unknown'
	const limit = await checkRateLimit(
		env.APP_DB,
		`oauth-device:account-start:ip:${ip}`,
		accountDeviceStartRateLimit,
	)
	if (!limit.allowed) return seeOther(devicePagePath('rate_limited'))

	const now = nowSeconds()
	await purgeExpiredDeviceAuthorizations(env.APP_DB, now)
	const deviceCode = generateDeviceCode()
	const deviceCodeHash = await hashDeviceCode(deviceCode)
	const details: AccountDeviceRequest = {
		v: 1,
		requester: describeRequestingBrowser(request.headers.get('User-Agent')),
		location: readRequestLocation(request),
		redirectTo,
		rememberMe: form.get('rememberMe') === 'on',
	}
	const appOrigin = getAppBaseUrl({ env, requestUrl: request.url })
	let inserted = false
	for (let attempt = 0; attempt < 5 && !inserted; attempt += 1) {
		inserted = await insertDeviceAuthorization(env.APP_DB, {
			id: crypto.randomUUID(),
			device_code_hash: deviceCodeHash,
			user_code: generateUserCode(),
			client_id: accountDeviceClientId,
			scope: '',
			resource: new URL(appOrigin).origin,
			requested_org_slug: null,
			interval_seconds: accountDeviceRefreshSeconds,
			created_at: now,
			expires_at: now + accountDeviceCodeTtlSeconds,
			kind: 'account',
			request_json: JSON.stringify(details),
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
		category: 'auth',
		action: 'account_device_authorization',
		result: 'success',
		ip,
	})
	return seeOther(devicePagePath(), [
		await serializeDeviceCookie({
			env,
			secure: isSecureRequest(request),
			deviceCode,
		}),
	])
}

function startAgainUrl(details: AccountDeviceRequest | null) {
	const redirectTo = details?.redirectTo
	return redirectTo
		? `/login?redirectTo=${encodeURIComponent(redirectTo)}`
		: '/login'
}

export type AccountDeviceSignInView =
	| { kind: 'none'; error: AccountDeviceSignInError | null }
	| {
			kind: 'pending'
			userCode: string
			verificationUri: string
			verificationUriComplete: string
			qr: { size: number; path: string }
			/** Whole minutes left, rounded up, computed on the server. */
			minutesLeft: number
			refreshSeconds: number
	  }
	| { kind: 'denied' | 'expired'; startAgainUrl: string }

/** Loader view for the asking browser's `/login/device` page. */
export async function loadAccountDeviceSignInView(input: {
	request: Request
	env: Env
	error: string | null
}): Promise<AccountDeviceSignInView> {
	const row = await readDeviceRow(input.request, input.env)
	const error =
		input.error === 'rate_limited' || input.error === 'invalid_request'
			? input.error
			: null
	if (!row || row.status === 'consumed') return { kind: 'none', error }
	const now = nowSeconds()
	if (row.status === 'denied' || row.expires_at <= now) {
		return {
			kind: row.status === 'denied' ? 'denied' : 'expired',
			startAgainUrl: startAgainUrl(parseAccountDeviceRequest(row)),
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
		userCode,
		verificationUri: verificationUri.href,
		verificationUriComplete: verificationUriComplete.href,
		qr: buildQrCodePath(verificationUriComplete.href),
		minutesLeft: Math.max(1, Math.ceil((row.expires_at - now) / 60)),
		refreshSeconds: accountDeviceRefreshSeconds,
	}
}

/**
 * Document GET for `/login/device`. An approved request is consumed once and
 * becomes a Kody session cookie on this browser. Returns `{ refreshSeconds }`
 * while the page should keep checking and `{ refreshSeconds: null }` when it
 * should just render.
 */
export async function handleAccountDeviceSignInDocument(input: {
	request: Request
	env: Env
}): Promise<Response | { refreshSeconds: number | null }> {
	const { request, env } = input
	const row = await readDeviceRow(request, env)
	if (!row) return { refreshSeconds: null }
	const now = nowSeconds()
	if (row.expires_at <= now || row.status === 'denied') {
		return { refreshSeconds: null }
	}
	if (row.status !== 'pending' && row.status !== 'approved') {
		return { refreshSeconds: null }
	}
	const ip = getRequestIp(request) ?? 'unknown'
	const poll = await checkRateLimit(
		env.APP_DB,
		`oauth-device:account-poll:ip:${ip}`,
		accountDevicePollRateLimit,
	)
	if (!poll.allowed) return { refreshSeconds: accountDeviceSlowRefreshSeconds }
	if (row.status === 'pending') {
		return { refreshSeconds: accountDeviceRefreshSeconds }
	}
	if (!(await consumeApprovedDeviceAuthorization(env.APP_DB, row.id, now))) {
		return { refreshSeconds: null }
	}
	const fail = (reason: string) => {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'account_device_login',
			result: 'failure',
			ip,
			reason,
		})
		return { refreshSeconds: null }
	}
	const details = parseAccountDeviceRequest(row)
	if (!details || !row.user_id) return fail('invalid_row')
	const user = await createDb(env.APP_DB).findOne(usersTable, {
		where: { stable_user_id: row.user_id },
	})
	if (!user || user.deleted_at) return fail('approver_unavailable')
	const stableUserId = personIdFromStored(user.stable_user_id)
	const secure = isSecureRequest(request)
	const sessionCookie = await createAuthCookie(
		{ stableUserId, email: user.email, rememberMe: details.rememberMe },
		secure,
	)
	await touchLastActiveAt(env.APP_DB, { stableUserId })
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'auth',
		action: 'account_device_login',
		result: 'success',
		email: user.email,
		ip,
		path: accountDeviceSignInPath,
	})
	return seeOther(
		resolvePostAuthLandingPath(details.redirectTo) ?? '/account',
		[
			await serializeDeviceCookie({ env, secure, deviceCode: null }),
			sessionCookie,
		],
	)
}

/** What `/device` shows about a pending full-account sign-in. */
export type AccountDeviceVerificationRequest = {
	userCode: string
	requester: string
	location: string | null
	/** Epoch seconds the asking browser requested the code. */
	requestedAt: number
	/** Whole minutes since the request, computed on the server. */
	requestedMinutesAgo: number
	expiresAt: number
	/** The asking browser's country differs from the approver's. */
	differentCountry: boolean
}

export function describeAccountDeviceRequest(input: {
	row: DeviceAuthorizationRow
	approverRequest: Request
	now?: number
}): AccountDeviceVerificationRequest {
	const details = parseAccountDeviceRequest(input.row)
	const now = input.now ?? nowSeconds()
	const askingCountry = details?.location?.country ?? null
	const approverCountry =
		readRequestLocation(input.approverRequest)?.country ?? null
	return {
		userCode: formatUserCode(input.row.user_code),
		requester: details?.requester ?? 'An unknown browser',
		location: formatDeviceLocation(details?.location ?? null),
		requestedAt: input.row.created_at,
		requestedMinutesAgo: Math.max(
			0,
			Math.floor((now - input.row.created_at) / 60),
		),
		expiresAt: input.row.expires_at,
		differentCountry: Boolean(
			askingCountry && approverCountry && askingCountry !== approverCountry,
		),
	}
}

/**
 * Emails the account after a full-account device sign-in is approved, so a
 * person tricked into approving someone else's code finds out right away.
 */
export async function notifyAccountDeviceSignInApproved(input: {
	env: Env
	requestUrl: string
	email: string
	row: DeviceAuthorizationRow
	approvedAt?: Date
}) {
	const config = resolveTransactionalEmailConfig({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	if (!config) {
		console.warn('account-device-sign-in-notice-skipped', 'no email config')
		return
	}
	const details = parseAccountDeviceRequest(input.row)
	const systemDomain = getSystemEmailDomain(input.env)
	const email = buildAccountDeviceSignInApprovedEmail({
		appBaseUrl: config.appBaseUrl,
		email: input.email,
		approvedAt: input.approvedAt ?? new Date(),
		requester: details?.requester ?? 'An unknown browser',
		location: formatDeviceLocation(details?.location ?? null),
		accountUrl: new URL('/account', config.appBaseUrl).toString(),
		resetPasswordUrl: new URL('/reset-password', config.appBaseUrl).toString(),
		supportEmail: systemDomain ? `support@${systemDomain}` : undefined,
	})
	try {
		const result = await sendGatedTransactionalEmail({
			db: input.env.APP_DB,
			config: {
				accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
				apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
				apiToken: input.env.CLOUDFLARE_API_TOKEN,
			},
			category: 'essential',
			kind: 'account_device_sign_in',
			message: {
				to: input.email,
				from: config.fromEmail,
				subject: email.subject,
				html: email.html,
				text: email.text,
			},
		})
		// `skipped` means no email API is configured here (local dev, tests).
		if (!result.ok && !result.skipped) {
			console.warn(
				'account-device-sign-in-notice-failed',
				result.error ?? 'send skipped',
			)
		}
	} catch (error) {
		console.warn('account-device-sign-in-notice-error', error)
	}
}
