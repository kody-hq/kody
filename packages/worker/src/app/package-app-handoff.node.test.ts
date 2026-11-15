import { expect, test } from 'vitest'
import { createCookie } from 'remix/cookie'
import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'
import {
	createAuthCookie,
	readParsedAuthSession,
	resetAuthSessionSecretForTests,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import {
	consumePackageAppHandoffToken,
	createPackageAppHandoffToken,
} from '#app/package-app-handoff.ts'
import {
	createPackageAppSessionCookie,
	readPackageAppSession,
	resetPackageAppSessionCookieForTests,
} from '#app/package-app-session.ts'
import {
	consoleWarn,
	silenceExpectedConsoleWarns,
} from '#worker/test-support/console-spies.ts'

const cookieSecret = 'PACKAGE_APP_TEST_COOKIE_SECRET_32_CHARS_MINIMUM'
const ownerStableUserId = '1'.repeat(64)

function createTestEnv(input: { cookieSecret?: string; kv?: boolean } = {}) {
	const store = new Map<string, string>()
	const kv = {
		get: async (key: string) => store.get(key) ?? null,
		put: async (key: string, value: string) => {
			store.set(key, value)
		},
	}
	return {
		COOKIE_SECRET: input.cookieSecret ?? cookieSecret,
		...(input.kv === false ? {} : { BUNDLE_ARTIFACTS_KV: kv }),
	} as unknown as Env
}

const claims = {
	stableUserId: ownerStableUserId,
	username: 'owner',
	kodyId: 'daily-notes',
}

const expected = { username: claims.username, kodyId: claims.kodyId }
// Relative to the real clock: consume rejects a parent session that has
// already expired by Date.now().
const sessionExpiresAt = Date.now() + 24 * 60 * 60 * 1000
const consumed = { ...claims, sessionExpiresAt }

function mintToken(
	env: Env,
	input: { now?: number; sessionExpiresAt?: number } = {},
) {
	return createPackageAppHandoffToken({
		env,
		claims,
		sessionExpiresAt: input.sessionExpiresAt ?? sessionExpiresAt,
		now: input.now,
	})
}

test('handoff tokens are single use, short lived, and bound to one user and package', async () => {
	silenceExpectedConsoleWarns(['Package app handoff rejected.'])
	const env = createTestEnv()
	const consume = (
		token: string,
		input: { env?: Env; expected?: typeof expected; now?: number } = {},
	) => consumePackageAppHandoffToken({ env, token, expected, ...input })

	const token = await mintToken(env)
	await expect(consume(token)).resolves.toStrictEqual(consumed)

	// Burned on first use, so a token captured from browser history or a referrer
	// cannot be replayed.
	await expect(consume(token)).resolves.toBeNull()
	expect(consoleWarn).toHaveBeenCalledWith('Package app handoff rejected.', {
		reason: 'replay',
	})

	// Expired tokens fail closed, even unused ones.
	await expect(
		consume(await mintToken(env, { now: Date.now() - 61_000 })),
	).resolves.toBeNull()

	// Tampering with the payload (for example to point at another user's package)
	// invalidates the signature, as do malformed shapes.
	const [payload = '', signature = ''] = (await mintToken(env)).split('.')
	expect(payload && signature).toBeTruthy()
	const forgedPayload = Buffer.from(
		JSON.stringify({
			...(JSON.parse(
				Buffer.from(payload, 'base64url').toString('utf8'),
			) as Record<string, unknown>),
			usr: 'attacker',
		}),
	).toString('base64url')
	for (const forged of [
		`${forgedPayload}.${signature}`,
		`${payload}.${signature}extra`,
		payload,
		`${payload}.${signature}.${signature}`,
		'not-a-token',
	]) {
		expect({ forged, result: await consume(forged) }).toEqual({
			forged,
			result: null,
		})
	}

	// A token minted under a different COOKIE_SECRET is not accepted.
	const otherEnv = createTestEnv({
		cookieSecret: 'ANOTHER_TEST_COOKIE_SECRET_32_CHARS_MINIMUM_OK',
	})
	await expect(consume(await mintToken(otherEnv))).resolves.toBeNull()

	// A token aimed at another package (or another user) is refused *without*
	// being burned: it was never meant for this request, so a mistyped URL must
	// not cost the owner the handoff they still hold.
	const boundToken = await mintToken(env)
	for (const wrongTarget of [
		{ username: 'someone-else', kodyId: claims.kodyId },
		{ username: claims.username, kodyId: 'other-package' },
	]) {
		await expect(
			consume(boundToken, { expected: wrongTarget }),
		).resolves.toBeNull()
	}
	await expect(consume(boundToken)).resolves.toStrictEqual(consumed)

	// Replay protection needs KV; signature and expiry checks do not.
	const envWithoutKv = createTestEnv({ kv: false })
	await expect(
		consume(await mintToken(envWithoutKv), { env: envWithoutKv }),
	).resolves.toStrictEqual(consumed)

	// Missing COOKIE_SECRET must throw rather than look like an invalid token,
	// otherwise the visitor stays on the 403 page with `__kody_handoff` in the URL.
	await expect(
		consume(await mintToken(env), { env: createTestEnv({ cookieSecret: '' }) }),
	).rejects.toThrow(/COOKIE_SECRET/)

	// A token whose parent session has already expired is refused even if the
	// one-minute handoff window is still open.
	await expect(
		consume(await mintToken(env, { sessionExpiresAt: Date.now() - 1 })),
	).resolves.toBeNull()

	// Less than one second of parent TTL cannot become a cookie Max-Age, so
	// consume refuses before burning the token.
	const now = Date.now()
	await expect(
		consume(await mintToken(env, { sessionExpiresAt: now + 500 }), { now }),
	).resolves.toBeNull()
})

test('the package-app session cookie is not interchangeable with the app session cookie', async () => {
	resetPackageAppSessionCookieForTests()
	resetAuthSessionSecretForTests()
	const env = createTestEnv()
	const ownerSession = {
		session: { stableUserId: ownerStableUserId, username: 'owner' },
	}
	const appSlug = 'x'
	const read = (
		cookie: string,
		now?: number,
		url = 'https://owner.kodyapps.dev/packages/x',
		slug = appSlug,
	) =>
		readPackageAppSession({
			request: new Request(url, { headers: { Cookie: cookie } }),
			env,
			slug,
			now,
		})
	const localUrl = 'http://owner.packages.localhost/packages/x'

	// Secure requests get a per-app `__Host-` name, which browsers only accept
	// host-only (`Secure`, no `Domain`, `Path=/`): a sibling package-app
	// subdomain cannot toss a `Domain`-wide cookie under this name.
	const now = 1_700_000_000_000
	const expiresAt = now + 3 * 60 * 60 * 1000
	const mintCookies = (secure: boolean, cookieExpiresAt: number) =>
		createPackageAppSessionCookie({
			env,
			...ownerSession,
			slug: appSlug,
			secure,
			now,
			expiresAt: cookieExpiresAt,
		})
	const setCookies = await mintCookies(true, expiresAt)
	const setCookie = setCookies[0] ?? ''
	const attributes = [
		'__Host-kody_pkg_session_',
		'HttpOnly',
		'SameSite=Lax',
		'Secure',
		'Path=/',
		'Max-Age=10800',
	]
	expect(attributes.filter((part) => !setCookie.includes(part))).toEqual([])
	expect(setCookie).not.toContain('Domain=')
	// Host-wide legacy name must not be written for new sessions.
	expect(setCookie).not.toMatch(/__Host-kody_pkg_session=/)
	expect(
		(await mintCookies(true, now + 30 * 24 * 60 * 60 * 1000))[0],
	).toContain('Max-Age=2592000')

	// Plain-HTTP local development falls back to an unprefixed name because
	// browsers refuse `__Host-` cookies on insecure origins.
	const insecureSetCookie = (await mintCookies(false, expiresAt))[0] ?? ''
	expect(insecureSetCookie).toContain('kody_pkg_session_')
	expect(insecureSetCookie).not.toContain('__Host-')
	await expect(
		read(insecureSetCookie.split(';')[0] ?? '', now, localUrl),
	).resolves.toMatchObject(ownerSession)

	const cookiePair = setCookie.split(';')[0] ?? ''
	const [, cookieValue] = cookiePair.split('=')
	expect(cookieValue).toBeTruthy()
	await expect(read(cookiePair, now)).resolves.toMatchObject({
		...ownerSession,
		expiresAt,
	})
	await expect(read(cookiePair, expiresAt - 1)).resolves.toMatchObject(
		ownerSession,
	)
	await expect(read(cookiePair, expiresAt)).resolves.toBeNull()
	// A session minted for app `x` does not authorize a sibling app on the
	// same host.
	await expect(read(cookiePair, now, undefined, 'other')).resolves.toBeNull()

	// Same secret material, different derived signing key: replaying the
	// package-app cookie value under the app session name does not authenticate.
	setAuthSessionSecret(cookieSecret)
	await expect(
		readParsedAuthSession(
			new Request('https://heykody.dev/account', {
				headers: { Cookie: `kody_session=${cookieValue}` },
			}),
		),
	).resolves.toBeNull()

	// And the reverse: an app session cookie value is not a package-app session.
	const appSetCookie = await createAuthCookie(
		{
			stableUserId: ownerStableUserId,
			email: 'owner@example.com',
			rememberMe: false,
		},
		true,
	)
	const appCookieValue = (appSetCookie.split(';')[0] ?? '').split('=')[1] ?? ''
	await expect(
		read(
			`kody_pkg_session_deadbeefcafe=${appCookieValue}`,
			undefined,
			'https://kodyapps.dev/@owner/packages/x',
		),
	).resolves.toBeNull()

	// Pre-per-app host-wide cookies (v2, no app field) still authorize any
	// leaf until login/handoff or logout clears them.
	const legacyExpiresAt = now + 12 * 60 * 60 * 1000
	const legacyCookie = createCookie('kody_pkg_session', {
		httpOnly: true,
		sameSite: 'Lax',
		path: '/',
		secrets: [
			await sha256Base64Url(`kody-package-app-session:v2:${cookieSecret}`),
		],
	})
	const legacyPair =
		(
			await legacyCookie.serialize(
				JSON.stringify({
					v: 2,
					stableUserId: ownerStableUserId,
					pkgUsername: 'owner',
					issuedAt: now,
				}),
			)
		).split(';')[0] ?? ''
	await expect(
		read(legacyPair, legacyExpiresAt - 1, localUrl),
	).resolves.toMatchObject({ ...ownerSession, expiresAt: legacyExpiresAt })
	await expect(read(legacyPair, legacyExpiresAt, localUrl)).resolves.toBeNull()
})
