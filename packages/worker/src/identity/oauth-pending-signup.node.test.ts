import {
	createOauthPendingSignupCookie,
	readOauthPendingSignup,
	setOauthPendingSignupSecret,
} from '#app/oauth-pending-signup.ts'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import {
	createAppEnv,
	createMigratedDb,
	getCookiePair,
	testCookieSecret,
} from '#worker/test-support/auth-provider-harness.ts'
import { beforeAll, expect, test } from 'vitest'
import {
	checkWebsiteUsernameAvailability,
	usernameAvailabilityRateLimitConfig,
} from './username-availability-operations.ts'
import { completeOauthPendingSignup } from './oauth-pending-signup-operations.ts'

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
	setOauthPendingSignupSecret(testCookieSecret)
})

async function pendingCookie(input: {
	csrf?: string
	email?: string
	suggestedUsername?: string
	redirectTo?: string | null
	issuedAt?: number
	providerUserId?: string
}) {
	return createOauthPendingSignupCookie(
		{
			provider: 'github',
			providerUserId: input.providerUserId ?? 'pending-1',
			email: input.email ?? 'pending@example.com',
			providerUsername: 'pending-gh',
			displayName: 'Pending User',
			suggestedUsername: input.suggestedUsername ?? 'pending-gh',
			redirectTo: input.redirectTo ?? null,
			attribution: null,
			csrf: input.csrf ?? 'csrf-token-value',
			accessToken: null,
			issuedAt: input.issuedAt ?? Date.now(),
		},
		false,
	)
}

test('pending signup cookie encrypts provider access tokens at rest', async () => {
	const plaintextToken = 'discord-access-token-plaintext'
	const cookie = await createOauthPendingSignupCookie(
		{
			provider: 'discord',
			providerUserId: 'discord-user-1',
			email: 'discord@example.com',
			providerUsername: 'discord-user',
			displayName: 'Discord User',
			suggestedUsername: 'discord-user',
			redirectTo: null,
			attribution: null,
			csrf: 'csrf-discord',
			accessToken: plaintextToken,
			issuedAt: Date.now(),
		},
		false,
	)
	const pair = getCookiePair(cookie)
	expect(pair).not.toContain(plaintextToken)
	expect(decodeURIComponent(pair)).not.toContain(plaintextToken)

	const pending = await readOauthPendingSignup(
		new Request('http://example.com/signup/choose-username', {
			headers: { Cookie: pair },
		}),
	)
	expect(pending).toMatchObject({
		provider: 'discord',
		email: 'discord@example.com',
		accessToken: plaintextToken,
	})
})

test('readOauthPendingSignup rejects tampered and expired cookies', async () => {
	const cookie = await pendingCookie({})
	const pair = getCookiePair(cookie)
	const request = new Request('http://example.com/signup/choose-username', {
		headers: { Cookie: pair },
	})
	expect(await readOauthPendingSignup(request)).toMatchObject({
		email: 'pending@example.com',
		csrf: 'csrf-token-value',
	})

	const expired = await pendingCookie({
		issuedAt: Date.now() - 11 * 60 * 1000,
	})
	expect(
		await readOauthPendingSignup(
			new Request('http://example.com/x', {
				headers: { Cookie: getCookiePair(expired) },
			}),
		),
	).toBeNull()

	// Truncate the signed value so Remix signature verification fails closed.
	const [name, value] = pair.split('=')
	expect(value && value.length > 8).toBe(true)
	const tampered = `${name}=${value!.slice(0, -8)}`
	expect(
		await readOauthPendingSignup(
			new Request('http://example.com/x', {
				headers: { Cookie: tampered },
			}),
		),
	).toBeNull()
})

