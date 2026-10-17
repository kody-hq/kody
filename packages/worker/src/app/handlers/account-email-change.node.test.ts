import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { verifyEmailChangeToken } from '#app/email-change.ts'
import { hashVerificationToken } from '#app/email-verification.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { provisionPersonalOrgForSqliteUser } from '#worker/test-support/personal-org-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { requestWebsiteEmailChange } from '#worker/identity/account-email-change-operations.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

function applyMigrations(db: DatabaseSync) {
	const migrationsDir = new URL('../../../migrations/', import.meta.url)
	applyAllMigrations(db, migrationsDir)
}

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyMigrations(sqlite)
	return {
		sqlite,
		db: createD1FromSqlite(sqlite),
	}
}

async function seedUser(
	sqlite: DatabaseSync,
	input: {
		id: number
		email: string
		username: string
		password: string
		verified?: boolean
	},
) {
	const passwordHash = await createPasswordHash(input.password)
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
			${input.verified === false ? 'NULL' : 'CURRENT_TIMESTAMP'}
		);
	`)
	await provisionPersonalOrgForSqliteUser(sqlite, {
		stableUserId,
		username: input.username,
	})
	return stableUserId
}

function createAppEnv(db: D1Database) {
	return {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Env
}

function createEmailChangeClient(db: D1Database, currentEmail: string) {
	const env = createAppEnv(db)
	const session: AuthSession = {
		stableUserId: testStableUserIdFromEmail(currentEmail),
		email: currentEmail,
		rememberMe: false,
	}
	return async (email: string, password = 'correct-password') => {
		const request = new Request(
			'http://example.com/account/email-change.json',
			{
				method: 'POST',
				headers: {
					Cookie: await createAuthCookie(session, false),
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ email, password }),
			},
		)
		return requestWebsiteEmailChange({
			env,
			request,
			url: new URL(request.url),
			body: { email, password },
		})
	}
}

const pendingCount = (sqlite: DatabaseSync) =>
	sqlite.prepare(`SELECT COUNT(*) AS count FROM pending_email_changes`).get()

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

test('email change requests require the current password and create a pending verification', async () => {
	// No email sender is configured in this test env, so the skipped
	// verification send logs a warning.
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createMigratedDb()
	await seedUser(sqlite, {
		id: 1,
		email: 'old@example.com',
		username: 'old-user',
		password: 'correct-password',
	})
	const requestChange = createEmailChangeClient(db, 'old@example.com')

	const wrongPasswordResponse = await requestChange(
		'new@example.com',
		'wrong-password',
	)
	expect(wrongPasswordResponse.status).toBe(401)
	expect(await Promise.resolve(wrongPasswordResponse.data)).toEqual({
		ok: false,
		code: 'invalid_password',
		error: 'Password is incorrect.',
	})
	expect(pendingCount(sqlite)).toEqual({ count: 0 })

	const response = await requestChange('New@Example.com')
	expect(response.status).toBe(200)
	expect(await Promise.resolve(response.data)).toEqual({
		ok: true,
		formerEmailRemainsClaimed: true,
		message:
			'Verification email sent to your new address. After you confirm, your current address stays tied to this account until you release it from Former addresses.',
	})
	const firstPending = sqlite
		.prepare(`SELECT user_id, new_email, token_hash FROM pending_email_changes`)
		.get() as { token_hash: string }
	expect(firstPending).toMatchObject({
		user_id: 1,
		new_email: 'new@example.com',
		token_hash: expect.any(String),
	})

	const resendResponse = await requestChange('new@example.com')
	expect(resendResponse.status).toBe(200)
	const pendingRows = sqlite
		.prepare(`SELECT new_email, token_hash FROM pending_email_changes`)
		.all() as Array<{ new_email: string; token_hash: string }>
	expect(pendingRows).toHaveLength(1)
	expect(pendingRows[0]).toMatchObject({
		new_email: 'new@example.com',
		token_hash: expect.any(String),
	})
	expect(pendingRows[0]?.token_hash).not.toBe(firstPending.token_hash)
	expect(consoleWarn).toHaveBeenCalledWith('email-change-send-skipped', 1)
})

test('unverified accounts cannot start an email change', async () => {
	const { sqlite, db } = createMigratedDb()
	await seedUser(sqlite, {
		id: 1,
		email: 'unverified@example.com',
		username: 'unverified-user',
		password: 'correct-password',
		verified: false,
	})

	const response = await createEmailChangeClient(
		db,
		'unverified@example.com',
	)('new@example.com')
	expect(response.status).toBe(403)
	expect(await Promise.resolve(response.data)).toEqual({
		ok: false,
		error: 'Verify your current email address before changing it.',
	})
	expect(pendingCount(sqlite)).toEqual({ count: 0 })
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'email_change_request',
			result: 'failure',
			reason: 'email_unverified',
		}),
	)
	expect(auditEventSummaries()).toEqual(['email_change_request:failure'])
})

test('email change requests reject emails already owned by another account', async () => {
	const { sqlite, db } = createMigratedDb()
	await seedUser(sqlite, {
		id: 1,
		email: 'old@example.com',
		username: 'old-user',
		password: 'correct-password',
	})
	await seedUser(sqlite, {
		id: 2,
		email: 'taken@example.com',
		username: 'taken-user',
		password: 'taken-password',
	})

	const response = await createEmailChangeClient(
		db,
		'old@example.com',
	)('taken@example.com')
	expect(response.status).toBe(409)
	expect(await Promise.resolve(response.data)).toEqual({
		ok: false,
		error: 'Email already registered.',
	})
	expect(pendingCount(sqlite)).toEqual({ count: 0 })
})

test('email change verification updates email and preserves stable user id', async () => {
	const { sqlite, db } = createMigratedDb()
	const oldStableUserId = await seedUser(sqlite, {
		id: 1,
		email: 'old@example.com',
		username: 'old-user',
		password: 'correct-password',
		verified: false,
	})
	const token = 'verify-email-change-token'
	const tokenHash = await hashVerificationToken(token)
	const now = new Date('2026-07-06T00:00:00.000Z')
	const expiresAt = now.getTime() + 60_000
	sqlite.exec(`
		INSERT INTO email_verifications (user_id, token_hash, expires_at)
		VALUES (1, 'old-account-token', ${expiresAt});
		INSERT INTO pending_email_changes (user_id, new_email, token_hash, expires_at)
		VALUES (1, 'new@example.com', ${quoteSqlString(tokenHash)}, ${expiresAt});
	`)

	const result = await verifyEmailChangeToken({ db, token, now })
	expect(result).toEqual({
		ok: true,
		userId: 1,
		stableUserId: oldStableUserId,
		oldEmail: 'old@example.com',
		newEmail: 'new@example.com',
	})
	expect(
		sqlite
			.prepare(
				`SELECT email, stable_user_id, email_verified_at FROM users WHERE id = 1`,
			)
			.get(),
	).toEqual({
		email: 'new@example.com',
		stable_user_id: oldStableUserId,
		email_verified_at: '2026-07-06T00:00:00.000Z',
	})
	expect(pendingCount(sqlite)).toEqual({ count: 0 })
	expect(
		sqlite.prepare(`SELECT COUNT(*) AS count FROM email_verifications`).get(),
	).toEqual({ count: 0 })
	expect(
		sqlite
			.prepare(
				`SELECT email, status FROM user_email_claims WHERE user_id = 1 ORDER BY email`,
			)
			.all() as Array<{ email: string; status: string }>,
	).toEqual([
		{ email: 'new@example.com', status: 'claimed' },
		{ email: 'old@example.com', status: 'claimed' },
	])
})
