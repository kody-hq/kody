import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { loadAuthPage } from '../../../start/server/auth-page.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

const native = vi.hoisted(() => ({
	env: {} as Env,
	request: new Request('https://example.com/login'),
	setResponseHeader: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerOnlyFn: <T>(fn: T) => fn,
	createServerFn: () => {
		let validate = (data: unknown) => data
		const builder = {
			validator: (fn: typeof validate) => {
				validate = fn
				return builder
			},
			handler:
				(fn: (input: { data: unknown }) => unknown) =>
				(input: { data: unknown }) =>
					fn({ data: validate(input.data) }),
		}
		return builder
	},
}))
vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	get env() {
		return native.env
	},
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => native.request,
	setResponseHeader: native.setResponseHeader,
}))
vi.mock('#app/env.ts', () => ({ getEnv: () => native.env }))

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

test('auth page renders login for a stale session instead of redirecting away', async () => {
	setAuthSessionSecret(testCookieSecret)
	const session: AuthSession = {
		stableUserId: ownerIdFromStored('f').repeat(64),
		email: 'missing@example.com',
		rememberMe: false,
	}
	const cookie = await createAuthCookie(session, false)
	native.env = createStaleSessionTestEnv()
	native.request = new Request(
		'https://example.com/login?redirectTo=%2Faccount',
		{ headers: { Cookie: cookie } },
	)
	const response = await loadAuthPage({ data: { redirectTo: '/account' } })
	expect(response).not.toHaveProperty('session')
	expect(response.authConfig.ok).toBe(true)
})

test('auth page renders login for a deleting account instead of redirecting to /account', async () => {
	setAuthSessionSecret(testCookieSecret)
	const session: AuthSession = {
		stableUserId: ownerIdFromStored('a').repeat(64),
		email: 'deleting@example.com',
		rememberMe: false,
	}
	const cookie = await createAuthCookie(session, false)
	const env = {
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
									return {
										results: [
											{
												id: 7,
												email: 'deleting@example.com',
												username: 'deleting-user',
												stable_user_id: 'a'.repeat(64),
												deleting_at: '2026-08-31 15:00:00',
											},
										],
										meta: { changes: 0 },
									}
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
	native.env = env
	native.setResponseHeader.mockClear()
	native.request = new Request(
		'https://example.com/login?redirectTo=%2Faccount',
		{ headers: { Cookie: cookie } },
	)
	const response = await loadAuthPage({ data: { redirectTo: '/account' } })
	expect(response).not.toHaveProperty('session')
	expect(response.authConfig.ok).toBe(true)
	expect(native.setResponseHeader).toHaveBeenCalledWith(
		'Set-Cookie',
		expect.stringContaining('kody_session='),
	)
	expect(native.setResponseHeader).toHaveBeenCalledWith(
		'Set-Cookie',
		expect.stringContaining('Max-Age=0'),
	)
})
