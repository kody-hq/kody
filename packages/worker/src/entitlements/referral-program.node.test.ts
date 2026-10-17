import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { ensureReferralProgramTestSchema } from './test-schema.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	resolveUserEntitlementFromRow,
	userEntitlementColumnsSql,
	type UserEntitlementRow,
} from './service.ts'
import {
	attributeReferralAtSignup,
	isQualifyingPaidReferralInvoice,
	loadReferralProgramSummary,
	readStripeInvoicePeriodEndIso,
	maybeRewardHeldReferralAfterEmailVerified,
	rewardReferralForPaidInvoice,
} from './referral-program.ts'

const now = new Date('2026-09-07T12:00:00.000Z')
const firstCreditExpiresAt = '2026-10-07T12:00:00.000Z'
const secondCreditExpiresAt = '2026-11-06T12:00:00.000Z'

async function ensureReferralSchema(db: D1Database) {
	await ensureUsersTestSchema({
		db,
		columns: ['email_verified_at'],
	})
	await ensureReferralProgramTestSchema(db)
}

async function createDb() {
	const db = createD1FromSqlite(new DatabaseSync(':memory:'))
	await ensureReferralSchema(db)
	return db
}

type TestUser = { email: string; username: string; stableUserId: string }

async function insertUser(
	db: D1Database,
	username: string,
	input: { email?: string; verified?: boolean } = {},
): Promise<TestUser> {
	const email = input.email ?? `${username}@example.com`
	const stableUserId = testStableUserIdFromEmail(email)
	await db
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id,
				email_verified_at
			) VALUES (?, ?, 'hash', ?, ?)`,
		)
		.bind(
			username,
			email,
			stableUserId,
			input.verified === false ? null : now.toISOString(),
		)
		.run()
	await provisionPersonalOrg(db, {
		stableUserId,
		username,
		plan: 'free',
		createdAt: now.toISOString(),
	})
	return { email, username, stableUserId }
}

async function creditExpiry(db: D1Database, user: TestUser) {
	const row = await db
		.prepare(
			`SELECT referral_standard_credit_expires_at
			 FROM orgs WHERE id = ?`,
		)
		.bind(user.stableUserId)
		.first<{ referral_standard_credit_expires_at: string | null }>()
	return row?.referral_standard_credit_expires_at ?? null
}

/** Entitlement at the test's frozen `now` (not wall clock). */
async function entitlementAt(db: D1Database, user: TestUser) {
	const row = await db
		.prepare(
			`SELECT ${userEntitlementColumnsSql()}
			 FROM orgs WHERE id = ?`,
		)
		.bind(user.stableUserId)
		.first<UserEntitlementRow>()
	if (!row) throw new Error(`Missing user ${user.stableUserId}`)
	return resolveUserEntitlementFromRow({
		db,
		stableUserId: user.stableUserId,
		row,
		now,
	})
}

function referralRow(db: D1Database, referee: TestUser) {
	return db
		.prepare(`SELECT * FROM referrals WHERE referee_stable_user_id = ?`)
		.bind(referee.stableUserId)
		.first()
}

function attribute(db: D1Database, referee: TestUser, referralCode: string) {
	return attributeReferralAtSignup({
		db,
		refereeStableUserId: referee.stableUserId,
		refereeUsername: referee.username,
		referralCode,
		now,
	})
}

function reward(
	db: D1Database,
	referee: TestUser,
	invoiceId: string,
	invoiceQualifies = true,
) {
	return rewardReferralForPaidInvoice({
		db,
		refereeStableUserId: referee.stableUserId,
		invoiceId,
		invoiceQualifies,
		now,
	})
}

async function verifyEmail(db: D1Database, user: TestUser) {
	await db
		.prepare(`UPDATE users SET email_verified_at = ? WHERE stable_user_id = ?`)
		.bind(now.toISOString(), user.stableUserId)
		.run()
}

test('referral rewards both parties once on first paid invoice, skips trial, rejects fraud, and stacks without a cap', async ({
	onTestFinished,
}) => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(now)
	onTestFinished(() => {
		vi.useRealTimers()
	})
	const db = await createDb()
	const referrer = await insertUser(db, 'referrer')
	const referee = await insertUser(db, 'referee')
	const unpaid = await insertUser(db, 'unpaid')
	const plusTag = await insertUser(db, 'plustag', {
		email: 'referrer+alt@example.com',
	})
	const self = await insertUser(db, 'selfuser')
	const unverified = await insertUser(db, 'unverified', { verified: false })
	const ghost = {
		email: 'ghost@example.com',
		username: 'ghost',
		stableUserId: testStableUserIdFromEmail('ghost@example.com'),
	}

	const attributions: Array<[TestUser, string, unknown]> = [
		[referee, 'referrer', { outcome: 'attributed' }],
		[referee, 'referrer', { outcome: 'already_attributed' }],
		[unpaid, 'referrer', { outcome: 'attributed' }],
		[plusTag, 'referrer', { outcome: 'attributed' }],
		[self, 'selfuser', { outcome: 'ignored', reason: 'self' }],
		[unverified, 'referrer', { outcome: 'attributed' }],
		[ghost, 'nobody', { outcome: 'ignored', reason: 'unknown_referrer' }],
	]
	const attributed = []
	for (const [user, code] of attributions) {
		attributed.push(await attribute(db, user, code))
	}
	expect(attributed).toEqual(attributions.map(([, , want]) => want))

	const invoices: Array<
		[Parameters<typeof isQualifyingPaidReferralInvoice>[0], boolean]
	> = [
		[
			{
				status: 'paid',
				amount_paid: 0,
				billing_reason: 'subscription_create',
				subscription: 'sub_trial',
			},
			false,
		],
		[
			{
				status: 'paid',
				amount_paid: 1200,
				billing_reason: 'subscription_create',
				subscription: 'sub_paid',
			},
			true,
		],
		[
			{
				status: 'paid',
				amount_paid: 250,
				billing_reason: 'manual',
				metadata: { kody_compute_overage: '1' },
			},
			false,
		],
	]
	expect(
		invoices.map(([invoice]) => isQualifyingPaidReferralInvoice(invoice)),
	).toEqual(invoices.map(([, want]) => want))
	expect(
		readStripeInvoicePeriodEndIso({
			lines: {
				data: [
					{ period: { end: 1_778_000_000 } },
					{ period: { end: 1_780_588_800 } },
				],
			},
		}),
	).toBe('2026-06-04T16:00:00.000Z')

	expect(await reward(db, unpaid, 'in_trial', false)).toEqual({
		outcome: 'ignored',
		reason: 'invoice_unqualified',
	})
	expect(await referralRow(db, unpaid)).toMatchObject({
		status: 'pending',
		reward_invoice_id: null,
	})

	expect(await reward(db, referee, 'in_first')).toEqual({ outcome: 'rewarded' })
	for (const user of [referrer, referee]) {
		expect(await creditExpiry(db, user)).toBe(firstCreditExpiresAt)
		expect(await entitlementAt(db, user)).toEqual({
			plan: 'pro',
			ladder: 'public',
			creditWallet: 'none',
			seats: 1,
			limitOverrides: [],
		})
	}
	expect(await referralRow(db, referee)).toMatchObject({
		status: 'rewarded',
		reward_invoice_id: 'in_first',
	})

	expect(await reward(db, referee, 'in_second_cycle')).toEqual({
		outcome: 'already_rewarded',
	})
	expect(await creditExpiry(db, referrer)).toBe(firstCreditExpiresAt)
	expect(await creditExpiry(db, referee)).toBe(firstCreditExpiresAt)

	const secondReferee = await insertUser(db, 'refereetwo')
	expect(await attribute(db, secondReferee, 'referrer')).toEqual({
		outcome: 'attributed',
	})
	expect(await reward(db, secondReferee, 'in_second_friend')).toEqual({
		outcome: 'rewarded',
	})
	expect(await creditExpiry(db, referrer)).toBe(secondCreditExpiresAt)
	expect(await creditExpiry(db, secondReferee)).toBe(firstCreditExpiresAt)

	expect(await reward(db, plusTag, 'in_plus')).toEqual({
		outcome: 'rejected',
		reason: 'same_email',
	})
	expect(await referralRow(db, plusTag)).toMatchObject({
		status: 'rejected',
		reject_reason: 'same_email',
	})
	expect(await creditExpiry(db, plusTag)).toBeNull()

	expect(await reward(db, unverified, 'in_held')).toEqual({
		outcome: 'held_unverified',
	})
	expect(await referralRow(db, unverified)).toMatchObject({
		status: 'pending',
		held_invoice_id: 'in_held',
	})
	expect(await creditExpiry(db, unverified)).toBeNull()

	await verifyEmail(db, unverified)
	expect(
		await maybeRewardHeldReferralAfterEmailVerified({
			db,
			stableUserId: unverified.stableUserId,
			now,
		}),
	).toEqual({ outcome: 'rewarded' })
	expect(await creditExpiry(db, unverified)).toBe(firstCreditExpiresAt)
	expect(await referralRow(db, unverified)).toMatchObject({
		status: 'rewarded',
		reward_invoice_id: 'in_held',
	})
})

test('held rewards release for every pending referee when the referrer verifies', async () => {
	const db = await createDb()
	const referrer = await insertUser(db, 'heldreferrer', { verified: false })
	const referees = [
		[await insertUser(db, 'heldone'), 'in_held_one'],
		[await insertUser(db, 'heldtwo'), 'in_held_two'],
	] as const
	for (const [referee, invoiceId] of referees) {
		await attribute(db, referee, 'heldreferrer')
		expect(await reward(db, referee, invoiceId)).toEqual({
			outcome: 'held_unverified',
		})
	}

	await verifyEmail(db, referrer)
	expect(
		await maybeRewardHeldReferralAfterEmailVerified({
			db,
			stableUserId: referrer.stableUserId,
			now,
		}),
	).toEqual({ outcome: 'rewarded' })
	for (const [referee, invoiceId] of referees) {
		expect(await referralRow(db, referee)).toMatchObject({
			status: 'rewarded',
			reward_invoice_id: invoiceId,
		})
	}
	expect(await creditExpiry(db, referrer)).toBe(secondCreditExpiresAt)
})

test('held rewards stay pending when the referrer period resolver fails', async () => {
	const db = await createDb()
	const referrer = await insertUser(db, 'heldfailref', { verified: false })
	const referee = await insertUser(db, 'heldfailree')
	await attribute(db, referee, 'heldfailref')
	expect(await reward(db, referee, 'in_held_fail')).toEqual({
		outcome: 'held_unverified',
	})
	await verifyEmail(db, referrer)
	consoleWarn.mockImplementation(() => {})
	expect(
		await maybeRewardHeldReferralAfterEmailVerified({
			db,
			stableUserId: referrer.stableUserId,
			resolveReferrerPaidPeriodEnd: async () => {
				throw new Error('stripe down')
			},
			now,
		}),
	).toEqual({ outcome: 'ignored', reason: 'no_pending' })
	expect(consoleWarn).toHaveBeenCalledWith(
		'referral-held-referrer-period-end-failed',
		expect.any(Error),
	)
	expect(await referralRow(db, referee)).toMatchObject({
		status: 'pending',
		held_invoice_id: 'in_held_fail',
		credits_granted_at: null,
	})
	expect(await creditExpiry(db, referrer)).toBeNull()
})

test('referral billing summary counts every row, not only the displayed page', async () => {
	const db = await createDb()
	const referrer = await insertUser(db, 'countreferrer')
	for (let index = 0; index < 52; index += 1) {
		const referee = await insertUser(db, `countref${index}`)
		await db
			.prepare(
				`INSERT INTO referrals (
					referrer_stable_user_id, referee_stable_user_id, created_at, status
				) VALUES (?, ?, ?, ?)`,
			)
			.bind(
				referrer.stableUserId,
				referee.stableUserId,
				now.toISOString(),
				index < 3 ? 'rewarded' : 'pending',
			)
			.run()
	}
	const summary = await loadReferralProgramSummary({
		db,
		stableUserId: referrer.stableUserId,
		username: 'countreferrer',
		origin: 'https://kody.codes',
		now,
	})
	expect(summary.rewardedCount).toBe(3)
	expect(summary.pendingCount).toBe(49)
	expect(summary.referrals).toHaveLength(50)
})
