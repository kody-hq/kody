import { setAuthSessionSecret } from '#app/auth-session.ts'
import { setOauthPendingSignupSecret } from '#app/oauth-pending-signup.ts'
import { emptyPublicFormProtection } from '#universal/public-form-protection.ts'
import { adminCreateUserWithPasswordSetup } from '#worker/identity/admin-user-creation.ts'
import { checkUsernameAvailability } from '#worker/identity/username-availability.ts'
import * as JobManager from '#worker/jobs/manager-client.ts'
import {
	restoreOrg,
	restoreUserAccount,
	softDeleteUserAccount,
} from '#worker/orgs/soft-delete.ts'
import {
	createAppEnv,
	createMigratedDb,
	getCookiePair,
	runHandler,
	seedUser,
	startProviderFlow,
	testCookieSecret,
} from '#worker/test-support/auth-provider-harness.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { HttpResponse, http } from 'msw'
import { type DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'

vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserCreatedEvent: vi.fn(),
	scheduleUserDeletedEvent: vi.fn(),
}))

vi.mock('#worker/jobs/jobs-data.ts', () => ({
	jobsData: () => ({
		softDeleteJobsForUser: vi.fn(async () => 0),
		restoreJobsForUser: vi.fn(async () => 0),
	}),
	jobsService: () => null,
}))

vi.spyOn(JobManager, 'syncJobManagerAlarm').mockResolvedValue({
	ok: true,
	userId: ownerIdFromStored('mock'),
	nextRunAt: null,
})

const { createAuthHandler } = await import('#app/handlers/auth.ts')
const { createAuthProviderCallbackHandler } =
	await import('#app/handlers/auth-provider.ts')
const { completeOauthPendingSignup, loadOauthPendingSignupPage } =
	await import('#worker/identity/oauth-pending-signup-operations.ts')
const { requestWebsitePasswordReset } =
	await import('#worker/identity/password-reset-operations.ts')
const { runWithDeferredWork } = await import('#worker/deferred-work.ts')
const { verifyEmailClaimReleaseToken } =
	await import('#app/email-claim-release.ts')
const { hashVerificationToken } = await import('#app/email-verification.ts')

const msw = createMswNodeServer()
const email = 'returning@example.com'
const handle = 'returning-person'
const googleSub = 'google-sub-returning'
const deletedAt = new Date('2026-10-01T12:00:00.000Z')

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
	setOauthPendingSignupSecret(testCookieSecret)
})

afterEach(() => {
	msw.resetHandlers()
})

afterAll(() => {
	msw.close()
})

function count(sqlite: DatabaseSync, sql: string, ...params: Array<string>) {
	return (sqlite.prepare(sql).get(...params) as { count: number }).count
}

/** A Google signup that the person deleted, as soft delete leaves it. */
async function seedDeletedGoogleAccount() {
	const { sqlite, db } = createMigratedDb()
	const env = createAppEnv(db, {
		AUDIT_DB: createAuditTestDb(),
		USER_METER: createInMemoryUserMeterEnv().env.USER_METER,
	})
	const stableUserId = testStableUserIdFromEmail(email)
	await seedUser(sqlite, {
		id: 7,
		email,
		username: handle,
		stableUserId,
		emailVerified: true,
	})
	sqlite.exec(`
		INSERT INTO user_email_claims (user_id, email, status)
		VALUES (7, '${email}', 'claimed');
		INSERT INTO oauth_connections (provider_name, provider_id, user_id)
		VALUES ('google', '${googleSub}', 7);
	`)
	await softDeleteUserAccount({
		env,
		userId: ownerIdFromStored(stableUserId),
		now: deletedAt,
	})
	expect(
		count(
			sqlite,
			`SELECT COUNT(*) AS count FROM users WHERE deleted_at IS NOT NULL`,
		),
	).toBe(1)
	return { sqlite, db, env, stableUserId }
}

function liveAccount(sqlite: DatabaseSync) {
	return sqlite
		.prepare(
			`SELECT id, email, username, stable_user_id, personal_org_id
			 FROM users WHERE email = ? AND deleted_at IS NULL`,
		)
		.get(email) as
		| {
				id: number
				email: string
				username: string
				stable_user_id: string
				personal_org_id: string
		  }
		| undefined
}

function expectSupersededTombstone(sqlite: DatabaseSync, stableUserId: string) {
	const tombstone = sqlite
		.prepare(
			`SELECT email, username, deleted_at FROM users WHERE stable_user_id = ?`,
		)
		.get(stableUserId) as {
		email: string
		username: string
		deleted_at: string
	}
	expect(tombstone.deleted_at).toBe(deletedAt.toISOString())
	expect(tombstone.email).not.toBe(email)
	expect(tombstone.username).not.toBe(handle)
	expect([
		count(
			sqlite,
			`SELECT COUNT(*) AS count FROM user_email_claims WHERE user_id = 7 AND status = 'claimed'`,
		),
		count(
			sqlite,
			`SELECT COUNT(*) AS count FROM oauth_connections WHERE user_id = 7`,
		),
		count(
			sqlite,
			`SELECT COUNT(*) AS count FROM handles WHERE user_id = ?`,
			stableUserId,
		),
	]).toEqual([0, 0, 0])
}

