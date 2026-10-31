import { applyD1Migrations, type D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, expect, test } from 'vitest'
import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import { consumePackageAppOauthCode } from '#app/package-app-oauth-codes.ts'
import { createS256CodeChallenge } from '#app/package-app-oauth-pkce-cookie.ts'
import { handlePackageAppOauthAuthorizeRequest } from '#app/package-app-oauth-authorize.ts'
import {
	handlePackageAppDeviceSignInDocument,
	loadPackageAppDeviceSignInView,
	startPackageAppDeviceSignIn,
} from '#app/package-app-device-sign-in.ts'
import {
	decideDeviceAuthorizationForPerson,
	lookupDeviceAuthorization,
} from '#worker/oauth-device/verification.ts'
import { seedAccount } from '#worker/test-support/workers-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { packageAppOauthPaths } from '#universal/package-app-oauth-paths.ts'

const testEnv = env as Env & {
	TEST_MIGRATIONS: Array<D1Migration>
	TEST_AUDIT_MIGRATIONS: Array<D1Migration>
}

const appOrigin = 'https://app.kody.test:8788'
const ownerEmail = 'pkg-device-owner@example.com'
const ownerUsername = 'pkgdevice'
const visitorEmail = 'pkg-device-visitor@example.com'
const visitorUsername = 'pkgdevicevisitor'
const verifier = 'device-sign-in-test-verifier-0123456789abcdef'
const redirectUri = `https://${ownerUsername}.packages.isolated.test${packageAppOauthPaths.callback}`
const kindleUserAgent =
	'Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.149 Safari/537.36 Kindle/3.0'

let visitorCookie = ''

beforeAll(async () => {
	await applyD1Migrations(testEnv.APP_DB, testEnv.TEST_MIGRATIONS)
	await applyD1Migrations(testEnv.AUDIT_DB, testEnv.TEST_AUDIT_MIGRATIONS)
	const mutableEnv = env as unknown as Record<string, string | undefined>
	mutableEnv.APP_BASE_URL = appOrigin
	mutableEnv.PACKAGE_APP_BASE_URL = 'https://packages.isolated.test'
	mutableEnv.SENTRY_ENVIRONMENT = 'test'
	await seedAccount({
		db: env.APP_DB,
		email: ownerEmail,
		username: ownerUsername,
	})
	await seedAccount({
		db: env.APP_DB,
		email: visitorEmail,
		username: visitorUsername,
	})
	const now = '2026-10-30T00:00:00.000Z'
	await env.APP_DB.prepare(
		`INSERT OR REPLACE INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, hidden, is_private, is_internet_visible,
			created_at, updated_at
		) VALUES (?, ?, ?, 'notes', '', '[]', NULL, ?, 1, 0, 1, 0, ?, ?)`,
	)
		.bind(
			'pkg-device-notes',
			testStableUserIdFromEmail(ownerEmail),
			`@${ownerUsername}/notes`,
			'src-device-notes',
			now,
			now,
		)
		.run()
	setAuthSessionSecret(env.COOKIE_SECRET)
	visitorCookie =
		(
			await createAuthCookie(
				{
					stableUserId: testStableUserIdFromEmail(visitorEmail),
					email: visitorEmail,
					rememberMe: false,
				},
				true,
			)
		).split(';')[0] ?? ''
})

async function authorizePath(state: string) {
	const url = new URL(packageAppOauthPaths.authorize, appOrigin)
	url.searchParams.set('response_type', 'code')
	url.searchParams.set('client_id', `${ownerUsername}/notes`)
	url.searchParams.set('redirect_uri', redirectUri)
	url.searchParams.set('state', state)
	url.searchParams.set(
		'code_challenge',
		await createS256CodeChallenge(verifier),
	)
	url.searchParams.set('code_challenge_method', 'S256')
	url.searchParams.set('scope', 'profile email')
	return `${url.pathname}${url.search}`
}

/** The limited browser presses "Sign in on another device". */
async function startOnLimitedBrowser(state: string, ip = '198.51.100.7') {
	const response = await startPackageAppDeviceSignIn({
		env,
		request: new Request(`${appOrigin}${packageAppOauthPaths.device}`, {
			method: 'POST',
			headers: {
				Origin: appOrigin,
				'Content-Type': 'application/x-www-form-urlencoded',
				'User-Agent': kindleUserAgent,
				'CF-Connecting-IP': ip,
			},
			body: new URLSearchParams({ authorize: await authorizePath(state) }),
		}),
	})
	expect(response.status).toBe(303)
	expect(response.headers.get('Location')).toBe(packageAppOauthPaths.device)
	const cookie = response.headers.get('Set-Cookie')?.split(';')[0] ?? ''
	expect(cookie).toMatch(/kody_pkg_device=/)
	return cookie
}

