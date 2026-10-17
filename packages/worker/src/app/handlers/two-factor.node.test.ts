import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { testAccountTwoFactorApiHandler } from '#app/handlers/account-two-factor.test-support.ts'
import { twoFactorVerifyRateLimitConfig } from '#app/rate-limit.ts'
import { confirmTwoFactorSetup } from '#app/two-factor.ts'
import {
	createVerifySessionCookie,
	setVerifySessionSecret,
} from '#app/verify-session.ts'
import { verifyWebsiteTwoFactor } from '#worker/identity/verify-operations.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { provisionPersonalOrgForSqliteUser } from '#worker/test-support/personal-org-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { generateTOTP } from '@epic-web/totp'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'

vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserCreatedEvent: vi.fn(),
	scheduleUserDeletedEvent: vi.fn(),
}))

const { createAuthHandler } = await import('#app/handlers/auth.ts')

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

const session: AuthSession = {
	stableUserId: testStableUserIdFromEmail('kody@example.com'),
	email: 'kody@example.com',
	rememberMe: false,
}

type Handler = ReturnType<typeof testAccountTwoFactorApiHandler>

function runHandler(handler: Handler, request: Request) {
	return handler.execute({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
}

function postJson(path: string, body: unknown, cookie?: string) {
	return new Request(`http://example.com${path}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(cookie ? { Cookie: cookie } : {}),
		},
		body: JSON.stringify(body),
	})
}

type VerificationRow = {
	type: string
	secret: string
	algorithm: string
	digits: number
	period: number
	char_set: string
}

async function currentCode(row: VerificationRow) {
	const { otp } = await generateTOTP({
		secret: row.secret,
		algorithm: row.algorithm,
		digits: row.digits,
		period: row.period,
		charSet: row.char_set,
	})
	return otp
}

function isClearedCookie(name: string) {
	return (cookie: string) =>
		cookie.startsWith(`${name}=`) && cookie.includes('Max-Age=0')
}

async function setupTwoFactor({ seedUser = true } = {}) {
	setAuthSessionSecret(testCookieSecret)
	setVerifySessionSecret(testCookieSecret)
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	if (seedUser) {
		const passwordHash = await createPasswordHash('ilikecode')
		const stableUserId = testStableUserIdFromEmail('kody@example.com')
		sqlite.exec(`
			INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
			VALUES (1, 'kody', 'kody@example.com', ${quoteSqlString(stableUserId)},
				${quoteSqlString(passwordHash)}, CURRENT_TIMESTAMP);
		`)
		await provisionPersonalOrgForSqliteUser(sqlite, {
			stableUserId,
			username: 'kody',
		})
	}
	const env = {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Parameters<typeof testAccountTwoFactorApiHandler>[0]
	const twoFactorHandler = testAccountTwoFactorApiHandler(env)
	const readRow = () =>
		sqlite
			.prepare(
				`SELECT type, secret, algorithm, digits, period, char_set
				 FROM verifications WHERE target = ?`,
			)
			.get('1') as VerificationRow | undefined
	const post = async (body: Record<string, unknown>) =>
		runHandler(
			twoFactorHandler,
			postJson(
				'/account/two-factor.json',
				body,
				await createAuthCookie(session, false),
			),
		)
	return {
		sqlite,
		db,
		env,
		readRow,
		post,
		async enable() {
			await post({ intent: 'setup' })
			const row = readRow()!
			await post({ intent: 'confirm', code: await currentCode(row) })
			return row
		},
		login() {
			return runAuthHandler(
				createAuthHandler(
					env as unknown as Parameters<typeof createAuthHandler>[0],
				),
				postJson('/auth', {
					email: 'kody@example.com',
					password: 'ilikecode',
					mode: 'login',
				}),
			)
		},
		verify(code: string, cookie?: string) {
			const request = postJson('/verify/2fa.json', { code }, cookie)
			return verifyWebsiteTwoFactor({
				env,
				request,
				url: new URL(request.url),
				body: { code },
			})
		},
		countRows() {
			return (
				sqlite
					.prepare(
						`SELECT COUNT(*) AS count FROM verifications WHERE target = '1'`,
					)
					.get() as { count: number }
			).count
		},
	}
}

test('two-factor setup requires authentication and a valid code before activating', async () => {
	const anonymous = await setupTwoFactor({ seedUser: false })
	const unauthenticated = await runHandler(
		testAccountTwoFactorApiHandler(anonymous.env),
		postJson('/account/two-factor.json', { intent: 'setup' }),
	)
	expect(unauthenticated.status).toBe(401)

	const { post, readRow } = await setupTwoFactor()
	const setupResponse = await post({ intent: 'setup' })
	expect(setupResponse.status).toBe(200)
	const setupPayload = setupResponse.data as {
		ok: boolean
		otpUri: string
		secret: string
	}
	expect(setupPayload.ok).toBe(true)
	expect(setupPayload.otpUri).toContain('otpauth://totp/')
	expect(setupPayload.otpUri).toContain(setupPayload.secret)
	const pendingRow = readRow()!
	expect(pendingRow).toMatchObject({
		type: '2fa-verify',
		secret: setupPayload.secret,
	})

	expect((await post({ intent: 'confirm', code: '000000' })).status).toBe(400)
	expect(readRow()?.type).toBe('2fa-verify')

	const confirmResponse = await post({
		intent: 'confirm',
		code: await currentCode(pendingRow),
	})
	expect(confirmResponse.status).toBe(200)
	expect(confirmResponse.data).toEqual({ ok: true, enabled: true })
	// The row is promoted in place: the scanned secret stays the active one.
	expect(readRow()).toMatchObject({ type: '2fa', secret: setupPayload.secret })
	// Setup start, the rejected confirm, and the successful enable are audited
	// — and nothing else.
	expect(auditEventSummaries()).toEqual([
		'two_factor_setup_start:success',
		'two_factor_enable:failure',
		'two_factor_enable:success',
	])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'two_factor_enable',
			result: 'success',
		}),
	)
})

test('cancelling a pending setup removes it without touching active 2fa', async () => {
	const { post, readRow } = await setupTwoFactor()
	await post({ intent: 'setup' })
	const cancelResponse = await post({ intent: 'cancel' })
	expect(cancelResponse.status).toBe(200)
	expect(cancelResponse.data).toEqual({ ok: true, enabled: false })
	expect(readRow()).toBeUndefined()
})

test('cancelling setup preserves an already enabled authenticator', async () => {
	const { enable, post, readRow } = await setupTwoFactor()
	await enable()
	const active = readRow()
	const cancelled = await post({ intent: 'cancel' })
	expect(cancelled.status).toBe(200)
	expect(cancelled.data).toEqual({ ok: true, enabled: true })
	expect(readRow()).toEqual(active)
})

test('login issues the session directly without 2fa and defers it to code verification once 2fa is enabled', async () => {
	const { enable, login, verify } = await setupTwoFactor()
	const directLogin = await login()
	expect(directLogin.status).toBe(200)
	expect(await directLogin.json()).toEqual({ ok: true, mode: 'login' })
	expect(directLogin.headers.get('Set-Cookie')).toContain('kody_session=')

	const verificationRow = await enable()
	const loginResponse = await login()
	expect(loginResponse.status).toBe(200)
	expect(await loginResponse.json()).toEqual({
		ok: true,
		mode: 'login',
		requiresTwoFactor: true,
	})
	const loginSetCookies = loginResponse.headers.getSetCookie()
	const pendingCookie = loginSetCookies.find((cookie) =>
		cookie.startsWith('kody_verify='),
	)
	expect(pendingCookie).toBeDefined()
	// Any pre-existing session is cleared while the second factor is pending.
	expect(loginSetCookies.some(isClearedCookie('kody_session'))).toBe(true)
	expect(
		loginSetCookies.some(
			(cookie) =>
				cookie.startsWith('kody_session=') && !cookie.includes('Max-Age=0'),
		),
	).toBe(false)

	const verifyCookie = pendingCookie?.split(';')[0] ?? ''
	const invalidVerify = await verify('000000', verifyCookie)
	expect(invalidVerify.status).toBe(400)
	expect(invalidVerify.headers.get('Set-Cookie')).toBeNull()

	const validVerify = await verify(
		await currentCode(verificationRow),
		verifyCookie,
	)
	expect(validVerify.status).toBe(200)
	expect(validVerify.data).toEqual({ ok: true })
	const verifySetCookies = validVerify.headers.getSetCookie()
	expect(
		verifySetCookies.some((cookie) => cookie.startsWith('kody_session=')),
	).toBe(true)
	expect(verifySetCookies.some(isClearedCookie('kody_verify'))).toBe(true)

	const missingVerify = await verify('123456')
	expect(missingVerify.status).toBe(401)
	expect(missingVerify.data).toMatchObject({
		ok: false,
		code: 'expired',
	})
})

test('repeated invalid codes lock the account out of 2fa verification', async () => {
	const { enable, verify } = await setupTwoFactor()
	const verificationRow = await enable()
	const pendingCookie = (
		await createVerifySessionCookie(
			{
				stableUserId: session.stableUserId,
				email: session.email,
				rememberMe: false,
			},
			false,
		)
	).split(';')[0]

	for (let i = 0; i < twoFactorVerifyRateLimitConfig.maxRequests; i++) {
		expect((await verify('000000', pendingCookie)).status).toBe(400)
	}
	const locked = await verify('000000', pendingCookie)
	expect(locked.status).toBe(429)
	expect(locked.data).toMatchObject({ ok: false, code: 'locked' })
	expect(locked.headers.get('Retry-After')).toBe(
		String(twoFactorVerifyRateLimitConfig.windowSeconds),
	)
	expect(
		locked.headers.getSetCookie().some(isClearedCookie('kody_verify')),
	).toBe(true)

	// The budget is keyed on the account, so re-minting the pending cookie by
	// logging in again does not buy more guesses.
	const validAfterLockout = await verify(
		await currentCode(verificationRow),
		pendingCookie,
	)
	expect(validAfterLockout.status).toBe(429)
})

test('disabling 2fa requires a valid current code and clears stale pending rows', async () => {
	const { sqlite, enable, post, readRow, countRows } = await setupTwoFactor()
	const verificationRow = await enable()

	expect((await post({ intent: 'disable', code: '000000' })).status).toBe(400)
	expect(readRow()?.type).toBe('2fa')

	sqlite.exec(`
		INSERT INTO verifications (
			type, target, secret, algorithm, digits, period, char_set, expires_at
		) VALUES ('2fa-verify', '1', 'STALESECRET', 'SHA-1', 6, 30, '0123456789', NULL);
	`)
	expect(countRows()).toBe(2)

	const validDisable = await post({
		intent: 'disable',
		code: await currentCode(verificationRow),
	})
	expect(validDisable.status).toBe(200)
	expect(validDisable.data).toEqual({ ok: true, enabled: false })
	expect(countRows()).toBe(0)
	// The in-test 2FA enablement plus the rejected and successful disable
	// attempts are audited — and nothing else.
	expect(auditEventSummaries()).toEqual([
		'two_factor_setup_start:success',
		'two_factor_enable:success',
		'two_factor_disable:failure',
		'two_factor_disable:success',
	])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'two_factor_disable',
			result: 'success',
		}),
	)
})

test('setup and confirm are rejected while 2fa is already enabled', async () => {
	const { enable, post, readRow } = await setupTwoFactor()
	const activeRow = await enable()

	// A hijacked session must not be able to swap out the active factor.
	expect((await post({ intent: 'setup' })).status).toBe(400)
	expect(
		(await post({ intent: 'confirm', code: await currentCode(activeRow) }))
			.status,
	).toBe(400)
	expect(readRow()).toMatchObject({ type: '2fa', secret: activeRow.secret })
})

test('a duplicate confirm cannot delete the active factor', async () => {
	const { db, post, readRow } = await setupTwoFactor()
	await post({ intent: 'setup' })
	const pendingRow = readRow()!

	// Simulates two racing confirm requests that both passed the code check:
	// the first promotes, the second must be a no-op rather than deleting the
	// freshly-activated row.
	expect(await confirmTwoFactorSetup(db, 1)).toBe(true)
	expect(await confirmTwoFactorSetup(db, 1)).toBe(false)
	expect(readRow()).toMatchObject({ type: '2fa', secret: pendingRow.secret })
})

function runAuthHandler(
	handler: ReturnType<typeof createAuthHandler>,
	request: Request,
) {
	return handler({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
}

test('a deleted person cannot finish a previously issued TOTP challenge or mint a fresh password session', async () => {
	const { sqlite, enable, login, verify } = await setupTwoFactor()
	const row = await enable()
	const pending = await login()
	const cookie = pending.headers
		.getSetCookie()
		.find((cookie) => cookie.startsWith('kody_verify='))!
		.split(';')[0]!
	sqlite.exec(`UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = 1`)
	const result = await verify(await currentCode(row), cookie)
	expect(result.status).toBe(400)
	expect(result.data).toMatchObject({ ok: false, error: 'Invalid code.' })
	expect(
		result.headers
			.getSetCookie()
			.some(
				(cookie) =>
					cookie.startsWith('kody_session=') && !cookie.includes('Max-Age=0'),
			),
	).toBe(false)
	const retry = await login()
	expect(retry.status).toBe(401)
	expect(
		retry.headers
			.getSetCookie()
			.some(
				(cookie) =>
					cookie.startsWith('kody_session=') && !cookie.includes('Max-Age=0'),
			),
	).toBe(false)
})