function expectFreshAccountOwnsHandle(
	sqlite: DatabaseSync,
	stableUserId: string,
) {
	const fresh = liveAccount(sqlite)
	expect(fresh).toMatchObject({ email, username: handle })
	expect(fresh?.stable_user_id).not.toBe(stableUserId)
	expect(fresh?.personal_org_id).not.toBe(stableUserId)
	const handleRow = sqlite
		.prepare(`SELECT user_id FROM handles WHERE handle = ?`)
		.get(handle) as { user_id: string }
	expect(handleRow.user_id).toBe(fresh?.stable_user_id)
	expectSupersededTombstone(sqlite, stableUserId)
}

async function passwordSignup(
	db: D1Database,
	body: { email: string; username: string },
) {
	const handler = createAuthHandler(
		createAppEnv(db) as unknown as Parameters<typeof createAuthHandler>[0],
	)
	return handler({
		request: new Request('http://example.com/auth', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				...body,
				password: 'password123',
				mode: 'signup',
			}),
		}),
	})
}

function mockGoogleUserinfo() {
	msw.use(
		http.post('https://oauth2.googleapis.com/token', () =>
			HttpResponse.json({ access_token: 'google-access-token' }),
		),
		http.get('https://openidconnect.googleapis.com/v1/userinfo', () =>
			HttpResponse.json({
				sub: googleSub,
				email,
				email_verified: true,
				name: 'Returning Person',
			}),
		),
	)
}

test('google sign-in after deleting the account starts a fresh account that reclaims the handle', async () => {
	const { sqlite, env, stableUserId } = await seedDeletedGoogleAccount()
	mockGoogleUserinfo()

	const start = await startProviderFlow(
		env,
		'google',
		'http://example.com/auth/google',
	)
	const callback = await runHandler(
		createAuthProviderCallbackHandler(env),
		new Request(
			`http://example.com/auth/google/callback?code=google-auth-code&state=${start.state}`,
			{ headers: { Cookie: start.stateCookie } },
		),
		{ provider: 'google' },
	)
	expect(callback.status).toBe(302)
	expect(callback.headers.get('Location')).toBe('/signup/choose-username')

	const pendingCookie =
		callback.headers
			.getSetCookie()
			.map(getCookiePair)
			.find((cookie) => cookie.startsWith('kody_oauth_pending=')) ?? ''
	const loaded = await loadOauthPendingSignupPage({
		env,
		request: new Request('http://example.com/signup/choose-username', {
			headers: { Cookie: pendingCookie },
		}),
	})
	if (!loaded.ok) throw new Error('expected pending signup')
	expect(loaded.suggestedUsername).toBe(handle)

	const completed = await completeOauthPendingSignup({
		env,
		request: new Request('http://example.com/signup/choose-username', {
			method: 'POST',
			headers: { Cookie: pendingCookie },
		}),
		body: { username: handle, csrf: loaded.csrf },
	})
	expect(completed.status).toBe(200)
	expect(completed.data).toMatchObject({ ok: true })
	expectFreshAccountOwnsHandle(sqlite, stableUserId)
	const freshId = liveAccount(sqlite)?.id
	expect(
		count(
			sqlite,
			`SELECT COUNT(*) AS count FROM oauth_connections WHERE provider_id = '${googleSub}' AND user_id = ${freshId}`,
		),
	).toBe(1)

	await expect(
		restoreUserAccount({
			env,
			userId: ownerIdFromStored(stableUserId),
			now: deletedAt,
		}),
	).rejects.toThrow('user_superseded_by_new_signup')
	const deletedOrgId = (
		sqlite
			.prepare(`SELECT personal_org_id FROM users WHERE stable_user_id = ?`)
			.get(stableUserId) as { personal_org_id: string | null }
	).personal_org_id
	if (deletedOrgId) {
		await expect(
			restoreOrg({ env, orgId: deletedOrgId as never, now: deletedAt }),
		).rejects.toThrow('org_superseded_by_new_signup')
	}
})

test('password signup mails a release link before superseding a deleted account', async () => {
	const { sqlite, db, stableUserId } = await seedDeletedGoogleAccount()
	consoleWarn.mockImplementation(() => {})

	const first = await passwordSignup(db, { email, username: handle })
	expect(first.status).toBe(200)
	expect(consoleWarn).toHaveBeenCalledWith(
		'email-claim-release-send-skipped',
		7,
	)
	expect(liveAccount(sqlite)).toBeUndefined()
	expect(
		sqlite
			.prepare(`SELECT email, username FROM users WHERE stable_user_id = ?`)
			.get(stableUserId),
	).toEqual({ email, username: handle })

	const releaseToken = 'deleted-account-release-token'
	const pending = sqlite
		.prepare(
			`UPDATE pending_email_claim_releases SET token_hash = ?
			 WHERE user_id = 7 AND email = ?`,
		)
		.run(await hashVerificationToken(releaseToken), email)
	expect(pending.changes).toBe(1)

	const released = await verifyEmailClaimReleaseToken({
		db,
		token: releaseToken,
	})
	expect(released).toMatchObject({ ok: true, supersededDeletedAccount: true })

	const second = await passwordSignup(db, { email, username: handle })
	expect(second.status).toBe(200)
	expectFreshAccountOwnsHandle(sqlite, stableUserId)
})

