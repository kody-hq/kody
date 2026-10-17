import { beforeAll, expect, test, vi } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import {
	consoleError,
	consoleInfo,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import { createAccountResendVerificationHandler } from './account-resend-verification.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
import {
	isOrgBindingMembershipQuery,
	mockPersonalOrgBindingRow,
} from '#worker/test-support/org-binding-query.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

type StatementMeta = { changes: number; last_row_id: number }

function createResendTestDb(
	options: {
		emailVerifiedAt?: string | null
		deliveryClass?: string | null
		deliveryStatus?: string | null
		deletingAt?: string | null
		fenceAfterWritableCheck?: boolean
		hardBounced?: boolean
	} = {},
) {
	const user = {
		id: 1,
		email: 'resend-user@example.com',
		username: 'resend-user',
		password_hash: 'unused',
		stable_user_id: testStableUserIdFromEmail('resend-user@example.com'),
		email_verified_at: options.emailVerifiedAt ?? null,
		created_at: new Date(0).toISOString(),
		updated_at: new Date(0).toISOString(),
	}
	const state = {
		verificationInserts: 0,
		verificationDeletes: 0,
		rateLimitAttempts: 0,
		rateLimitMax: 3,
		recipientCapAttempts: 0,
		fenceAfterWritableCheck: false,
	}

	function createStatement(query: string) {
		const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
		const statement = {
			query: normalized,
			params: [] as Array<unknown>,
			bind(...params: Array<unknown>) {
				statement.params = params
				return statement
			},
			async all() {
				if (
					normalized.startsWith('select') &&
					normalized.includes('from "users"')
				) {
					return {
						results: [{ ...user }],
						meta: { changes: 0, last_row_id: 0 } satisfies StatementMeta,
					}
				}
				if (normalized.includes('insert into email_verifications')) {
					state.verificationInserts += 1
					return {
						results: [],
						meta: { changes: 1, last_row_id: 1 } satisfies StatementMeta,
					}
				}
				return {
					results: [],
					meta: { changes: 0, last_row_id: 0 } satisfies StatementMeta,
				}
			},
			async first() {
				if (isOrgBindingMembershipQuery(normalized)) {
					return mockPersonalOrgBindingRow(user.stable_user_id, user.username)
				}
				if (
					normalized.includes('select deleting_at from users') ||
					normalized.includes(
						'select deleting_at, stable_user_id, personal_org_id',
					)
				) {
					if (options.fenceAfterWritableCheck) {
						state.fenceAfterWritableCheck = true
					}
					return {
						deleting_at: options.deletingAt ?? null,
						stable_user_id: user.stable_user_id,
						personal_org_id: user.stable_user_id,
					}
				}
				if (normalized.includes('from email_verification_hard_bounces')) {
					return options.hardBounced
						? { recipient: user.email, status: 'bounced' }
						: null
				}
				if (normalized.includes('email_verification_delivery_status')) {
					return {
						email_verification_delivery_status: options.deliveryStatus ?? null,
						email_verification_delivery_class: options.deliveryClass ?? null,
						email_verification_delivery_at: null,
					}
				}
				const result = await statement.all()
				return result.results[0] ?? null
			},
			async run() {
				if (/delete from "?email_verifications"?/.test(normalized)) {
					state.verificationDeletes += 1
				}
				if (/insert into "?email_verifications"?/.test(normalized)) {
					if (state.fenceAfterWritableCheck) {
						return { meta: { changes: 0, last_row_id: 0 } }
					}
					state.verificationInserts += 1
					return { meta: { changes: 1, last_row_id: 1 } }
				}
				if (normalized.includes('delete from _rate_limits')) {
					const key = String(statement.params[0] ?? '')
					if (!key.startsWith('verify-email:recipient:')) {
						state.rateLimitAttempts = Math.max(0, state.rateLimitAttempts - 1)
					}
				}
				return { meta: { changes: 1, last_row_id: 1 } }
			},
		}
		return statement
	}

	const db = {
		prepare: (query: string) => createStatement(query),
		async batch(statements: Array<{ query?: string }>) {
			const allSelect = statements.every((statement) =>
				/^\s*select\b/i.test(statement.query ?? ''),
			)
			if (allSelect) {
				return await executePreparedD1Batch(statements)
			}
			if (
				statements.some((statement) =>
					statement.query?.includes('create table'),
				)
			) {
				return statements.map(() => ({
					meta: { changes: 0, last_row_id: 0 },
				}))
			}
			const insert = statements.find((statement) =>
				statement.query?.includes('insert into _rate_limits'),
			)
			const key = String(
				(insert as { params?: Array<unknown> } | undefined)?.params?.[0] ?? '',
			)
			if (key.startsWith('verify-email:recipient:')) {
				state.recipientCapAttempts += 1
				const allowed = state.recipientCapAttempts <= 5
				return [
					{ meta: { changes: 0, last_row_id: 0 } },
					{ meta: { changes: allowed ? 1 : 0, last_row_id: 0 } },
				]
			}
			state.rateLimitAttempts += 1
			const allowed = state.rateLimitAttempts <= state.rateLimitMax
			return [
				{ meta: { changes: 0, last_row_id: 0 } },
				{ meta: { changes: allowed ? 1 : 0, last_row_id: 0 } },
			]
		},
		async exec() {
			return
		},
	} as unknown as D1Database

	return { db, state }
}

function createAppEnv(db: D1Database, overrides: Record<string, unknown> = {}) {
	return {
		APP_DB: db,
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
		FLAG_EXPOSURES: { writeDataPoint() {} },
		...overrides,
	} as unknown as Parameters<typeof createAccountResendVerificationHandler>[0]
}

const session: AuthSession = {
	stableUserId: testStableUserIdFromEmail('resend-user@example.com'),
	email: 'resend-user@example.com',
	rememberMe: false,
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

function createResendClient(
	dbOptions: Parameters<typeof createResendTestDb>[0] = {},
	envOverrides: Record<string, unknown> = {},
) {
	const testDb = createResendTestDb(dbOptions)
	const { handler } = createAccountResendVerificationHandler(
		createAppEnv(testDb.db, envOverrides),
	)
	const send = async (signedIn = true) => {
		const request = new Request(
			'http://example.com/account/resend-verification.json',
			{
				method: 'POST',
				headers: signedIn
					? { Cookie: await createAuthCookie(session, false) }
					: {},
			},
		)
		return handler({ request, url: new URL(request.url), params: {} } as never)
	}
	return { state: testDb.state, send }
}

const resendAudit = (result: string, reason?: string) =>
	expect.objectContaining({
		category: 'auth',
		action: 'email_verification_resend',
		result,
		...(reason ? { reason } : {}),
	})

test('resend verification refuses without minting a token', async () => {
	const accountDeleting = expect.objectContaining({
		ok: false,
		code: 'account_deleting',
	})
	const cases = [
		{ label: 'unauthenticated', signedIn: false, status: 401 },
		{
			label: 'known sender-domain block',
			db: { deliveryStatus: 'bounced', deliveryClass: 'sender_block' },
			status: 409,
			body: expect.objectContaining({ ok: false, code: 'sender_block' }),
			auditReason: 'sender_block',
		},
		{
			label: 'already verified',
			db: { emailVerifiedAt: new Date(0).toISOString() },
			status: 400,
			body: { ok: false, error: 'Your email is already verified.' },
		},
		{
			label: 'fenced account',
			db: { deletingAt: '2026-09-02 12:00:00' },
			status: 409,
			body: accountDeleting,
		},
		{
			label: 'purge claim after the writable check',
			db: { fenceAfterWritableCheck: true },
			status: 409,
			body: accountDeleting,
		},
	]
	for (const { label, db, signedIn, status, body, auditReason } of cases) {
		logAuditEventSpy.mockClear()
		const { state, send } = createResendClient(db)
		const response = await send(signedIn)
		expect([
			label,
			response.status,
			body === undefined ? undefined : await response.json(),
			state.verificationInserts,
		]).toEqual([label, status, body, 0])
		if (auditReason) {
			expect(logAuditEventSpy).toHaveBeenCalledWith(
				resendAudit('failure', auditReason),
			)
		}
	}
})

test('resend verification refuses a hard-bounced recipient before using the per-account limit', async () => {
	const { state, send } = createResendClient({ hardBounced: true })
	const response = await send()
	expect(response.status).toBe(409)
	expect(await response.json()).toMatchObject({
		ok: false,
		code: 'recipient_hard_bounce',
	})
	expect(state.verificationInserts).toBe(0)
	expect(state.rateLimitAttempts).toBe(0)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		resendAudit('failure', 'recipient_hard_bounce'),
	)
})

test('resend verification issues a fresh token for unverified accounts and rate-limits repeats', async () => {
	const { state, send } = createResendClient({ emailVerifiedAt: null })

	for (let attempt = 1; attempt <= 3; attempt++) {
		const response = await send()
		expect([attempt, response.status, await response.json()]).toEqual([
			attempt,
			200,
			{ ok: true, message: 'Verification email sent. Check your inbox.' },
		])
	}
	expect(state.verificationInserts).toBe(3)
	expect(state.verificationDeletes).toBe(3)
	// No email sender is configured in this test env, so each resend logs
	// the send as skipped at info level.
	expect(consoleInfo).toHaveBeenCalledWith(
		'email-verification-send-skipped',
		expect.any(Number),
	)

	const rateLimitedResponse = await send()
	expect(rateLimitedResponse.status).toBe(429)
	expect(rateLimitedResponse.headers.get('Retry-After')).toBeTruthy()
	expect(await rateLimitedResponse.json()).toEqual({
		ok: false,
		error:
			'Too many verification emails for this account. You can request 3 every 15 minutes. Try again in 15 minutes.',
		code: 'verification_resend_cap',
	})
	// No new token is created for rate-limited requests.
	expect(state.verificationInserts).toBe(3)
	// Three successful resends plus the rate-limited attempt are audited.
	expect(logAuditEventSpy).toHaveBeenCalledTimes(4)
	expect(logAuditEventSpy).toHaveBeenNthCalledWith(3, resendAudit('success'))
	expect(logAuditEventSpy).toHaveBeenNthCalledWith(
		4,
		resendAudit('rate_limited'),
	)
})

test('resend verification surfaces send failures without pretending success', async () => {
	consoleError.mockImplementation(() => {})
	consoleWarn.mockImplementation(() => {})
	const { state, send } = createResendClient(
		{ emailVerifiedAt: null },
		{
			CLOUDFLARE_ACCOUNT_ID: 'cf-account-test',
			CLOUDFLARE_API_TOKEN: 'cf-token-test',
			CLOUDFLARE_API_BASE_URL: 'https://cloudflare-api.example.com',
		},
	)
	vi.stubGlobal(
		'fetch',
		vi.fn(async () =>
			Response.json(
				{ success: false, errors: [{ message: 'delivery refused' }] },
				{ status: 500 },
			),
		),
	)

	const response = await send()
	expect(response.status).toBe(502)
	expect(await response.json()).toEqual({
		ok: false,
		error: 'Unable to send the verification email. Please try again later.',
	})
	// The failed send refunds the consumed rate-limit slot.
	expect(state.rateLimitAttempts).toBe(0)
	// The freshly inserted token is discarded again on send failure, so no
	// net-new token remains and prior tokens stay untouched.
	expect(state.verificationInserts).toBe(1)
	expect(state.verificationDeletes).toBe(1)
	expect(consoleError).toHaveBeenCalledWith(
		expect.any(String),
		expect.any(Error),
	)
	// The failed Cloudflare API send is warned for operators.
	expect(consoleWarn).toHaveBeenCalledWith(
		'cloudflare-email-api-failed',
		expect.any(String),
	)
	expect(logAuditEventSpy).toHaveBeenCalledTimes(1)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		resendAudit('failure', 'send_failed'),
	)
	vi.unstubAllGlobals()
})
