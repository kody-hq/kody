import { setAuthSessionSecret } from '#app/auth-session.ts'
import { setOauthPendingSignupSecret } from '#app/oauth-pending-signup.ts'
import { rewardReferralForPaidInvoice } from '#worker/entitlements/referral-program.ts'
import {
	createAppEnv,
	createMigratedDb,
	runHandler,
	seedUser,
	startProviderFlow,
	testCookieSecret,
} from '#worker/test-support/auth-provider-harness.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { HttpResponse, http } from 'msw'
import type { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'

vi.mock('#app/founder-welcome-email.ts', () => ({
	scheduleFounderWelcomeEmail: vi.fn(),
}))

const { createAuthProviderCallbackHandler } =
	await import('#app/handlers/auth-provider.ts')

const msw = createMswNodeServer()

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

// Linking a provider to an unverified account revokes its OAuth grants first.
function createEnv(db: D1Database) {
	return createAppEnv(db, {
		OAUTH_PROVIDER: {
			listUserGrants: async () => ({ items: [] }),
			revokeGrant: async () => {},
		},
	})
}

async function signInWithGoogle(env: Env, email: string) {
	msw.use(
		http.post('https://oauth2.googleapis.com/token', () =>
			HttpResponse.json({ access_token: 'google-access-token' }),
		),
		http.get('https://openidconnect.googleapis.com/v1/userinfo', () =>
			HttpResponse.json({
				email_verified: true,
				sub: `google-${email}`,
				email,
				name: email,
			}),
		),
	)
	const start = await startProviderFlow(
		env,
		'google',
		'http://example.com/auth/google',
	)
	const response = await runHandler(
		createAuthProviderCallbackHandler(env),
		new Request(
			`http://example.com/auth/google/callback?code=google-auth-code&state=${start.state}`,
			{ headers: { Cookie: start.stateCookie } },
		),
		{ provider: 'google' },
	)
	expect(response.status).toBe(302)
	expect(response.headers.get('Location')).toBe('/account')
}

async function seedPerson(
	sqlite: DatabaseSync,
	id: number,
	username: string,
	emailVerified: boolean,
) {
	const email = `${username}@example.com`
	await seedUser(sqlite, { id, email, username, emailVerified })
	return { email, stableUserId: testStableUserIdFromEmail(email) }
}

function seedTeamOrg(sqlite: DatabaseSync, slug: string, ownerId: string) {
	const orgId = `org-${slug}`
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
			 VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
		)
		.run(orgId, slug, slug)
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', CURRENT_TIMESTAMP)`,
		)
		.run(orgId, ownerId)
	return orgId
}

async function holdReferral(
	db: D1Database,
	sqlite: DatabaseSync,
	input: { referrerOrgId: string; refereeStableUserId: string },
) {
	sqlite
		.prepare(
			`INSERT INTO referrals (referrer_org_id, referee_stable_user_id, created_at)
			 VALUES (?, ?, CURRENT_TIMESTAMP)`,
		)
		.run(input.referrerOrgId, input.refereeStableUserId)
	await expect(
		rewardReferralForPaidInvoice({
			db,
			refereeStableUserId: input.refereeStableUserId,
			invoiceId: 'in_held',
			invoiceQualifies: true,
		}),
	).resolves.toEqual({ outcome: 'held_unverified' })
}

function referral(sqlite: DatabaseSync, refereeStableUserId: string) {
	return sqlite
		.prepare(
			`SELECT status, reward_invoice_id, held_invoice_id, credits_granted_at
			 FROM referrals WHERE referee_stable_user_id = ?`,
		)
		.get(refereeStableUserId)
}

function creditExpiry(sqlite: DatabaseSync, orgId: string) {
	const row = sqlite
		.prepare(
			`SELECT referral_standard_credit_expires_at AS expires FROM orgs WHERE id = ?`,
		)
		.get(orgId) as { expires: string | null }
	return row.expires
}

const rewarded = {
	status: 'rewarded',
	reward_invoice_id: 'in_held',
	held_invoice_id: null,
	credits_granted_at: expect.any(String),
}

test('a referee verifying with social sign-in releases a held personal referral', async () => {
	const { sqlite, db } = createMigratedDb()
	const env = createEnv(db)
	const referrer = await seedPerson(sqlite, 1, 'referrer', true)
	const referee = await seedPerson(sqlite, 2, 'referee', false)
	await holdReferral(db, sqlite, {
		referrerOrgId: referrer.stableUserId,
		refereeStableUserId: referee.stableUserId,
	})

	await signInWithGoogle(env, referee.email)

	expect(referral(sqlite, referee.stableUserId)).toEqual(rewarded)
	expect(creditExpiry(sqlite, referrer.stableUserId)).toBeTruthy()
	expect(creditExpiry(sqlite, referee.stableUserId)).toBeTruthy()

	// A repeat sign-in has nothing left to grant and stacks no extra month.
	const before = creditExpiry(sqlite, referee.stableUserId)
	await signInWithGoogle(env, referee.email)
	expect(creditExpiry(sqlite, referee.stableUserId)).toBe(before)
})

test('a referee verifying with social sign-in releases a held org referral', async () => {
	const { sqlite, db } = createMigratedDb()
	const env = createEnv(db)
	const owner = await seedPerson(sqlite, 1, 'owner', true)
	const orgId = seedTeamOrg(sqlite, 'acme', owner.stableUserId)
	const referee = await seedPerson(sqlite, 2, 'referee', false)
	await holdReferral(db, sqlite, {
		referrerOrgId: orgId,
		refereeStableUserId: referee.stableUserId,
	})

	await signInWithGoogle(env, referee.email)

	expect(referral(sqlite, referee.stableUserId)).toEqual(rewarded)
	expect(creditExpiry(sqlite, orgId)).toBeTruthy()
	expect(creditExpiry(sqlite, owner.stableUserId)).toBeNull()
	expect(creditExpiry(sqlite, referee.stableUserId)).toBeTruthy()
})

test('an org owner verifying with social sign-in releases a referral held on the verified-owner gate', async () => {
	const { sqlite, db } = createMigratedDb()
	const env = createEnv(db)
	const owner = await seedPerson(sqlite, 1, 'owner', false)
	const orgId = seedTeamOrg(sqlite, 'acme', owner.stableUserId)
	const referee = await seedPerson(sqlite, 2, 'referee', true)
	await holdReferral(db, sqlite, {
		referrerOrgId: orgId,
		refereeStableUserId: referee.stableUserId,
	})

	await signInWithGoogle(env, owner.email)

	expect(referral(sqlite, referee.stableUserId)).toEqual(rewarded)
	expect(creditExpiry(sqlite, orgId)).toBeTruthy()
	expect(creditExpiry(sqlite, referee.stableUserId)).toBeTruthy()
})
