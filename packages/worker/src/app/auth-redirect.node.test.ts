import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { redirectToLoginWhenUnauthenticated } from '#app/auth-redirect.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

function createStaleSessionTestEnv() {
	return {
		COOKIE_SECRET: testCookieSecret,
		APP_DB: {
			prepare(query: string) {
				const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
				return {
					query,
					bind() {
						return {
							query,
							async all() {
								if (
									normalizedQuery.startsWith('select') &&
									normalizedQuery.includes('from "users"')
								) {
									return { results: [], meta: { changes: 0 } }
								}
								if (normalizedQuery.includes('from user_roles ur')) {
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
					},
				}
			},
			async batch(statements: Array<{ query?: string }>) {
				return await executePreparedD1Batch(statements)
			},
			async exec() {
				return
			},
		} as unknown as D1Database,
	} as Env
}

test('redirectToLoginWhenUnauthenticated clears a stale session cookie', async () => {
	setAuthSessionSecret(testCookieSecret)
	const session: AuthSession = {
		stableUserId: ownerIdFromStored('f').repeat(64),
		email: 'missing@example.com',
		rememberMe: false,
	}
	const cookie = await createAuthCookie(session, false)
	const env = createStaleSessionTestEnv()

	const response = await redirectToLoginWhenUnauthenticated(
		new Request('https://example.com/account', {
			headers: { Cookie: cookie },
		}),
		env,
	)

	expect(response.status).toBe(302)
	expect(response.headers.get('Location')).toBe(
		'https://example.com/login?redirectTo=%2Faccount',
	)
	const setCookie = response.headers.get('Set-Cookie') ?? ''
	expect(setCookie).toContain('kody_session=')
	expect(setCookie).toContain('Max-Age=0')
})
