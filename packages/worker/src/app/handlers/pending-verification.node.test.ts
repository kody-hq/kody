import { expect, test, vi } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { loadPendingVerification } from '../../../start/server/pending-verification.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
import {
	isOrgBindingMembershipQuery,
	mockPersonalOrgBindingRow,
} from '#worker/test-support/org-binding-query.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

const native = vi.hoisted(() => ({
	env: {} as Env,
	request: new Request('https://example.com/pending-verification'),
	setResponseHeader: vi.fn(),
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
vi.mock('#app/env.ts', () => ({ getEnv: (env: Env) => env }))
vi.mock('@tanstack/react-start', async () => ({
	createServerFn: (
		await import('#worker/test-support/start-server-function.ts')
	).createTestServerFn,
	createServerOnlyFn: <T>(fn: T) => fn,
}))

function createUserEnv(options: {
	emailVerifiedAt?: string | null
	missingUser?: boolean
}) {
	const user = options.missingUser
		? null
		: {
				id: 1,
				email: 'pending@example.com',
				username: 'pending-user',
				password_hash: 'unused',
				stable_user_id: testStableUserIdFromEmail('pending@example.com'),
				email_verified_at: options.emailVerifiedAt ?? null,
				created_at: new Date(0).toISOString(),
				updated_at: new Date(0).toISOString(),
			}
	return {
		COOKIE_SECRET: testCookieSecret,
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
							return {
								results: user ? [user] : [],
								meta: { changes: 0 },
							}
						}
						if (normalizedQuery.includes('from user_roles ur')) {
							return { results: [], meta: { changes: 0 } }
						}
						return { results: [], meta: { changes: 0 } }
					},
					async first() {
						if (isOrgBindingMembershipQuery(normalizedQuery)) {
							return user
								? mockPersonalOrgBindingRow(user.stable_user_id, user.username)
								: null
						}
						if (normalizedQuery.includes('email_verified_at')) {
							return user ? { email_verified_at: user.email_verified_at } : null
						}
						return user
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
	} as Env
}

test('pending verification requires a live session, preserves redirectTo after verify, and renders when unverified', async () => {
	setAuthSessionSecret(testCookieSecret)
	const session: AuthSession = {
		stableUserId: testStableUserIdFromEmail('pending@example.com'),
		email: 'pending@example.com',
		rememberMe: false,
	}
	const cookie = await createAuthCookie(session, false)

	async function read(env: Env, search = '', cookie?: string) {
		native.env = env
		native.request = new Request(
			`https://example.com/pending-verification${search}`,
			{ headers: cookie ? { Cookie: cookie } : {} },
		)
		native.setResponseHeader.mockClear()
		return loadPendingVerification({ data: search })
	}
	await expect(read(createUserEnv({}))).rejects.toMatchObject({
		options: {
			statusCode: 302,
			href: 'https://example.com/login?redirectTo=%2Fpending-verification',
		},
	})
	await expect(
		read(createUserEnv({ emailVerifiedAt: null }), '', cookie),
	).resolves.toEqual({
		ok: true,
		email: 'pending@example.com',
		emailVerificationDelivery: null,
	})
	for (const [search, href] of [
		['', '/onboarding'],
		[
			'?redirectTo=%2Foauth%2Fauthorize%3Fclient_id%3Ddemo',
			'/oauth/authorize?client_id=demo',
		],
		['?redirectTo=https%3A%2F%2Fevil.example', '/onboarding'],
	]) {
		await expect(
			read(
				createUserEnv({ emailVerifiedAt: new Date(0).toISOString() }),
				search,
				cookie,
			),
		).rejects.toMatchObject({ options: { statusCode: 302, href } })
	}
	await expect(
		read(createUserEnv({ missingUser: true }), '', cookie),
	).rejects.toMatchObject({
		options: {
			statusCode: 302,
			href: 'https://example.com/login?redirectTo=%2Fpending-verification',
		},
	})
	const cleared = native.setResponseHeader.mock.calls.find(
		([name]) => name === 'Set-Cookie',
	)?.[1] as string | undefined
	expect(cleared).toContain('Max-Age=0')
})
