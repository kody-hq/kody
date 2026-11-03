import { applyD1Migrations, type D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import {
	accountDeviceApproveRateLimit,
	accountDeviceCodeTtlSeconds,
	accountDevicePollRateLimit,
	accountDeviceSlowRefreshSeconds,
	accountDeviceStartRateLimit,
	formatDeviceLocation,
	handleAccountDeviceSignInDocument,
	loadAccountDeviceSignInView,
	startAccountDeviceSignIn,
} from '#app/account-device-sign-in.ts'
import {
	readParsedAuthSession,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import {
	decideDeviceAuthorizationForPerson,
	lookupDeviceAuthorization,
} from '#worker/oauth-device/verification.ts'
import { checkRateLimit } from '#worker/rate-limit.ts'
import { seedAccount } from '#worker/test-support/workers-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { accountDeviceSignInPath } from '#universal/oauth-paths.ts'

const testEnv = env as Env & {
	TEST_MIGRATIONS: Array<D1Migration>
	TEST_AUDIT_MIGRATIONS: Array<D1Migration>
}

const appOrigin = 'https://app.kody.test:8788'
const email = 'account-device@example.com'
const kindleUserAgent =
	'Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.149 Safari/537.36 Kindle/3.0'
const person = { personId: testStableUserIdFromEmail(email), email }
let nextIp = 1

beforeAll(async () => {
	await applyD1Migrations(testEnv.APP_DB, testEnv.TEST_MIGRATIONS)
	await applyD1Migrations(testEnv.AUDIT_DB, testEnv.TEST_AUDIT_MIGRATIONS)
	const mutableEnv = env as unknown as Record<string, string | undefined>
	mutableEnv.APP_BASE_URL = appOrigin
	mutableEnv.SENTRY_ENVIRONMENT = 'test'
	await seedAccount({ db: env.APP_DB, email, username: 'accountdevice' })
	setAuthSessionSecret(env.COOKIE_SECRET)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

function freshIp() {
	nextIp += 1
	return `203.0.113.${nextIp}`
}

/** The limited browser presses "Sign in on another device" on `/login`. */
async function startOnLimitedBrowser(
	input: { ip?: string; redirectTo?: string; rememberMe?: boolean } = {},
) {
	const body = new URLSearchParams()
	if (input.redirectTo) body.set('redirectTo', input.redirectTo)
	if (input.rememberMe) body.set('rememberMe', 'on')
	return startAccountDeviceSignIn({
		env,
		request: new Request(`${appOrigin}${accountDeviceSignInPath}`, {
			method: 'POST',
			headers: {
				Origin: appOrigin,
				'Content-Type': 'application/x-www-form-urlencoded',
				'User-Agent': kindleUserAgent,
				'CF-Connecting-IP': input.ip ?? freshIp(),
			},
			body,
			cf: { city: 'Lehi', region: 'Utah', country: 'US' },
		}),
	})
}

async function started(input: Parameters<typeof startOnLimitedBrowser>[0]) {
	const response = await startOnLimitedBrowser(input)
	expect(response.status).toBe(303)
	expect(response.headers.get('Location')).toBe(accountDeviceSignInPath)
	const cookie = response.headers.get('Set-Cookie')?.split(';')[0] ?? ''
	expect(cookie).toMatch(/^__Host-kody_account_device=/)
	return cookie
}

function limitedRequest(cookie: string, ip = '198.51.100.40') {
	return new Request(`${appOrigin}${accountDeviceSignInPath}`, {
		headers: { Cookie: cookie, 'CF-Connecting-IP': ip },
	})
}

async function pendingCode(cookie: string) {
	const view = await loadAccountDeviceSignInView({
		env,
		request: limitedRequest(cookie),
		error: null,
	})
	if (view.kind !== 'pending') throw new Error(`Expected pending, ${view.kind}`)
	return view
}

function approverRequest(country = 'US') {
	return new Request(`${appOrigin}/device`, {
		headers: { 'CF-Connecting-IP': freshIp() },
		cf: { country },
	})
}

function decide(
	userCode: string,
	decision: 'approve' | 'deny',
	confirmFullAccount: boolean,
) {
	return decideDeviceAuthorizationForPerson({
		request: approverRequest(),
		env,
		user: person,
		userCode,
		decision,
		orgSlug: null,
		confirmFullAccount,
	})
}

async function clearApproveLimit() {
	await env.APP_DB.prepare(
		`DELETE FROM _rate_limits WHERE key LIKE 'oauth-device:account-approve:%'`,
	)
		.run()
		.catch(() => undefined)
}

test('an approved full-account sign-in signs the browser in once and emails the account', async () => {
	await clearApproveLimit()
	const sent: Array<string> = []
	const mutableEnv = env as unknown as Record<string, string | undefined>
	mutableEnv.CLOUDFLARE_ACCOUNT_ID = 'test-account'
	mutableEnv.CLOUDFLARE_API_TOKEN = 'test-token'
	mutableEnv.CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.test/client/v4'
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			sent.push(`${String(input)} ${String(init?.body ?? '')}`)
			return Response.json({ success: true, result: {} })
		}),
	)

	const cookie = await started({ redirectTo: '/account/billing' })
	const view = await pendingCode(cookie)
	expect(view.userCode).toMatch(/^[B-Z]{4}-[B-Z]{4}$/)
	expect(view.verificationUriComplete).toBe(
		`${appOrigin}/device?user_code=${view.userCode}`,
	)
	expect(view.minutesLeft).toBe(accountDeviceCodeTtlSeconds / 60)
	await expect(
		handleAccountDeviceSignInDocument({ env, request: limitedRequest(cookie) }),
	).resolves.toEqual({ refreshSeconds: 5 })

	const lookup = await lookupDeviceAuthorization({
		request: approverRequest('CA'),
		env,
		user: person,
		userCode: view.userCode,
	})
	expect(lookup).toMatchObject({
		kind: 'account',
		request: {
			userCode: view.userCode,
			requester: 'Kindle browser (Chrome 80)',
			location: 'Lehi, Utah, US',
			requestedMinutesAgo: 0,
			differentCountry: true,
		},
	})
	if (lookup.kind !== 'account') throw new Error('Expected account lookup')
	expect(Math.abs(lookup.request.requestedAt - Date.now() / 1000)).toBeLessThan(
		60,
	)

	await expect(decide(view.userCode, 'approve', false)).resolves.toEqual({
		kind: 'confirm_required',
	})
	await expect(
		handleAccountDeviceSignInDocument({ env, request: limitedRequest(cookie) }),
	).resolves.toEqual({ refreshSeconds: 5 })
	await expect(decide(view.userCode, 'approve', true)).resolves.toEqual({
		kind: 'approved',
		account: true,
	})

	const finished = await handleAccountDeviceSignInDocument({
		env,
		request: limitedRequest(cookie),
	})
	if (!(finished instanceof Response)) throw new Error('Expected a redirect')
	expect(finished.status).toBe(303)
	expect(finished.headers.get('Location')).toBe('/account/billing')
	const setCookies = finished.headers.getSetCookie()
	expect(
		setCookies.some((c) => c.startsWith('__Host-kody_account_device=;')),
	).toBe(true)
	const session = setCookies.find((c) => !c.includes('kody_account_device'))
	const sessionRequest = new Request(appOrigin, {
		headers: { Cookie: session?.split(';')[0] ?? '' },
	})
	await expect(readParsedAuthSession(sessionRequest)).resolves.toMatchObject({
		session: { email, rememberMe: false },
	})

	await expect(
		handleAccountDeviceSignInDocument({ env, request: limitedRequest(cookie) }),
	).resolves.toEqual({ refreshSeconds: null })
	await expect(
		loadAccountDeviceSignInView({
			env,
			request: limitedRequest(cookie),
			error: null,
		}),
	).resolves.toMatchObject({ kind: 'none' })

	await vi.waitFor(() => {
		expect(
			sent.some((body) =>
				body.includes('A browser signed in to your Kody account'),
			),
		).toBe(true)
	})
	const notice = sent.find((body) =>
		body.includes('A browser signed in to your Kody account'),
	)
	expect(notice).toContain('Kindle browser (Chrome 80)')
	expect(notice).toContain('Lehi, Utah, US')
	delete mutableEnv.CLOUDFLARE_API_TOKEN
	delete mutableEnv.CLOUDFLARE_ACCOUNT_ID
})

test('remember-me on the asking browser carries into the session', async () => {
	await clearApproveLimit()
	const cookie = await started({ rememberMe: true })
	const { userCode } = await pendingCode(cookie)
	await decide(userCode, 'approve', true)
	const finished = await handleAccountDeviceSignInDocument({
		env,
		request: limitedRequest(cookie),
	})
	if (!(finished instanceof Response)) throw new Error('Expected a redirect')
	expect(finished.headers.get('Location')).toBe('/account')
	const session = finished.headers
		.getSetCookie()
		.find((c) => !c.includes('kody_account_device'))
	expect(session).toMatch(/Max-Age=\d+/)
	await expect(
		readParsedAuthSession(
			new Request(appOrigin, {
				headers: { Cookie: session?.split(';')[0] ?? '' },
			}),
		),
	).resolves.toMatchObject({ session: { rememberMe: true } })
})

test('a denied full-account sign-in leaves the browser signed out', async () => {
	const cookie = await started({})
	const { userCode } = await pendingCode(cookie)
	await expect(decide(userCode, 'deny', false)).resolves.toEqual({
		kind: 'denied',
		account: true,
	})
	await expect(
		handleAccountDeviceSignInDocument({ env, request: limitedRequest(cookie) }),
	).resolves.toEqual({ refreshSeconds: null })
	await expect(
		loadAccountDeviceSignInView({
			env,
			request: limitedRequest(cookie),
			error: null,
		}),
	).resolves.toEqual({ kind: 'denied', startAgainUrl: '/login' })
})

test('an expired code cannot be approved', async () => {
	const cookie = await started({ redirectTo: '/account' })
	const { userCode } = await pendingCode(cookie)
	await env.APP_DB.prepare(
		'UPDATE oauth_device_authorizations SET expires_at = ? WHERE user_code = ?',
	)
		.bind(Math.floor(Date.now() / 1000) - 1, userCode.replace('-', ''))
		.run()
	await expect(decide(userCode, 'approve', true)).resolves.toEqual({
		kind: 'not_found',
	})
	await expect(
		loadAccountDeviceSignInView({
			env,
			request: limitedRequest(cookie),
			error: null,
		}),
	).resolves.toEqual({
		kind: 'expired',
		startAgainUrl: '/login?redirectTo=%2Faccount',
	})
})

test('starting is limited per network and refused cross-origin', async () => {
	const ip = freshIp()
	for (let i = 0; i < accountDeviceStartRateLimit.maxRequests; i += 1) {
		await started({ ip })
	}
	const limited = await startOnLimitedBrowser({ ip })
	expect(limited.headers.get('Location')).toBe(
		`${accountDeviceSignInPath}?error=rate_limited`,
	)
	expect(limited.headers.get('Set-Cookie')).toBeNull()

	const crossOrigin = await startAccountDeviceSignIn({
		env,
		request: new Request(`${appOrigin}${accountDeviceSignInPath}`, {
			method: 'POST',
			headers: {
				Origin: 'https://evil.example',
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams(),
		}),
	})
	expect(crossOrigin.status).toBe(403)
})

test('checking too often slows the asking browser down', async () => {
	const cookie = await started({})
	const ip = freshIp()
	for (let i = 0; i < accountDevicePollRateLimit.maxRequests; i += 1) {
		await checkRateLimit(
			env.APP_DB,
			`oauth-device:account-poll:ip:${ip}`,
			accountDevicePollRateLimit,
		)
	}
	await expect(
		handleAccountDeviceSignInDocument({
			env,
			request: limitedRequest(cookie, ip),
		}),
	).resolves.toEqual({ refreshSeconds: accountDeviceSlowRefreshSeconds })
})

test('approvals are limited per person', async () => {
	await clearApproveLimit()
	for (let i = 0; i < accountDeviceApproveRateLimit.maxRequests; i += 1) {
		const { userCode } = await pendingCode(await started({}))
		await expect(decide(userCode, 'approve', true)).resolves.toMatchObject({
			kind: 'approved',
		})
	}
	const { userCode } = await pendingCode(await started({}))
	await expect(decide(userCode, 'approve', true)).resolves.toMatchObject({
		kind: 'rate_limited',
	})
	// Denying is never limited.
	await expect(decide(userCode, 'deny', false)).resolves.toMatchObject({
		kind: 'denied',
	})
	await clearApproveLimit()
})

test('an account code is not a CLI or package-app code', async () => {
	const { userCode } = await pendingCode(await started({}))
	const row = await env.APP_DB.prepare(
		`SELECT kind, client_id FROM oauth_device_authorizations WHERE user_code = ?`,
	)
		.bind(userCode.replace('-', ''))
		.first<{ kind: string; client_id: string }>()
	expect(row).toEqual({ kind: 'account', client_id: 'kody-account' })
})

test('locations read as city, region, country', () => {
	expect(
		formatDeviceLocation({ city: 'Lehi', region: 'Utah', country: 'US' }),
	).toBe('Lehi, Utah, US')
	expect(
		formatDeviceLocation({ city: null, region: null, country: 'US' }),
	).toBe('US')
	expect(formatDeviceLocation(null)).toBeNull()
})
