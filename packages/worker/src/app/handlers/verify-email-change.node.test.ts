import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, expect, test, vi } from 'vitest'
import type * as CloudflareEmail from '#app/email/cloudflare-email.ts'
import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import { hashVerificationToken } from '#app/email-verification.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { provisionPersonalOrgForSqliteUser } from '#worker/test-support/personal-org-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { maskEmailAddressForNotice } from '#app/email/messages.ts'

const mockSendCloudflareEmail = vi.fn(
	async (..._args: Parameters<typeof CloudflareEmail.sendCloudflareEmail>) => ({
		ok: true,
	}),
)

const deferredWork = vi.hoisted(() => new Array<Promise<unknown>>())

vi.mock('cloudflare:workers', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		waitUntil: (promise: Promise<unknown>) => {
			deferredWork.push(promise)
		},
	}
})

async function flushDeferredWork() {
	await Promise.all(deferredWork.splice(0))
}

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (
		...args: Parameters<typeof CloudflareEmail.sendCloudflareEmail>
	) => mockSendCloudflareEmail(...args),
}))

const { executeVerifyEmailChange } =
	await import('#app/handlers/verify-email-change.ts')

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	return {
		sqlite,
		db: createD1FromSqlite(sqlite),
	}
}

async function seedVerifiedUser(
	sqlite: DatabaseSync,
	input: { id: number; email: string; username: string },
) {
	const passwordHash = await createPasswordHash('correct-password')
	const stableUserId = testStableUserIdFromEmail(input.email)
	sqlite.exec(`
		INSERT INTO users (
			id,
			username,
			email,
			stable_user_id,
			password_hash,
			email_verified_at
		) VALUES (
			${input.id},
			${quoteSqlString(input.username)},
			${quoteSqlString(input.email)},
			${quoteSqlString(stableUserId)},
			${quoteSqlString(passwordHash)},
			CURRENT_TIMESTAMP
		);
	`)
	await provisionPersonalOrgForSqliteUser(sqlite, {
		stableUserId,
		username: input.username,
	})
	return stableUserId
}