function limitedRequest(cookie: string) {
	return new Request(`${appOrigin}${packageAppOauthPaths.device}`, {
		headers: { Cookie: cookie },
	})
}

async function pendingCode(cookie: string) {
	const view = await loadPackageAppDeviceSignInView({
		env,
		request: limitedRequest(cookie),
		error: null,
	})
	if (view.kind !== 'pending') throw new Error(`Expected pending, ${view.kind}`)
	return view
}

/** The visitor decides on their signed-in phone, on the app's consent page. */
async function decideOnPhone(userCode: string, decision: 'approve' | 'deny') {
	return handlePackageAppOauthAuthorizeRequest(
		new Request(`${appOrigin}${packageAppOauthPaths.authorize}`, {
			method: 'POST',
			headers: {
				Cookie: visitorCookie,
				Origin: appOrigin,
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				device_user_code: userCode,
				selected_scopes: 'profile email',
				decision,
			}),
		}),
		env,
	)
}

test('an approved device sign-in lands the limited browser on the app callback, once', async () => {
	const cookie = await startOnLimitedBrowser('state-approve')
	const view = await pendingCode(cookie)
	expect(view.userCode).toMatch(/^[B-Z]{4}-[B-Z]{4}$/)
	expect(view.verificationUriComplete).toBe(
		`${appOrigin}/device?user_code=${view.userCode}`,
	)
	expect(view.qr.path.length).toBeGreaterThan(100)
	expect(view.appDomain).toBe(`${ownerUsername}.packages.isolated.test`)
	await expect(
		handlePackageAppDeviceSignInDocument({
			env,
			request: limitedRequest(cookie),
		}),
	).resolves.toEqual({ pending: true })

	const consent = await handlePackageAppOauthAuthorizeRequest(
		new Request(
			`${appOrigin}${packageAppOauthPaths.authorize}?device_user_code=${view.userCode}`,
			{ headers: { Cookie: visitorCookie } },
		),
		env,
	)
	if (consent instanceof Response) throw new Error('Expected consent data')
	expect(consent.consent).toMatchObject({
		clientId: `${ownerUsername}/notes`,
		redirectUri,
		hiddenFields: { device_user_code: view.userCode },
		device: {
			userCode: view.userCode,
			requester: 'Kindle browser (Chrome 80)',
		},
	})

	const decided = await decideOnPhone(view.userCode, 'approve')
	if (!(decided instanceof Response)) throw new Error('Expected a redirect')
	expect(decided.status).toBe(303)
	expect(decided.headers.get('Location')).toBe(
		'/device?result=approved&kind=package_app',
	)

	const finished = await handlePackageAppDeviceSignInDocument({
		env,
		request: limitedRequest(cookie),
	})
	if (!(finished instanceof Response)) throw new Error('Expected a redirect')
	expect(finished.status).toBe(303)
	expect(finished.headers.get('Set-Cookie')).toMatch(/kody_pkg_device=;/)
	const target = new URL(finished.headers.get('Location') ?? '')
	expect(`${target.origin}${target.pathname}`).toBe(redirectUri)
	expect(target.searchParams.get('state')).toBe('state-approve')
	const record = await consumePackageAppOauthCode({
		env,
		code: target.searchParams.get('code') ?? '',
		redirectUri,
		codeVerifier: verifier,
	})
	expect(record).toMatchObject({
		personId: testStableUserIdFromEmail(visitorEmail),
		username: visitorUsername,
		orgUsername: ownerUsername,
		kodyId: 'notes',
		scopes: expect.arrayContaining(['profile', 'email']),
	})
	const grant = await env.APP_DB.prepare(
		`SELECT scopes FROM package_app_oauth_grants
		 WHERE person_id = ? AND kody_id = 'notes' AND revoked_at IS NULL`,
	)
		.bind(testStableUserIdFromEmail(visitorEmail))
		.first<{ scopes: string }>()
	expect(grant?.scopes).toContain('email')

	// Single use: the same browser cookie cannot mint a second code.
	await expect(
		handlePackageAppDeviceSignInDocument({
			env,
			request: limitedRequest(cookie),
		}),
	).resolves.toEqual({ pending: false })
	await expect(
		loadPackageAppDeviceSignInView({
			env,
			request: limitedRequest(cookie),
			error: null,
		}),
	).resolves.toMatchObject({ kind: 'none' })
})

