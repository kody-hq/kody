import {
	createAuthCookie,
	readParsedAuthSession,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { isCredentialInvalidatedByStoredPasswordChange } from '#worker/password-change-lockout.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { provisionPersonalOrgForSqliteUser } from '#worker/test-support/personal-org-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	createPasswordHash,
	verifyPassword,
} from '@kody-internal/shared/password-hash.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, expect, test, vi } from 'vitest'
import { testAccountPasswordHandler } from './account-password.test-support.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
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
		password?: string
		passwordHash?: string
	},
) {
	const passwordHash =
		input.passwordHash ?? (await createPasswordHash(input.password ?? ''))
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

function createTrackingGrantHelpers() {
	const revokedGrantIds = new Array<string>()
	return {
		revokedGrantIds,
		helpers: {
			listUserGrants: vi.fn(async () => ({
				items: revokedGrantIds.includes('grant-1')
					? []
					: [{ id: 'grant-1', clientId: 'client-a' }],
			})),
			revokeGrant: vi.fn(async (grantId: string) => {
				revokedGrantIds.push(grantId)
			}),
		},
	}
}

function createAppEnv(db: D1Database, overrides: Record<string, unknown> = {}) {
	return {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
		...overrides,
	} as unknown as Env
}
function createPasswordClient(db: D1Database, session: AuthSession) {
	const { helpers, revokedGrantIds } = createTrackingGrantHelpers()
	const { execute } = testAccountPasswordHandler(
		createAppEnv(db, { OAUTH_PROVIDER: helpers }),
	)
	const post = async (body: unknown, signedIn = true) => {
		const cookie = await createAuthCookie(session, false)
		const request = new Request('http://example.com/account/password.json', {
			method: 'POST',
			headers: {
				...(signedIn ? { Cookie: cookie } : {}),
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		})
		const response = await execute({
			request,
			url: new URL(request.url),
			params: {},
		} as never)
		return { cookie, response }
	}
	return { post, revokedGrantIds }
}

const readSession = (cookie: string) =>
	readParsedAuthSession(
		new Request('http://example.com/account', { headers: { Cookie: cookie } }),
	)

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

test('signed-in password change requires the current password, revokes MCP grants, and keeps this session', async () => {
	const { sqlite, db } = createMigratedDb()
	const email = 'ada@example.com'
	await seedUser(sqlite, {
		id: 1,
		email,
		username: 'ada',
		password: 'correct-password',
	})
	sqlite.exec(`
		INSERT INTO password_resets (user_id, token_hash, expires_at)
		VALUES (1, 'pending-reset', ${Date.now() + 60_000});
		INSERT INTO verifications (
			type, target, secret, algorithm, digits, period, char_set
		) VALUES ('2fa', '1', 'KEEPSECRET', 'SHA-1', 6, 30, '0123456789');
		INSERT INTO passkeys (
			id, aaguid, public_key, user_id, webauthn_user_handle, counter,
			device_type, backed_up, transports, name
		) VALUES (
			'keep-passkey', '00000000-0000-0000-0000-000000000000', 'cHVibGlj',
			1, 'd2ViYXV0aG4tdXNlcg', 0, 'multiDevice', 1, 'internal', 'laptop'
		);
		INSERT INTO oauth_connections (provider_name, provider_id, user_id, provider_display_name)
		VALUES ('github', 'keep-github', 1, 'ada');
	`)
	const { post, revokedGrantIds } = createPasswordClient(db, {
		stableUserId: testStableUserIdFromEmail(email),
		email,
		rememberMe: true,
	})
	const change = {
		currentPassword: 'correct-password',
		newPassword: 'brand-new-password',
	}

	const unauthenticated = await post(change, false)
	expect(unauthenticated.response.status).toBe(401)

	const rejections = [
		[
			{ ...change, currentPassword: 'wrong-password' },
			401,
			{
				ok: false,
				code: 'invalid_password',
				error: 'Current password is incorrect.',
			},
		],
		[
			{ ...change, newPassword: 'short' },
			400,
			expect.objectContaining({
				ok: false,
				error: 'Password must be at least 8 characters.',
			}),
		],
		[
			{ ...change, newPassword: 'correct-password' },
			400,
			{ ok: false, error: 'Choose a different password.' },
		],
	] as const
	for (const [body, status, want] of rejections) {
		const { response } = await post(body)
		expect([body, response.status, response.data]).toEqual([body, status, want])
	}

	const { cookie: oldCookie, response } = await post(change)
	const oldSession = await readSession(oldCookie)
	expect(response.status).toBe(200)
	expect(response.data).toMatchObject({
		ok: true,
		message: expect.stringContaining('Password updated.'),
	})
	expect(revokedGrantIds).toEqual(['grant-1'])
	const counts = [
		`password_resets`,
		`verifications WHERE target = '1'`,
		`passkeys WHERE user_id = 1`,
		`oauth_connections WHERE user_id = 1`,
	].map((from) => [
		from,
		sqlite.prepare(`SELECT COUNT(*) AS count FROM ${from}`).get(),
	])
	expect(counts).toEqual([
		[`password_resets`, { count: 0 }],
		[`verifications WHERE target = '1'`, { count: 1 }],
		[`passkeys WHERE user_id = 1`, { count: 1 }],
		[`oauth_connections WHERE user_id = 1`, { count: 1 }],
	])

	const row = sqlite
		.prepare(
			`SELECT password_hash, password_changed_at FROM users WHERE id = 1`,
		)
		.get() as { password_hash: string; password_changed_at: string }
	expect(await verifyPassword('brand-new-password', row.password_hash)).toBe(
		true,
	)
	expect(await verifyPassword('correct-password', row.password_hash)).toBe(
		false,
	)

	const setCookie = new Headers(response.headers).get('Set-Cookie')
	expect(setCookie).toContain('kody_session=')
	const newSession = await readSession(setCookie?.split(';', 1)[0] ?? '')
	expect(newSession?.session.rememberMe).toBe(true)
	expect(
		isCredentialInvalidatedByStoredPasswordChange({
			issuedAtMs: oldSession?.issuedAt,
			storedPasswordChangedAt: row.password_changed_at,
		}),
	).toBe(true)
	expect(
		isCredentialInvalidatedByStoredPasswordChange({
			issuedAtMs: newSession?.issuedAt,
			storedPasswordChangedAt: row.password_changed_at,
		}),
	).toBe(false)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'password_change',
			result: 'success',
		}),
	)
})

test('oauth-only accounts can set a first password without a current password', async () => {
	const { sqlite, db } = createMigratedDb()
	const email = 'oauth@example.com'
	await seedUser(sqlite, {
		id: 2,
		email,
		username: 'oauth-user',
		passwordHash: 'oauth_created_no_usable_password',
	})
	const { post } = createPasswordClient(db, {
		stableUserId: testStableUserIdFromEmail(email),
		email,
		rememberMe: false,
	})

	expect((await post({})).response.status).toBe(400)

	const { response } = await post({ newPassword: 'first-password-ok' })
	expect(response.status).toBe(200)
	const row = sqlite
		.prepare(`SELECT password_hash FROM users WHERE id = 2`)
		.get() as { password_hash: string }
	expect(await verifyPassword('first-password-ok', row.password_hash)).toBe(
		true,
	)
	expect(new Headers(response.headers).get('Set-Cookie')).toContain(
		'kody_session=',
	)
})
