import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { verifyEmailClaimReleaseToken } from '#app/email-claim-release.ts'
import { hashVerificationToken } from '#app/email-verification.ts'
import { formerEmailClaimedSignupCode } from '#universal/email-claim-errors.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { provisionPersonalOrgForSqliteUser } from '#worker/test-support/personal-org-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { requestWebsiteEmailRelease } from '#worker/identity/account-email-claim-release-operations.ts'
import { createAuthHandler } from './auth.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

async function seedUser(
	sqlite: DatabaseSync,
	input: {
		id: number
		email: string
		username: string
		password: string
		stableUserId?: string
	},
) {
	const passwordHash = await createPasswordHash(input.password)
	const stableUserId =
		input.stableUserId ?? testStableUserIdFromEmail(input.email)
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, stable_user_id, password_hash, email_verified_at
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

function createAppEnv(db: D1Database) {
	return {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Env
}

function createReleaseClient(env: Env, session: AuthSession) {
	return async (email: string) => {
		const request = new Request(
			'http://example.com/account/email-claim-release.json',
			{
				method: 'POST',
				headers: {
					Cookie: await createAuthCookie(session, false),
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ email, password: 'correct-password' }),
			},
		)
		return requestWebsiteEmailRelease({
			env,
			request,
			url: new URL(request.url),
			body: { email, password: 'correct-password' },
		})
	}
}

const ownerSession: AuthSession = {
	stableUserId: testStableUserIdFromEmail('owner@example.com'),
	email: 'owner@example.com',
	rememberMe: false,
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

test('release re-verifies a former address then allows a new account without reminting', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createMigratedDb()
	const formerEmail = 'personal@example.com'
	const currentEmail = 'work@example.com'
	const stableUserId = await seedUser(sqlite, {
		id: 1,
		email: currentEmail,
		username: 'jamie',
		password: 'correct-password',
		stableUserId: testStableUserIdFromEmail(formerEmail),
	})
	sqlite.exec(`
		INSERT INTO user_email_claims (user_id, email, status)
		VALUES (1, ${quoteSqlString(currentEmail)}, 'claimed');
		INSERT INTO user_email_claims (user_id, email, status)
		VALUES (1, ${quoteSqlString(formerEmail)}, 'claimed');
	`)

	const env = createAppEnv(db)
	const release = createReleaseClient(env, {
		stableUserId: testStableUserIdFromEmail(formerEmail),
		email: currentEmail,
		rememberMe: false,
	})
	const signupHandler = createAuthHandler(env)
	const signupFormerEmail = () =>
		signupHandler({
			request: new Request('http://example.com/auth', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email: formerEmail,
					username: 'new-jamie',
					password: 'password123',
					mode: 'signup',
				}),
			}),
		})

	expect((await release(currentEmail)).status).toBe(400)

	const blockedSignup = await signupFormerEmail()
	expect(blockedSignup.status).toBe(409)
	expect(await blockedSignup.json()).toMatchObject({
		code: formerEmailClaimedSignupCode,
	})

	const requestResponse = await release(formerEmail)
	expect(requestResponse.status).toBe(200)
	expect(await Promise.resolve(requestResponse.data)).toMatchObject({
		ok: true,
	})
	expect(
		sqlite
			.prepare(
				`SELECT token_hash FROM pending_email_claim_releases WHERE user_id = 1`,
			)
			.get(),
	).toEqual({ token_hash: expect.any(String) })

	const token = 'release-former-email-token'
	const tokenHash = await hashVerificationToken(token)
	sqlite.exec(`
		UPDATE pending_email_claim_releases
		SET token_hash = ${quoteSqlString(tokenHash)}
		WHERE user_id = 1
	`)

	expect(await verifyEmailClaimReleaseToken({ db, token })).toEqual({
		ok: true,
		userId: 1,
		email: formerEmail,
	})
	expect(
		sqlite
			.prepare(
				`SELECT status FROM user_email_claims WHERE user_id = 1 AND email = ?`,
			)
			.get(formerEmail),
	).toEqual({ status: 'released' })
	expect(
		sqlite.prepare(`SELECT stable_user_id FROM users WHERE id = 1`).get(),
	).toEqual({ stable_user_id: stableUserId })

	expect((await signupFormerEmail()).status).toBe(200)
	const created = sqlite
		.prepare(`SELECT email, stable_user_id FROM users WHERE email = ?`)
		.get(formerEmail) as { email: string; stable_user_id: string }
	expect(created.email).toBe(formerEmail)
	expect(created.stable_user_id).not.toBe(stableUserId)
	expect(created.stable_user_id).toMatch(/^[a-f0-9]{64}$/)
})

test('release requests are rate limited and refuse another account email', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createMigratedDb()
	await seedUser(sqlite, {
		id: 1,
		email: 'owner@example.com',
		username: 'owner',
		password: 'correct-password',
	})
	await seedUser(sqlite, {
		id: 2,
		email: 'other@example.com',
		username: 'other',
		password: 'other-password',
	})
	const release = createReleaseClient(createAppEnv(db), ownerSession)

	const statuses = []
	for (const email of [
		'other@example.com',
		'old@example.com',
		'old@example.com',
		'old@example.com',
	]) {
		statuses.push([email, (await release(email)).status])
	}
	expect(statuses).toEqual([
		['other@example.com', 404],
		['old@example.com', 404],
		['old@example.com', 404],
		['old@example.com', 429],
	])
})

test('refunds the request limiter when the release email cannot be sent', async () => {
	consoleError.mockImplementation(() => {})
	const { sqlite, db } = createMigratedDb()
	await seedUser(sqlite, {
		id: 1,
		email: 'owner@example.com',
		username: 'owner',
		password: 'correct-password',
	})
	sqlite.exec(`
		INSERT INTO user_email_claims (user_id, email, status)
		VALUES (1, 'owner@example.com', 'claimed');
		INSERT INTO user_email_claims (user_id, email, status)
		VALUES (1, 'old@example.com', 'claimed');
	`)
	const release = createReleaseClient(
		{ ...createAppEnv(db), SENTRY_ENVIRONMENT: 'production' } as Env,
		ownerSession,
	)

	for (let attempt = 0; attempt < 4; attempt += 1) {
		expect([attempt, (await release('old@example.com')).status]).toEqual([
			attempt,
			502,
		])
	}
	expect(consoleError).toHaveBeenCalled()
})
