import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { getUserEntitlement } from './service.ts'
import {
	evaluateSecondAgentStandardGift,
	maybeEvaluateSecondAgentStandardGift,
} from './second-agent-standard-gift.ts'

const secondAgentStandardGiftDurationMs = 14 * 24 * 60 * 60 * 1000
// Grant yesterday so the wall-clock entitlement read still sees an active gift.
// A fixed 2026-09-21 expiry goes stale the afternoon it lands.
const now = new Date(Date.now() - 24 * 60 * 60 * 1000)
const giftExpiresAt = new Date(
	now.getTime() + secondAgentStandardGiftDurationMs,
).toISOString()

async function createGiftTestDb(input: {
	email: string
	plan?: string
	stripePlan?: string | null
	stripeCustomerId?: string | null
}) {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureUsersTestSchema({
		db,
		columns: ['email_verified_at'],
	})
	const stableUserId = testStableUserIdFromEmail(input.email)
	const username = input.email.split('@')[0] ?? 'gift-user'
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			 VALUES (?, ?, 'hash', ?)`,
		)
		.bind(username, input.email, stableUserId)
		.run()
	await provisionPersonalOrg(db, {
		stableUserId,
		username,
		plan: input.plan ?? 'free',
		stripePlan: input.stripePlan ?? null,
		stripeCustomerId: input.stripeCustomerId ?? null,
		createdAt: now.toISOString(),
	})
	return { db, stableUserId, email: input.email }
}

type GiftUser = Awaited<ReturnType<typeof createGiftTestDb>>

function evaluate(user: GiftUser, ecosystemCount: number, at = now) {
	return evaluateSecondAgentStandardGift({
		db: user.db,
		stableUserId: user.stableUserId,
		ecosystemCount,
		now: at,
	})
}

function entitlementOf(user: GiftUser) {
	return getUserEntitlement(user.db, {
		userId: user.stableUserId,
		email: user.email,
	})
}

const activeGift = {
	received: true,
	active: true,
	status: 'active',
	grantedAt: now.toISOString(),
	expiresAt: giftExpiresAt,
}

const alreadyPaidGift = {
	received: true,
	active: false,
	status: 'already_paid',
	grantedAt: now.toISOString(),
	expiresAt: null,
}

test('first second-ecosystem grant gives 14-day Pro once; later events and manual grants do not', async () => {
	// Entitlement reads the wall clock, so pin it to the grant time or the
	// gift looks expired.
	vi.useFakeTimers({ now })
	try {
		const free = await createGiftTestDb({ email: 'free-gift@example.com' })
		expect(await evaluate(free, 1)).toEqual({ outcome: 'below_threshold' })
		expect(await entitlementOf(free)).toEqual({
			plan: 'free',
			ladder: 'public',
			creditWallet: 'none',
			seats: 1,
			limitOverrides: [],
		})
		expect(await evaluate(free, 2)).toEqual({
			outcome: 'granted',
			gift: activeGift,
		})
		expect(await entitlementOf(free)).toEqual({
			plan: 'pro',
			ladder: 'public',
			creditWallet: 'none',
			seats: 1,
			limitOverrides: [],
		})

		const second = await evaluate(
			free,
			3,
			new Date(now.getTime() + 24 * 60 * 60 * 1000),
		)
		expect(second.outcome).toBe('already_granted')
		if (second.outcome !== 'already_granted') {
			throw new Error('expected already_granted')
		}
		expect(second.gift.expiresAt).toBe(giftExpiresAt)
		expect(second.gift.grantedAt).toBe(now.toISOString())
		expect(
			await free.db
				.prepare(
					`SELECT second_agent_standard_gift_granted_at,
					        second_agent_standard_gift_expires_at
					 FROM orgs WHERE id = ?`,
				)
				.bind(free.stableUserId)
				.first(),
		).toEqual({
			second_agent_standard_gift_granted_at: now.toISOString(),
			second_agent_standard_gift_expires_at: giftExpiresAt,
		})

		const manual = await createGiftTestDb({
			email: 'manual-pro@example.com',
			plan: 'pro',
		})
		expect(await evaluate(manual, 2)).toEqual({
			outcome: 'granted',
			gift: alreadyPaidGift,
		})
		expect((await evaluate(manual, 4)).outcome).toBe('already_granted')
	} finally {
		vi.useRealTimers()
	}
})

test('paid Stripe Pro queues one invoice credit per account and keeps the paid plan', async () => {
	for (const stripePlan of ['standard', 'pro'] as const) {
		const paid = await createGiftTestDb({
			email: `paid-${stripePlan}@example.com`,
			stripePlan,
			stripeCustomerId: `cus_${stripePlan}`,
		})
		const invoiceCreditGift = {
			...alreadyPaidGift,
			status: 'invoice_credit',
		}
		expect(await evaluate(paid, 2)).toEqual({
			outcome: 'granted',
			gift: invoiceCreditGift,
		})
		expect((await entitlementOf(paid)).plan).toBe(stripePlan)
		const later = new Date(now.getTime() + 24 * 60 * 60 * 1000)
		expect(await evaluate(paid, 3, later)).toEqual({
			outcome: 'already_granted',
			gift: invoiceCreditGift,
		})
		expect(
			await paid.db
				.prepare(
					`SELECT second_agent_standard_gift_granted_at AS granted,
					        second_agent_standard_gift_expires_at AS expires,
					        second_agent_gift_invoice_credit_requested_at AS requested
					 FROM orgs WHERE id = ?`,
				)
				.bind(paid.stableUserId)
				.first(),
		).toEqual({
			granted: now.toISOString(),
			expires: null,
			requested: now.toISOString(),
		})
	}
})

test('maybeEvaluate skips writes without prepare and keeps an existing gift below two clients', async () => {
	const warn = vi.spyOn(console, 'warn')
	await expect(
		maybeEvaluateSecondAgentStandardGift({
			db: {} as D1Database,
			stableUserId: ownerIdFromStored('user-1'),
			ecosystemCount: 2,
		}),
	).resolves.toEqual({
		received: false,
		active: false,
		status: 'none',
		expiresAt: null,
		grantedAt: null,
	})
	expect(warn).not.toHaveBeenCalled()
	warn.mockRestore()

	const gifted = await createGiftTestDb({
		email: 'already-gifted@example.com',
	})
	await evaluate(gifted, 2)
	expect(
		await maybeEvaluateSecondAgentStandardGift({
			db: gifted.db,
			stableUserId: gifted.stableUserId,
			ecosystemCount: 1,
			now,
		}),
	).toEqual(activeGift)
	const afterFailedListing = await maybeEvaluateSecondAgentStandardGift({
		db: gifted.db,
		stableUserId: gifted.stableUserId,
		ecosystemCount: 2,
		listingFailed: true,
		now,
	})
	expect(afterFailedListing.status).toBe('active')
})
