import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import type * as signupWelcomeCredits from '#worker/billing/signup-welcome-credits.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const lifecycleMocks = vi.hoisted(() => ({
	scheduleUserCreatedEvent: vi.fn(),
}))

const welcomeCreditMocks = vi.hoisted(() => ({
	maybeGrantSignupWelcomeCredits: vi.fn<
		typeof signupWelcomeCredits.maybeGrantSignupWelcomeCredits
	>(async () => ({
		applied: true,
		entryId: 'signup_welcome:test',
		balanceMicroUsd: 5_000_000,
		createdAt: '2026-09-29T00:00:00.000Z',
	})),
	reconcileSignupWelcomeCreditsIfPending: vi.fn<
		typeof signupWelcomeCredits.reconcileSignupWelcomeCreditsIfPending
	>(async () => null),
}))

vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserCreatedEvent: (...args: Array<unknown>) =>
		lifecycleMocks.scheduleUserCreatedEvent(...args),
	scheduleUserDeletedEvent: vi.fn(),
}))

vi.mock('#worker/billing/signup-welcome-credits.ts', () => ({
	maybeGrantSignupWelcomeCredits: (
		...args: Parameters<
			typeof signupWelcomeCredits.maybeGrantSignupWelcomeCredits
		>
	) => welcomeCreditMocks.maybeGrantSignupWelcomeCredits(...args),
	reconcileSignupWelcomeCreditsIfPending: (
		...args: Parameters<
			typeof signupWelcomeCredits.reconcileSignupWelcomeCreditsIfPending
		>
	) => welcomeCreditMocks.reconcileSignupWelcomeCreditsIfPending(...args),
}))

const { createAuthHandler } = await import('#app/handlers/auth.ts')
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import {
	consoleError,
	consoleInfo,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { reservedUsernamesKvKey } from '#worker/identity/reserved-username-settings.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

const signupAccepted = {
	ok: true,
	mode: 'signup',
	emailVerificationRequired: true,
	message: 'Check your email to verify your account.',
}
const verificationSendFailed = {
	error: 'Unable to send the verification email. Please try signing up again.',
}

function createMemoryKv(initial?: Record<string, string>) {
	const store = new Map<string, string>(Object.entries(initial ?? {}))
	return {
		async get(key: string, type?: string) {
			const raw = store.get(key)
			if (raw === undefined) return null
			return type === 'json' ? JSON.parse(raw) : raw
		},
		async put(key: string, value: string) {
			store.set(key, value)
		},
	} as unknown as KVNamespace
}

function createAuthTestContext(
	options: {
		failRoleAssignment?: boolean
		emailConfigured?: boolean
		kv?: KVNamespace
		sentryEnvironment?: 'test' | 'preview' | 'production'
	} = {},
) {
	const testDb = createTestDb({
		failRoleAssignment: options.failRoleAssignment ?? false,
	})
	const sentryEnvironment = options.sentryEnvironment ?? 'test'
	const handler = createAuthHandler({
		COOKIE_SECRET: testCookieSecret,
		APP_DB: testDb.db,
		SENTRY_ENVIRONMENT: sentryEnvironment,
		// Production refuses public forms without Turnstile; tests that set
		// production still exercise auth past the protection gate.
		...(sentryEnvironment === 'production'
			? {
					TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
					TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
				}
			: {}),
		...(options.kv ? { BUNDLE_ARTIFACTS_KV: options.kv } : {}),
		...(options.emailConfigured
			? {
					CLOUDFLARE_ACCOUNT_ID: 'cf-account-test',
					CLOUDFLARE_API_TOKEN: 'cf-token-test',
					CLOUDFLARE_API_BASE_URL: 'https://cloudflare-api.example.com',
				}
			: {}),
	} as unknown as Parameters<typeof createAuthHandler>[0])

	function request(body: unknown, url = 'http://example.com/auth') {
		return handler({
			request: new Request(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: typeof body === 'string' ? body : JSON.stringify(body),
			}),
		})
	}

	return {
		testDb,
		request,
		signup(
			email: string,
			username: string | undefined,
			extra: Record<string, unknown> = {},
		) {
			return request({
				email,
				username,
				password: 'password123',
				mode: 'signup',
				...extra,
			})
		},
	}
}

const utmColumns = [
	'utm_source',
	'utm_medium',
	'utm_campaign',
	'utm_content',
	'utm_term',
	'first_touch_landing_path',
	'first_touch_referrer',
	'last_active_at',
] as const