test('completeOauthPendingSignup creates the account once and rejects bad csrf', async () => {
	const { sqlite, db } = createMigratedDb()
	const env = createAppEnv(db)
	const csrf = 'good-csrf'
	const cookie = await pendingCookie({
		csrf,
		suggestedUsername: 'chosen-handle',
		redirectTo: '/oauth/authorize?client_id=c&prompt=login&state=s',
	})

	const bad = await completeOauthPendingSignup({
		env,
		request: new Request('http://example.com/signup/choose-username', {
			method: 'POST',
			headers: { Cookie: getCookiePair(cookie) },
		}),
		body: { username: 'chosen-handle', csrf: 'wrong' },
	})
	expect(bad.status).toBe(403)
	expect(countUsers(sqlite)).toBe(0)

	const cookieAgain = await pendingCookie({
		csrf,
		suggestedUsername: 'chosen-handle',
		redirectTo: '/oauth/authorize?client_id=c&prompt=login&state=s',
	})
	const ok = await completeOauthPendingSignup({
		env,
		request: new Request('http://example.com/signup/choose-username', {
			method: 'POST',
			headers: { Cookie: getCookiePair(cookieAgain) },
		}),
		body: { username: 'chosen-handle', csrf },
	})
	expect(ok.status).toBe(200)
	expect(ok.data).toMatchObject({
		ok: true,
		redirectTo: '/oauth/authorize?client_id=c&state=s&accountCreated=1',
	})
	expect(countUsers(sqlite)).toBe(1)
	const user = sqlite
		.prepare(`SELECT username, email FROM users WHERE email = ?`)
		.get('pending@example.com') as { username: string; email: string }
	expect(user.username).toBe('chosen-handle')

	// Pending cookie is cleared (single-use).
	expect(
		[...ok.headers.getSetCookie()].some(
			(value) =>
				value.startsWith('kody_oauth_pending=') && value.includes('Max-Age=0'),
		),
	).toBe(true)
})

test('completeOauthPendingSignup rejects taken and reserved usernames without creating', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			 VALUES ('taken-handle', 'other@example.com', 'x', 'other-stable')`,
		)
		.run()
	const env = createAppEnv(db)
	const csrf = 'csrf-taken'
	const cookie = await pendingCookie({ csrf, email: 'new@example.com' })

	const taken = await completeOauthPendingSignup({
		env,
		request: new Request('http://example.com/x', {
			method: 'POST',
			headers: { Cookie: getCookiePair(cookie) },
		}),
		body: { username: 'taken-handle', csrf },
	})
	expect(taken.status).toBe(409)
	expect(countUsers(sqlite)).toBe(1)

	const reserved = await completeOauthPendingSignup({
		env,
		request: new Request('http://example.com/x', {
			method: 'POST',
			headers: { Cookie: getCookiePair(cookie) },
		}),
		body: { username: 'support', csrf },
	})
	expect(reserved.status).toBe(400)
	expect(countUsers(sqlite)).toBe(1)
})

test('username availability endpoint reports status and rate limits', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			 VALUES ('busy-name', 'busy@example.com', 'x', 'busy-stable')`,
		)
		.run()
	const env = createAppEnv(db)
	const request = new Request('http://example.com/_serverFn/check', {
		headers: { 'CF-Connecting-IP': '203.0.113.50' },
	})

	const available = await checkWebsiteUsernameAvailability({
		env,
		request,
		body: { username: 'open-name', email: 'open@example.com' },
	})
	expect(available.data).toMatchObject({
		ok: true,
		status: 'available',
		username: 'open-name',
	})

	const taken = await checkWebsiteUsernameAvailability({
		env,
		request,
		body: { username: 'busy-name', email: 'open@example.com' },
	})
	expect(taken.data).toMatchObject({ ok: true, status: 'taken' })
	expect(
		(taken.data as { suggestions: Array<string> }).suggestions.length,
	).toBeGreaterThan(0)

	const limitedRequest = new Request('http://example.com/_serverFn/check', {
		headers: { 'CF-Connecting-IP': '203.0.113.77' },
	})
	for (let i = 0; i < usernameAvailabilityRateLimitConfig.maxRequests; i += 1) {
		const result = await checkWebsiteUsernameAvailability({
			env,
			request: limitedRequest,
			body: { username: `probe-${i}` },
		})
		expect(result.status).toBe(200)
	}
	const limited = await checkWebsiteUsernameAvailability({
		env,
		request: limitedRequest,
		body: { username: 'after-limit' },
	})
	expect(limited.status).toBe(429)
	expect(limited.data).toMatchObject({ ok: false, code: 'rate_limited' })
})

function countUsers(sqlite: import('node:sqlite').DatabaseSync) {
	return (
		sqlite.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }
	).n
}