test('a denied device sign-in shares nothing and offers to start again', async () => {
	const cookie = await startOnLimitedBrowser('state-deny', '198.51.100.8')
	const { userCode } = await pendingCode(cookie)
	const decided = await decideOnPhone(userCode, 'deny')
	if (!(decided instanceof Response)) throw new Error('Expected a redirect')
	expect(decided.headers.get('Location')).toBe(
		'/device?result=denied&kind=package_app',
	)
	await expect(
		handlePackageAppDeviceSignInDocument({
			env,
			request: limitedRequest(cookie),
		}),
	).resolves.toEqual({ pending: false })
	const view = await loadPackageAppDeviceSignInView({
		env,
		request: limitedRequest(cookie),
		error: null,
	})
	expect(view).toMatchObject({ kind: 'denied', appName: 'notes' })
	if (view.kind !== 'denied') throw new Error('Expected denied')
	const startAgain = new URL(view.startAgainUrl)
	expect(startAgain.pathname).toBe(packageAppOauthPaths.login)
	expect(startAgain.searchParams.get('app')).toBe('notes')
})

test('an expired device code cannot be approved and asks the browser to start again', async () => {
	const cookie = await startOnLimitedBrowser('state-expire', '198.51.100.9')
	const { userCode } = await pendingCode(cookie)
	await env.APP_DB.prepare(
		`UPDATE oauth_device_authorizations SET expires_at = ? WHERE user_code = ?`,
	)
		.bind(Math.floor(Date.now() / 1000) - 1, userCode.replace('-', ''))
		.run()
	const decided = await decideOnPhone(userCode, 'approve')
	if (!(decided instanceof Response)) throw new Error('Expected a redirect')
	expect(decided.headers.get('Location')).toMatch(
		/^\/device\?.*error=not_found/,
	)
	await expect(
		loadPackageAppDeviceSignInView({
			env,
			request: limitedRequest(cookie),
			error: null,
		}),
	).resolves.toMatchObject({ kind: 'expired' })
})

test('the CLI device paths never approve or redeem an app visitor code', async () => {
	const cookie = await startOnLimitedBrowser('state-cli', '198.51.100.10')
	const { userCode } = await pendingCode(cookie)
	const user = {
		personId: testStableUserIdFromEmail(visitorEmail),
		email: visitorEmail,
	}
	const request = new Request(`${appOrigin}/device`)
	await expect(
		lookupDeviceAuthorization({ request, env, user, userCode }),
	).resolves.toEqual({ kind: 'package_app', userCode })
	await expect(
		decideDeviceAuthorizationForPerson({
			request,
			env,
			user,
			userCode,
			decision: 'approve',
			orgSlug: null,
		}),
	).resolves.toEqual({ kind: 'not_found' })
	await expect(pendingCode(cookie)).resolves.toMatchObject({ userCode })
})