type TestUser = {
	id: number
	email: string
	username: string
	password_hash: string
	plan: string | null
	stable_user_id: string
	personal_org_id: string
} & Record<(typeof utmColumns)[number], string | null>

function createTestDb(options: { failRoleAssignment?: boolean } = {}) {
	let nextId = 1
	const users = new Map<string, TestUser>()
	const db = {
		async batch(statements: Array<{ run: () => Promise<unknown> }>) {
			const results = []
			for (const statement of statements) results.push(await statement.run())
			return results
		},
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					const findUser = (column: 'email' | 'username') => {
						const needle = String(params[0] ?? '').toLowerCase()
						return (
							Array.from(users.values()).find(
								(user) => user[column].toLowerCase() === needle,
							) ?? null
						)
					}

					const insertUser = () => {
						const columnMatch = normalizedQuery.match(
							/insert into "users" \(([^)]+)\)/,
						)
						const columnList = columnMatch?.[1]
						const columns = columnList
							? columnList
									.split(',')
									.map((column) => column.trim().replaceAll('"', ''))
							: []
						const values = Object.fromEntries(
							columns.map((column, index) => [column, params[index]]),
						)
						const username = String(values.username ?? '')
						const email = String(values.email ?? '')
						const normalizedEmail = email.toLowerCase()
						if (users.has(normalizedEmail)) {
							throw new Error('UNIQUE constraint failed: users.email')
						}
						if (findUserByUsername(username)) {
							throw new Error('UNIQUE constraint failed: users.username')
						}
						const nullable = (value: unknown) =>
							value == null ? null : String(value)
						const user = {
							id: nextId,
							email,
							username,
							password_hash: String(values.password_hash ?? ''),
							plan: nullable(values.plan),
							stable_user_id: String(values.stable_user_id ?? ''),
							personal_org_id: String(values.personal_org_id ?? ''),
							...Object.fromEntries(
								utmColumns.map((column) => [column, nullable(values[column])]),
							),
						} as TestUser
						nextId += 1
						users.set(normalizedEmail, user)
						return user
					}

					const executeAll = async () => {
						const empty = { results: [], meta: { changes: 0, last_row_id: 0 } }
						if (
							normalizedQuery.startsWith('select') &&
							normalizedQuery.includes('from "users"')
						) {
							const column = /"email"\s*=/.test(normalizedQuery)
								? 'email'
								: /"username"\s*=/.test(normalizedQuery)
									? 'username'
									: null
							if (column) {
								const user = findUser(column)
								return { ...empty, results: user ? [{ ...user }] : [] }
							}
						}
						if (normalizedQuery.includes('insert into "users"')) {
							const user = insertUser()
							return {
								results: [{ ...user }],
								meta: { changes: 1, last_row_id: user.id },
							}
						}
						if (/insert into "?email_verifications/.test(normalizedQuery)) {
							return { results: [], meta: { changes: 1, last_row_id: 1 } }
						}
						return empty
					}

					return {
						all: executeAll,
						async first() {
							const result = await executeAll()
							return result.results[0] ?? null
						},
						async run() {
							if (normalizedQuery.includes('insert into "users"')) {
								const user = insertUser()
								return { meta: { changes: 1, last_row_id: user.id } }
							}
							if (
								/(delete from|insert into) "?email_verifications/.test(
									normalizedQuery,
								)
							) {
								return { meta: { changes: 1, last_row_id: 1 } }
							}
							if (
								normalizedQuery.includes('insert or ignore into user_roles')
							) {
								// changes: 0 simulates a missing seeded role (partial
								// migration), which must fail the signup.
								return {
									meta: {
										changes: options.failRoleAssignment ? 0 : 1,
										last_row_id: 0,
									},
								}
							}
							if (normalizedQuery.includes('delete from users')) {
								const userId = Number(params[0])
								for (const [email, user] of users) {
									if (user.id === userId) {
										users.delete(email)
										return { meta: { changes: 1, last_row_id: 0 } }
									}
								}
							}
							return { meta: { changes: 0, last_row_id: 0 } }
						},
					}
				},
			}
		},
		async exec() {
			return
		},
	} as unknown as D1Database

	function findUserByUsername(username: string) {
		return Array.from(users.values()).some(
			(user) => user.username.toLowerCase() === username.toLowerCase(),
		)
	}

	async function addUser(email: string, password: string, username = email) {
		const user = {
			id: nextId,
			email,
			username,
			password_hash: await createPasswordHash(password),
			plan: 'free',
			stable_user_id: testStableUserIdFromEmail(email),
			personal_org_id: testStableUserIdFromEmail(email),
			...Object.fromEntries(utmColumns.map((column) => [column, null])),
		} as TestUser
		nextId += 1
		users.set(email.toLowerCase(), user)
		return user
	}

	return { db, users, addUser }
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