test('a deleted account keeps its handle reserved until its address is proven', async () => {
	const { sqlite, db, stableUserId } = await seedDeletedGoogleAccount()

	const availability = await checkUsernameAvailability({
		db,
		username: handle,
	})
	expect(availability.status).toBe('taken')

	const response = await passwordSignup(db, {
		email: 'someone-else@example.com',
		username: handle,
	})
	expect(response.status).toBe(409)
	expect(
		sqlite
			.prepare(`SELECT email, username FROM users WHERE stable_user_id = ?`)
			.get(stableUserId),
	).toEqual({ email, username: handle })
})

test('admin create with the deleted account email and handle succeeds', async () => {
	const { sqlite, db, stableUserId } = await seedDeletedGoogleAccount()

	const created = await adminCreateUserWithPasswordSetup({
		db,
		email,
		username: handle,
		setupLinkOrigin: 'https://kody.example/admin/users',
		allowExampleDomain: true,
	})
	expect(created).toMatchObject({ email, username: handle })
	expectFreshAccountOwnsHandle(sqlite, stableUserId)
})

test('password reset for a soft-deleted account mails the release link, not a reset token', async () => {
	const { sqlite, env } = await seedDeletedGoogleAccount()
	consoleWarn.mockImplementation(() => {})
	const url = new URL('http://example.com/reset-password')
	const deferred: Array<Promise<unknown>> = []
	const response = await runWithDeferredWork(
		(promise) => deferred.push(promise),
		() =>
			requestWebsitePasswordReset({
				env,
				request: new Request(url, { method: 'POST' }),
				url,
				body: { email, ...emptyPublicFormProtection() },
			}),
	)
	await Promise.all(deferred)
	expect(response.status).toBe(200)
	expect(count(sqlite, `SELECT COUNT(*) AS count FROM password_resets`)).toBe(0)
	expect(
		count(
			sqlite,
			`SELECT COUNT(*) AS count FROM pending_email_claim_releases WHERE user_id = 7 AND email = ?`,
			email,
		),
	).toBe(1)
	expect(consoleWarn).toHaveBeenCalledWith(
		'email-claim-release-send-skipped',
		7,
	)
})

test('repeated password signups for a deleted address send one release mail per window', async () => {
	const { sqlite, db } = await seedDeletedGoogleAccount()
	consoleWarn.mockImplementation(() => {})

	expect(
		(await passwordSignup(db, { email, username: 'first-try' })).status,
	).toBe(200)
	expect(
		(await passwordSignup(db, { email, username: 'second-try' })).status,
	).toBe(200)
	expect(
		count(
			sqlite,
			`SELECT COUNT(*) AS count FROM pending_email_claim_releases WHERE user_id = 7`,
		),
	).toBe(1)
	expect(
		consoleWarn.mock.calls.filter(
			([label]) => label === 'email-claim-release-send-skipped',
		),
	).toHaveLength(1)
})

test('a release link for another address never supersedes a deleted account', async () => {
	const { sqlite, db, stableUserId } = await seedDeletedGoogleAccount()
	const releaseToken = 'former-address-release-token'
	sqlite
		.prepare(
			`INSERT INTO pending_email_claim_releases (user_id, email, token_hash, expires_at)
			 VALUES (7, 'former-address@example.com', ?, ?)`,
		)
		.run(await hashVerificationToken(releaseToken), Date.now() + 60_000)

	const result = await verifyEmailClaimReleaseToken({
		db,
		token: releaseToken,
	})
	expect(result).toMatchObject({ ok: false })
	expect(
		sqlite
			.prepare(`SELECT email, username FROM users WHERE stable_user_id = ?`)
			.get(stableUserId),
	).toEqual({ email, username: handle })
})

test('a stale deleted-account release link is replaced on the next request', async () => {
	const { sqlite, db } = await seedDeletedGoogleAccount()
	consoleWarn.mockImplementation(() => {})

	expect(
		(await passwordSignup(db, { email, username: 'first-try' })).status,
	).toBe(200)
	sqlite.exec(
		`UPDATE pending_email_claim_releases SET created_at = datetime('now', '-1 day') WHERE user_id = 7`,
	)
	expect(
		(await passwordSignup(db, { email, username: 'second-try' })).status,
	).toBe(200)
	expect(
		count(
			sqlite,
			`SELECT COUNT(*) AS count FROM pending_email_claim_releases WHERE user_id = 7 AND created_at > datetime('now', '-1 hour')`,
		),
	).toBe(1)
	expect(
		consoleWarn.mock.calls.filter(
			([label]) => label === 'email-claim-release-send-skipped',
		),
	).toHaveLength(2)
})