function createEnv(db: D1Database) {
	return {
		APP_DB: db,
		APP_BASE_URL: 'https://kody.codes',
		SYSTEM_EMAIL_DOMAIN: 'kody.codes',
		COOKIE_SECRET: testCookieSecret,
		CLOUDFLARE_ACCOUNT_ID: 'account-id',
		CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test',
		CLOUDFLARE_API_TOKEN: 'api-token',
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Env
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

test('successful email change notifies the previous address with masked new email', async () => {
	mockSendCloudflareEmail.mockClear()
	const { sqlite, db } = createMigratedDb()
	const oldEmail = 'old@example.com'
	const newEmail = 'new-login@example.com'
	const stableUserId = await seedVerifiedUser(sqlite, {
		id: 1,
		email: oldEmail,
		username: 'old-user',
	})
	const token = 'a'.repeat(64)
	const tokenHash = await hashVerificationToken(token)
	const expiresAt = Date.now() + 60_000
	sqlite.exec(`
		INSERT INTO pending_email_changes (user_id, new_email, token_hash, expires_at)
		VALUES (1, ${quoteSqlString(newEmail)}, ${quoteSqlString(tokenHash)}, ${expiresAt});
	`)

	const request = new Request(
		`https://kody.codes/verify-email-change?token=${token}`,
		{
			headers: {
				Cookie: await createAuthCookie(
					{
						stableUserId,
						email: oldEmail,
						rememberMe: false,
					},
					false,
				),
				'CF-Connecting-IP': '203.0.113.10',
				'User-Agent': 'KodySecurityTest/1.0',
			},
		},
	)
	Object.defineProperty(request, 'cf', {
		value: { country: 'US' },
		configurable: true,
	})

	const result = await executeVerifyEmailChange({
		request,
		env: createEnv(db),
		token,
	})
	await flushDeferredWork()

	expect(result.ok).toBe(true)
	expect(sqlite.prepare(`SELECT email FROM users WHERE id = 1`).get()).toEqual({
		email: newEmail,
	})
	expect(mockSendCloudflareEmail).toHaveBeenCalledTimes(1)
	const [, message] = mockSendCloudflareEmail.mock.calls[0]!
	expect(message).toMatchObject({
		to: oldEmail,
		from: 'kody@kody.codes',
		subject: 'Your Kody account email was changed',
	})
	const text = (message as { text: string }).text
	expect(text).toContain(oldEmail)
	expect(text).toContain(maskEmailAddressForNotice(newEmail))
	expect(text).not.toContain(newEmail)
	expect(text).toContain('IP 203.0.113.10')
	expect(text).toContain('country US')
	expect(text).toContain('browser KodySecurityTest/1.0')
	expect(text).toContain('support@kody.codes')
	expect(text).toContain('https://kody.codes/reset-password')
	expect(text).toContain('https://kody.codes/account')
})

test('failed email change does not notify the previous address', async () => {
	mockSendCloudflareEmail.mockClear()
	const { sqlite, db } = createMigratedDb()
	await seedVerifiedUser(sqlite, {
		id: 1,
		email: 'still-old@example.com',
		username: 'still-old',
	})

	const result = await executeVerifyEmailChange({
		request: new Request('https://kody.codes/verify-email-change?token=bad'),
		env: createEnv(db),
		token: 'not-a-real-token',
	})
	await flushDeferredWork()

	expect(result.ok).toBe(false)
	expect(sqlite.prepare(`SELECT email FROM users WHERE id = 1`).get()).toEqual({
		email: 'still-old@example.com',
	})
	expect(mockSendCloudflareEmail).not.toHaveBeenCalled()
})

test('security notice send failure does not undo a committed email change', async () => {
	mockSendCloudflareEmail.mockClear()
	mockSendCloudflareEmail.mockRejectedValueOnce(new Error('smtp down'))
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createMigratedDb()
	const oldEmail = 'keep-change@example.com'
	const newEmail = 'committed@example.com'
	await seedVerifiedUser(sqlite, {
		id: 1,
		email: oldEmail,
		username: 'keep-change',
	})
	const token = 'b'.repeat(64)
	const tokenHash = await hashVerificationToken(token)
	sqlite.exec(`
		INSERT INTO pending_email_changes (user_id, new_email, token_hash, expires_at)
		VALUES (1, ${quoteSqlString(newEmail)}, ${quoteSqlString(tokenHash)}, ${Date.now() + 60_000});
	`)

	const result = await executeVerifyEmailChange({
		request: new Request(
			`https://kody.codes/verify-email-change?token=${token}`,
		),
		env: createEnv(db),
		token,
	})
	await flushDeferredWork()

	expect(result.ok).toBe(true)
	expect(sqlite.prepare(`SELECT email FROM users WHERE id = 1`).get()).toEqual({
		email: newEmail,
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'email-changed-security-notice-error',
		expect.any(Error),
	)
})

test('a stalled security notice send does not hold up the success response', async () => {
	mockSendCloudflareEmail.mockClear()
	mockSendCloudflareEmail.mockImplementationOnce(() => new Promise(() => {}))
	const { sqlite, db } = createMigratedDb()
	const newEmail = 'stalled-notice@example.com'
	await seedVerifiedUser(sqlite, {
		id: 1,
		email: 'stalled-old@example.com',
		username: 'stalled-old',
	})
	const token = 'c'.repeat(64)
	const tokenHash = await hashVerificationToken(token)
	sqlite.exec(`
		INSERT INTO pending_email_changes (user_id, new_email, token_hash, expires_at)
		VALUES (1, ${quoteSqlString(newEmail)}, ${quoteSqlString(tokenHash)}, ${Date.now() + 60_000});
	`)

	const result = await executeVerifyEmailChange({
		request: new Request(
			`https://kody.codes/verify-email-change?token=${token}`,
		),
		env: createEnv(db),
		token,
	})

	expect(result.ok).toBe(true)
	expect(sqlite.prepare(`SELECT email FROM users WHERE id = 1`).get()).toEqual({
		email: newEmail,
	})
	expect(deferredWork).toHaveLength(1)
	deferredWork.splice(0)
})