function stubCloudflareEmailFetch(
	result: { ok: true } | { ok: false; message: string },
) {
	const fetchStub = vi.fn(async () =>
		result.ok
			? Response.json({ success: true, result: { message_id: 'msg-1' } })
			: Response.json(
					{ success: false, errors: [{ message: result.message }] },
					{ status: 500 },
				),
	)
	vi.stubGlobal('fetch', fetchStub)
	return fetchStub
}

function expectAuthAudit(action: string, result: string, extra = {}) {
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({ category: 'auth', action, result, ...extra }),
	)
}

test('auth handler login and signup workflow', async () => {
	// Production signups must actually deliver the verification email, so
	// the production context gets a (stubbed) configured Cloudflare sender.
	const productionContext = createAuthTestContext({ emailConfigured: true })
	const signupContext = createAuthTestContext()
	stubCloudflareEmailFetch({ ok: true })

	const invalidRequests: Array<[unknown, number, string]> = [
		['{', 400, 'Invalid JSON payload.'],
		[{ email: 'a@b.com' }, 400, 'Invalid request body.'],
		[
			{ email: 'someone@example.com', password: 'secret', mode: 'login' },
			401,
			'Invalid email or password.',
		],
	]
	for (const [body, status, error] of invalidRequests) {
		const response = await productionContext.request(body)
		expect([response.status, await response.json()]).toEqual([
			status,
			{ error },
		])
	}
	expectAuthAudit('login', 'failure', { reason: 'invalid_credentials' })

	const openSignupResponse = await productionContext.signup(
		'new@example.com',
		'newcomer',
	)
	expect(openSignupResponse.status).toBe(200)
	expect(await openSignupResponse.json()).toEqual(signupAccepted)
	expect(productionContext.testDb.users.has('new@example.com')).toBe(true)

	// A registered address gets the accepted body and no session, so the
	// endpoint does not confirm which addresses hold accounts.
	await productionContext.testDb.addUser('taken@example.com', 'secret', 'taken')
	const blockedExistingResponse = await productionContext.signup(
		'taken@example.com',
		'another-name',
	)
	expect(blockedExistingResponse.status).toBe(200)
	expect(await blockedExistingResponse.json()).toEqual(signupAccepted)

	const weakPasswordSignupResponse = await signupContext.signup(
		'weak@example.com',
		'weak-jane',
		{ password: 'short' },
	)
	expect(weakPasswordSignupResponse.status).toBe(400)
	expect(await weakPasswordSignupResponse.json()).toEqual({
		error: 'Password must be at least 8 characters.',
	})
	expect(signupContext.testDb.users.has('weak@example.com')).toBe(false)

	const allowedSignupResponse = await signupContext.signup(
		'allowed@example.com',
		'allowed-jane',
	)
	expect(allowedSignupResponse.status).toBe(200)
	expect(await allowedSignupResponse.json()).toEqual(signupAccepted)
	const allowedUser = signupContext.testDb.users.get('allowed@example.com')
	expect(allowedUser).toMatchObject({
		username: 'allowed-jane',
	})
	expect(allowedUser?.personal_org_id).not.toBe('')
	expect(allowedUser?.personal_org_id).not.toBe(allowedUser?.stable_user_id)
	expect(allowedUser?.personal_org_id).toMatch(/^[a-f0-9]{64}$/)
	expect(
		allowedSignupResponse.headers
			.getSetCookie()
			.some(
				(cookie) =>
					cookie.startsWith('kody_ref=') && cookie.includes('Max-Age=0'),
			),
	).toBe(true)
	// The signup context has no email sender configured, so the skipped
	// verification send logs at info level in the non-production runtime.
	expect(consoleInfo).toHaveBeenCalledWith(
		'email-verification-send-skipped',
		expect.any(Number),
	)

	await signupContext.testDb.addUser(
		'existing@example.com',
		'secret',
		'existing-jane',
	)

	// Reserved usernames double as reserved email local parts
	// ({username}@<platform domain>), so signup must deny them.
	const usernameRejections: Array<[string | undefined, number, string]> = [
		[undefined, 400, 'Username is required.'],
		[
			'no spaces',
			400,
			'Username must be 3 to 32 characters, use only letters, numbers, and hyphens, and start and end with a letter or number.',
		],
		['kody', 400, 'This username is reserved.'],
		['postmaster', 400, 'This username is reserved.'],
		['kody-r-0123456789abcdef', 400, 'This username is reserved.'],
		['me', 400, 'This username is reserved.'],
		['ME', 400, 'This username is reserved.'],
		['Existing-Jane', 409, 'Username already registered.'],
	]
	for (const [username, status, error] of usernameRejections) {
		const response = await signupContext.signup(
			`${crypto.randomUUID().slice(0, 8)}@example.com`,
			username,
		)
		expect([username, response.status, await response.json()]).toEqual([
			username,
			status,
			{ error },
		])
	}

	// An already-registered email must be indistinguishable from a fresh
	// signup in status and body (no account enumeration); only the session
	// cookie is withheld and nothing is created.
	const duplicateEmailResponse = await signupContext.signup(
		'existing@example.com',
		'brand-new-name',
	)
	expect(duplicateEmailResponse.status).toBe(200)
	expect(await duplicateEmailResponse.json()).toEqual(signupAccepted)
	expect(duplicateEmailResponse.headers.get('Set-Cookie')).toBeNull()
	expectAuthAudit('signup', 'failure', { reason: 'email_exists' })

	const email = 'session-user@example.com'
	const sessionUser = await productionContext.testDb.addUser(email, 'secret')
	sessionUser.personal_org_id = testStableUserIdFromEmail(
		'distinct-personal-org@example.com',
	)
	const login = (extra = {}, url?: string) =>
		productionContext.request(
			{ email, password: 'secret', mode: 'login', ...extra },
			url,
		)

	for (const [extra, maxAge] of [
		[{}, 'Max-Age=604800'],
		[{ rememberMe: true }, 'Max-Age=2592000'],
	] as const) {
		const response = await login(extra)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ ok: true, mode: 'login' })
		const cookie = response.headers.get('Set-Cookie') ?? ''
		expect(cookie).toContain('kody_session=')
		expect(cookie).toContain(maxAge)
	}
	expect(
		welcomeCreditMocks.reconcileSignupWelcomeCreditsIfPending,
	).toHaveBeenLastCalledWith({
		db: productionContext.testDb.db,
		userId: sessionUser.personal_org_id,
	})
	expect(sessionUser.personal_org_id).not.toBe(sessionUser.stable_user_id)
	expectAuthAudit('login', 'success', { email })

	const secureCookieResponse = await login({}, 'https://example.com/auth')
	expect(secureCookieResponse.headers.get('Set-Cookie') ?? '').toContain(
		'Secure',
	)
	// The full workflow audits exactly these events, in order: the unknown
	// login, the first open signup, the registered-email attempt, the
	// weak-password rejection, the second open signup, the eight username
	// rejections, the duplicate-email rejection, and the three successful
	// logins.
	expect(auditEventSummaries()).toEqual([
		'login:failure',
		'signup:success',
		'signup:failure',
		'signup:failure',
		'signup:success',
		...Array.from({ length: 9 }, () => 'signup:failure'),
		'login:success',
		'login:success',
		'login:success',
	])
})

