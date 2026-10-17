import { expect, test, vi } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'
const email = 'soft-deleted@example.com'
const stableUserId = testStableUserIdFromEmail(email)

vi.mock('#app/account-organizations-data.ts', () => ({
	loadAccountOrganizationSnapshot: vi.fn(async () => {
		throw new Error('organizations loader must not run for soft-deleted people')
	}),
}))

const { requireAuthenticatedPageUser } = await import('#app/page-auth.ts')

function createSoftDeletedEnv() {
	return {
		COOKIE_SECRET: testCookieSecret,
		APP_DB: {
			prepare(query: string) {
				const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
				const statement = {
					query,
					bind: () => statement,
					all: async () => {
						if (
							normalizedQuery.startsWith('select') &&
							normalizedQuery.includes('from "users"')
						) {
							return {
								results: [
									{
										id: 800,
										email,
										username: 'soft-deleted-user',
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
					first: async () => null,
					run: async () => ({ meta: { changes: 0 } }),
				}
				return statement
			},
			async batch(statements: Array<{ query?: string }>) {
				return await executePreparedD1Batch(statements)
			},
			async exec() {},
		} as unknown as D1Database,
	} as Env
}

test('the native organizations page gate signs out a tombstoned session and redirects to login', async () => {
	setAuthSessionSecret(testCookieSecret)
	const cookie = await createAuthCookie(
		{
			stableUserId,
			email,
			rememberMe: false,
		} satisfies AuthSession,
		false,
	)
	const response = await requireAuthenticatedPageUser(
		new Request('https://example.com/account/organizations', {
			headers: { Cookie: cookie },
		}),
		createSoftDeletedEnv(),
		{ redirectTo: '/account/organizations' },
	)
	expect(response).toBeInstanceOf(Response)
	if (!(response instanceof Response))
		throw new Error('Expected login redirect')
	expect(response.status).toBe(302)
	expect(
		new URL(response.headers.get('Location')!, 'https://example.com').pathname,
	).toBe('/login')
	expect(
		new URL(
			response.headers.get('Location')!,
			'https://example.com',
		).searchParams.get('redirectTo'),
	).toBe('/account/organizations')
	expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0')
})
