import { expect, test } from 'vitest'
import { createCookie } from 'remix/cookie'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { loadResolvedRequestAuth } from '#app/request-auth-cache.ts'
import { hasResolvedRequestFeatureFlags } from '#app/request-feature-flags-cache.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'
const sessionEmail = 'user@example.com'
const stableUserId = testStableUserIdFromEmail(sessionEmail)
const session: AuthSession = {
	stableUserId,
	email: sessionEmail,
	rememberMe: false,
}

function createAuthCacheTestDb(displayName: string | null = null) {
	return {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			const statement = {
				query,
				bind() {
					return statement
				},
				async all() {
					if (
						normalizedQuery.startsWith('select') &&
						normalizedQuery.includes('from "users"')
					) {
						return {
							results: [
								{
									id: 7,
									email: sessionEmail,
									username: 'session-user',
									display_name: displayName,
									stable_user_id: stableUserId,
								},
							],
							meta: { changes: 0 },
						}
					}
					if (normalizedQuery.includes('from user_roles')) {
						return { results: [], meta: { changes: 0 } }
					}
					return { results: [], meta: { changes: 0 } }
				},
				async first() {
					return null
				},
				async run() {
					return { meta: { changes: 0 } }
				},
			}
			return statement
		},
		async batch(statements: Array<{ query?: string }>) {
			return await executePreparedD1Batch(statements)
		},
		async exec() {
			return
		},
	} as unknown as D1Database
}

function createEnv(displayName: string | null = null) {
	return {
		APP_DB: createAuthCacheTestDb(displayName),
		COOKIE_SECRET: testCookieSecret,
	} as Env
}

async function resolveCookie(
	cookie: string,
	displayName: string | null = null,
) {
	const request = new Request('https://example.com/account', {
		headers: { Cookie: cookie.split(';')[0]! },
	})
	const resolved = await loadResolvedRequestAuth(
		request,
		createEnv(displayName),
	)
	expect(hasResolvedRequestFeatureFlags(request)).toBe(false)
	return resolved
}

function expectSignedOutWithClearedCookie(
	resolved: Awaited<ReturnType<typeof loadResolvedRequestAuth>>,
) {
	expect(resolved.user).toBeNull()
	expect(resolved.setCookie ?? '').toContain('kody_session=')
	expect(resolved.setCookie ?? '').toContain('Max-Age=0')
}

test('resolveRequestAuth rejects cookies past the absolute lifetime and legacy cookies without issuedAt', async () => {
	setAuthSessionSecret(testCookieSecret)
	const now = Date.now()
	const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000
	const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000

	expectSignedOutWithClearedCookie(
		await resolveCookie(
			await createAuthCookie(
				{ ...session, rememberMe: false },
				false,
				eightDaysAgo,
			),
		),
	)

	const rememberedEightDays = await resolveCookie(
		await createAuthCookie(
			{ ...session, rememberMe: true },
			false,
			eightDaysAgo,
		),
	)
	expect(rememberedEightDays.user).not.toBeNull()
	expect(rememberedEightDays.user?.username).toBe('session-user')
	expect(rememberedEightDays.setCookie ?? '').not.toContain('Max-Age=0')

	expectSignedOutWithClearedCookie(
		await resolveCookie(
			await createAuthCookie(
				{ ...session, rememberMe: true },
				false,
				thirtyOneDaysAgo,
			),
		),
	)

	const fresh = await resolveCookie(await createAuthCookie(session, false, now))
	expect(fresh.user).not.toBeNull()
	expect(fresh.user?.username).toBe('session-user')
	expect(fresh.user?.displayName).toBe('session-user')

	const legacyCookie = createCookie('kody_session', {
		httpOnly: true,
		sameSite: 'Lax',
		path: '/',
		secrets: [testCookieSecret],
	})
	expectSignedOutWithClearedCookie(
		await resolveCookie(
			await legacyCookie.serialize(
				JSON.stringify({
					v: 2,
					stableUserId,
					email: sessionEmail,
				}),
			),
		),
	)
})

test('resolveRequestAuth destroys the cookie for soft-deleted people', async () => {
	setAuthSessionSecret(testCookieSecret)
	const cookie = await createAuthCookie(session, false, Date.now())
	const request = new Request(
		'https://example.com/@session-user/-/billing.json',
		{
			headers: { Cookie: cookie.split(';')[0]! },
		},
	)
	const env = {
		APP_DB: {
			prepare(query: string) {
				const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
				const statement = {
					query,
					bind() {
						return statement
					},
					async all() {
						if (
							normalizedQuery.startsWith('select') &&
							normalizedQuery.includes('from "users"')
						) {
							// Simulate a code path that still sees the tombstone (or a
							// mock that ignores the live filter): deleted_at must fail closed.
							return {
								results: [
									{
										id: 800,
										email: sessionEmail,
										username: 'session-user',
										stable_user_id: stableUserId,
										deleted_at: '2026-10-16T22:23:07.000Z',
									},
								],
								meta: { changes: 0 },
							}
						}
						if (normalizedQuery.includes('from user_roles')) {
							return { results: [], meta: { changes: 0 } }
						}
						return { results: [], meta: { changes: 0 } }
					},
					async first() {
						return null
					},
					async run() {
						return { meta: { changes: 0 } }
					},
				}
				return statement
			},
			async batch(statements: Array<{ query?: string }>) {
				return await executePreparedD1Batch(statements)
			},
			async exec() {
				return
			},
		} as unknown as D1Database,
		COOKIE_SECRET: testCookieSecret,
	} as Env

	expectSignedOutWithClearedCookie(await loadResolvedRequestAuth(request, env))
})