test('password signup schedules user.created with first-touch attribution and persists UTMs once', async () => {
	const context = createAuthTestContext()

	const plainEmail = 'newbie@example.com'
	expect((await context.signup(plainEmail, 'newbie')).status).toBe(200)
	const plainStableUserId = context.testDb.users.get(plainEmail)?.stable_user_id
	expect(plainStableUserId).toMatch(/^[a-f0-9]{64}$/)
	expect(plainStableUserId).not.toBe(testStableUserIdFromEmail(plainEmail))
	expect(lifecycleMocks.scheduleUserCreatedEvent).toHaveBeenCalledWith({
		env: expect.anything(),
		source: 'signup',
		user: {
			id: plainStableUserId,
			username: 'newbie',
			email: plainEmail,
		},
		attribution: {
			utmSource: null,
			utmMedium: null,
			utmCampaign: null,
			utmContent: null,
			utmTerm: null,
			landingPath: null,
			referrer: null,
		},
	})
	expect(
		welcomeCreditMocks.maybeGrantSignupWelcomeCredits,
	).toHaveBeenCalledWith({
		db: expect.anything(),
		userId: expect.stringMatching(/^[a-f0-9]{64}$/),
	})
	expect(
		welcomeCreditMocks.maybeGrantSignupWelcomeCredits.mock.calls[0]?.[0]
			?.userId,
	).not.toBe(plainStableUserId)

	const email = 'attributed@example.com'
	const response = await context.signup(email, 'attributed', {
		utmSource: 'youtube',
		utmMedium: 'video',
		utmCampaign: 'bwk-2026-08-27',
		landingPath: '/signup',
		referrer: 'https://youtube.com/watch?v=abc',
	})
	expect(response.status).toBe(200)
	const user = context.testDb.users.get(email)
	expect(user).toMatchObject({
		utm_source: 'youtube',
		utm_medium: 'video',
		utm_campaign: 'bwk-2026-08-27',
		first_touch_landing_path: '/signup',
		first_touch_referrer: 'https://youtube.com/watch?v=abc',
	})
	expect(user?.last_active_at).toBeTruthy()
	expect(lifecycleMocks.scheduleUserCreatedEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			attribution: expect.objectContaining({
				utmSource: 'youtube',
				utmMedium: 'video',
				utmCampaign: 'bwk-2026-08-27',
				landingPath: '/signup',
			}),
		}),
	)
})