test('a cross-origin start is refused', async () => {
	const response = await startPackageAppDeviceSignIn({
		env,
		request: new Request(`${appOrigin}${packageAppOauthPaths.device}`, {
			method: 'POST',
			headers: {
				Origin: 'https://evil.example',
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({ authorize: await authorizePath('x') }),
		}),
	})
	expect(response.status).toBe(403)
	expect(response.headers.get('Set-Cookie')).toBeNull()
})

function startFromPackagePath(target: string, ip: string) {
	return startPackageAppDeviceSignIn({
		env,
		request: new Request(`${appOrigin}${packageAppOauthPaths.device}`, {
			method: 'POST',
			headers: {
				Origin: appOrigin,
				'Content-Type': 'application/x-www-form-urlencoded',
				'User-Agent': kindleUserAgent,
				'CF-Connecting-IP': ip,
			},
			body: new URLSearchParams({ authorize: target }),
		}),
	})
}

function cookiePair(response: Response, name: string) {
	return (
		response.headers
			.getSetCookie()
			.find((cookie) => {
				const cookieName = cookie.split('=')[0]
				return cookieName === name || cookieName === `__Host-${name}`
			})
			?.split(';')[0] ?? ''
	)
}

test('a package app Open link starts on the app host and resumes as a device sign-in', async () => {
	const started = await startFromPackagePath(
		`/@${ownerUsername}/packages/notes/open/today?view=list`,
		'198.51.100.21',
	)
	// A page, not a redirect: `form-action 'self'` blocks a redirect from the
	// form POST to the app host.
	expect(started.status).toBe(200)
	const refresh = started.headers.get('Refresh') ?? ''
	expect(refresh).toMatch(/^0; url=/)
	const signInStart = new URL(refresh.replace(/^0; url=/, ''))
	expect(await started.text()).toContain('Continue')
	expect(`${signInStart.origin}${signInStart.pathname}`).toBe(
		`https://${ownerUsername}.packages.isolated.test${packageAppOauthPaths.login}`,
	)
	expect(signInStart.searchParams.get('app')).toBe('notes')
	expect(signInStart.searchParams.get('return_to')).toBe(
		'/notes/today?view=list',
	)
	const intent = cookiePair(started, 'kody_pkg_device_intent')
	expect(intent).toMatch(/kody_pkg_device_intent=./)
	expect(cookiePair(started, 'kody_pkg_device')).toBe('')

	// The app host's sign-in start sends the browser back to authorize with a
	// fresh PKCE request; the intent turns that into the device code page.
	const resumed = await handlePackageAppOauthAuthorizeRequest(
		new Request(`${appOrigin}${await authorizePath('state-open-link')}`, {
			headers: { Cookie: intent, 'User-Agent': kindleUserAgent },
		}),
		env,
	)
	if (!(resumed instanceof Response)) throw new Error('Expected a redirect')
	expect(resumed.status).toBe(303)
	expect(resumed.headers.get('Location')).toBe(packageAppOauthPaths.device)
	expect(cookiePair(resumed, 'kody_pkg_device_intent')).toMatch(
		/^(__Host-)?kody_pkg_device_intent=$/,
	)
	const deviceCookie = cookiePair(resumed, 'kody_pkg_device')
	const view = await pendingCode(deviceCookie)
	expect(view.appDomain).toBe(`${ownerUsername}.packages.isolated.test`)

	const decided = await decideOnPhone(view.userCode, 'approve')
	if (!(decided instanceof Response)) throw new Error('Expected a redirect')
	expect(decided.status).toBe(303)
	const finished = await handlePackageAppDeviceSignInDocument({
		env,
		request: limitedRequest(deviceCookie),
	})
	if (!(finished instanceof Response)) throw new Error('Expected a redirect')
	const callback = new URL(finished.headers.get('Location') ?? '')
	expect(`${callback.origin}${callback.pathname}`).toBe(redirectUri)
	expect(callback.searchParams.get('state')).toBe('state-open-link')
})

test('authorize still asks for sign-in without an intent for that app', async () => {
	const plain = await handlePackageAppOauthAuthorizeRequest(
		new Request(`${appOrigin}${await authorizePath('state-no-intent')}`),
		env,
	)
	if (!(plain instanceof Response)) throw new Error('Expected a redirect')
	expect(plain.status).toBe(302)
	expect(new URL(plain.headers.get('Location') ?? '').pathname).toBe('/login')

	const otherApp = await startFromPackagePath(
		`/@${ownerUsername}/packages/other-app/open`,
		'198.51.100.22',
	)
	const otherIntent = cookiePair(otherApp, 'kody_pkg_device_intent')
	expect(otherIntent).toMatch(/kody_pkg_device_intent=./)
	const mismatched = await handlePackageAppOauthAuthorizeRequest(
		new Request(`${appOrigin}${await authorizePath('state-other-intent')}`, {
			headers: { Cookie: otherIntent },
		}),
		env,
	)
	if (!(mismatched instanceof Response)) throw new Error('Expected a redirect')
	expect(mismatched.status).toBe(302)
	expect(new URL(mismatched.headers.get('Location') ?? '').pathname).toBe(
		'/login',
	)

	// A hand-made intent value is not signed, so it is ignored.
	const forged = await handlePackageAppOauthAuthorizeRequest(
		new Request(`${appOrigin}${await authorizePath('state-forged')}`, {
			headers: { Cookie: `kody_pkg_device_intent=${ownerUsername}%2Fnotes` },
		}),
		env,
	)
	if (!(forged instanceof Response)) throw new Error('Expected a redirect')
	expect(forged.status).toBe(302)
})

test('only package app targets can start a device sign-in', async () => {
	for (const target of [
		'/account',
		'//evil.example/@someone/packages/app',
		'https://evil.example/@someone/packages/app',
		'/oauth/authorize?client_id=x',
	]) {
		const response = await startFromPackagePath(target, '198.51.100.23')
		expect(response.status).toBe(303)
		expect(response.headers.get('Location')).toBe(
			`${packageAppOauthPaths.device}?error=invalid_request`,
		)
		expect(response.headers.getSetCookie()).toEqual([])
	}
})