test('signup fails when the default user role cannot be assigned', async () => {
	const context = createAuthTestContext({ failRoleAssignment: true })

	const response = await context.signup('roleless@example.com', 'roleless-jane')
	expect(response.status).toBe(500)
	expect(await response.json()).toEqual({ error: 'Unable to create account.' })
	expect(response.headers.get('Set-Cookie')).toBeNull()
	// The created user row is rolled back so signup can be retried.
	expect(context.testDb.users.has('roleless@example.com')).toBe(false)
	expect(auditEventSummaries()).toEqual(['signup:failure'])
	expectAuthAudit('signup', 'failure')
})

test('signup rolls back when the verification email cannot be sent', async () => {
	consoleError.mockImplementation(() => {})
	consoleWarn.mockImplementation(() => {})
	const context = createAuthTestContext({ emailConfigured: true })
	stubCloudflareEmailFetch({ ok: false, message: 'delivery refused' })

	const response = await context.signup(
		'undeliverable@example.com',
		'undeliverable-jane',
	)
	expect(response.status).toBe(500)
	expect(await response.json()).toEqual(verificationSendFailed)
	expect(response.headers.get('Set-Cookie')).toBeNull()
	// The created user row is rolled back so signup can be retried.
	expect(context.testDb.users.has('undeliverable@example.com')).toBe(false)
	// Only the verification failure is logged; the rollback delete succeeds.
	expect(consoleError).toHaveBeenCalledTimes(1)
	expect(consoleError).toHaveBeenCalledWith(
		expect.any(String),
		expect.any(Error),
	)
	// The failed Cloudflare API send is warned for operators.
	expect(consoleWarn).toHaveBeenCalledWith(
		'cloudflare-email-api-failed',
		expect.any(String),
	)
})

test('production signup fails closed when no verification email sender is configured', async () => {
	consoleError.mockImplementation(() => {})
	const context = createAuthTestContext({ sentryEnvironment: 'production' })
	const fetchSpy = vi.fn(async (url: string) => {
		if (String(url).includes('turnstile')) {
			return Response.json({ success: true, hostname: 'example.com' })
		}
		throw new Error(`Unexpected fetch: ${url}`)
	})
	vi.stubGlobal('fetch', fetchSpy)
	try {
		const response = await context.signup(
			'no-sender@example.com',
			'no-sender-jane',
			{ turnstileToken: 'test-token' },
		)
		expect(response.status).toBe(500)
		expect(await response.json()).toEqual(verificationSendFailed)
		expect(context.testDb.users.has('no-sender@example.com')).toBe(false)
		expect(consoleError).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Error),
		)
		// The skipped send is logged with the unconfigured-sender tag.
		expect(consoleInfo).toHaveBeenCalledWith(
			'cloudflare-email-unconfigured',
			expect.any(String),
		)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('signup rejects KV-added reserved usernames and accepts unreserved built-ins', async () => {
	const kv = createMemoryKv({
		[reservedUsernamesKvKey]: JSON.stringify({
			added: ['brandnew'],
			removed: ['faq'],
			updatedAt: '2026-09-02T00:00:00.000Z',
			updatedBy: 'admin-stable-id',
		}),
	})
	const context = createAuthTestContext({ kv })

	const addedResponse = await context.signup(
		'brandnew-holder@example.com',
		'brandnew',
	)
	expect(addedResponse.status).toBe(400)
	expect(await addedResponse.json()).toEqual({
		error: 'This username is reserved.',
	})

	const unreservedResponse = await context.signup(
		'faq-holder@example.com',
		'faq',
	)
	expect(unreservedResponse.status).toBe(200)
	expect(await unreservedResponse.json()).toEqual(signupAccepted)
})
