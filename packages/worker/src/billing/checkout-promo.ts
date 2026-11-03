import type { BillingInterval } from '#worker/billing/billing-config.ts'
import {
	findActivePromotionCode,
	type StripeEnv,
} from '#worker/billing/stripe-client.ts'

/**
 * Promo codes for Pro checkout. Stripe can restrict a coupon to a product
 * but not to a price, and monthly and annual Pro are prices of one product.
 * A "100% off once" code typed on Stripe's page would make a whole year free.
 * So Checkout never shows Stripe's code box. The customer types the code on
 * the Kody billing page, and Kody applies it only to monthly checkouts.
 */

export const annualPromoRejection =
	'Promo codes apply to monthly billing only. Choose monthly to use this code.'

export const existingSubscriptionPromoRejection =
	'Promo codes apply to new subscriptions only. This organization already has one.'

export const promoAlreadyClaimedRejection =
	'You have already used a promo code. Promo codes can be claimed once per person, across all of your organizations.'

/** Checkout Session metadata that names the person claiming a promo code. */
export const promoClaimMetadataKeys = {
	userId: 'kody_promo_user_id',
	promotionCodeId: 'kody_promo_code_id',
} as const

const unknownPromoRejection = "That promo code isn't valid."
const expiredPromoRejection = 'That promo code has expired.'
const redeemedPromoRejection = 'That promo code has already been used.'

/** Customer-facing promo code text: trimmed, or null when the field was empty. */
export function parsePromoCodeInput(
	value: unknown,
): { ok: true; code: string | null } | { ok: false; error: string } {
	if (value === undefined || value === null) return { ok: true, code: null }
	if (typeof value !== 'string') {
		return { ok: false, error: unknownPromoRejection }
	}
	const code = value.trim()
	if (!code) return { ok: true, code: null }
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
		return { ok: false, error: unknownPromoRejection }
	}
	return { ok: true, code }
}

/** Codes are monthly-only. Checked before any Stripe call. */
export function promoIntervalRejection(interval: BillingInterval) {
	switch (interval) {
		case 'month':
			return null
		case 'year':
			return annualPromoRejection
		default: {
			const exhaustive: never = interval
			return exhaustive
		}
	}
}

/**
 * The Stripe promotion code id for `code`. Stripe enforces the product
 * restriction, expiry, and redemption limit again when the Checkout Session
 * is created; checking here gives the customer a specific message.
 */
export async function resolveCheckoutPromotionCode(
	env: StripeEnv,
	input: { code: string; now: Date },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
	const promotion = await findActivePromotionCode(env, input.code)
	if (!promotion || !promotion.active) {
		return { ok: false, error: unknownPromoRejection }
	}
	if (
		promotion.expires_at != null &&
		promotion.expires_at * 1000 <= input.now.getTime()
	) {
		return { ok: false, error: expiredPromoRejection }
	}
	if (
		promotion.max_redemptions != null &&
		(promotion.times_redeemed ?? 0) >= promotion.max_redemptions
	) {
		return { ok: false, error: redeemedPromoRejection }
	}
	return { ok: true, id: promotion.id }
}

/** Shown when Stripe still rejects a validated code at session creation. */
export const promoRejectedByStripe =
	"That promo code can't be applied to this plan."

/** True once `userId` has completed a discounted checkout for any org. */
/**
 * A reservation older than this is abandoned: Stripe expires a Checkout
 * Session after 24 hours at most, and `checkout.session.expired` releases the
 * row when it arrives. The age bound covers a webhook that never did.
 */
const promoReservationMaxAgeMs = 25 * 60 * 60 * 1000

export async function hasPersonClaimedPromo(
	db: D1Database,
	userId: string,
): Promise<boolean> {
	const row = await db
		.prepare(`SELECT 1 AS ok FROM billing_promo_claims WHERE user_id = ?`)
		.bind(userId)
		.first<{ ok: number }>()
	return row != null
}

/**
 * Reserve the person's one promo claim before the Checkout Session exists.
 * The primary key on user_id makes this atomic: of two concurrent checkouts
 * exactly one inserts, the other sees the row and is refused. Returns false
 * when the person already holds a claim or a live reservation.
 */
export async function reservePromoClaim(input: {
	db: D1Database
	userId: string
	promotionCodeId: string
	orgId: string
	now: Date
}): Promise<boolean> {
	const nowIso = input.now.toISOString()
	const staleBefore = new Date(
		input.now.getTime() - promoReservationMaxAgeMs,
	).toISOString()
	await input.db
		.prepare(
			`DELETE FROM billing_promo_claims
			 WHERE user_id = ? AND status = 'reserved' AND reserved_at < ?`,
		)
		.bind(input.userId, staleBefore)
		.run()
	const inserted = await input.db
		.prepare(
			`INSERT OR IGNORE INTO billing_promo_claims
			 (user_id, promotion_code_id, org_id, status, checkout_session_id, reserved_at, claimed_at)
			 VALUES (?, ?, ?, 'reserved', NULL, ?, NULL)`,
		)
		.bind(input.userId, input.promotionCodeId, input.orgId, nowIso)
		.run()
	return (inserted.meta.changes ?? 0) > 0
}

/** Tie the reservation to the Checkout Session Stripe created for it. */
export async function attachPromoReservationSession(input: {
	db: D1Database
	userId: string
	checkoutSessionId: string
}): Promise<void> {
	await input.db
		.prepare(
			`UPDATE billing_promo_claims
			 SET checkout_session_id = ?
			 WHERE user_id = ? AND status = 'reserved'`,
		)
		.bind(input.checkoutSessionId, input.userId)
		.run()
}

/** Release a reservation whose checkout never started (Stripe refused it). */
export async function releasePromoReservation(input: {
	db: D1Database
	userId: string
}): Promise<void> {
	await input.db
		.prepare(
			`DELETE FROM billing_promo_claims WHERE user_id = ? AND status = 'reserved'`,
		)
		.bind(input.userId)
		.run()
}

/** Release the reservation behind an expired or abandoned Checkout Session. */
export async function releasePromoReservationForCheckoutSession(input: {
	db: D1Database
	checkoutSessionId: string
}): Promise<void> {
	await input.db
		.prepare(
			`DELETE FROM billing_promo_claims
			 WHERE checkout_session_id = ? AND status = 'reserved'`,
		)
		.bind(input.checkoutSessionId)
		.run()
}

export function promoClaimMetadata(input: {
	userId: string
	promotionCodeId: string
}): Record<string, string> {
	return {
		[promoClaimMetadataKeys.userId]: input.userId,
		[promoClaimMetadataKeys.promotionCodeId]: input.promotionCodeId,
	}
}

/**
 * Finalize the claim for a completed discounted checkout. Upserts so a
 * completed session whose reservation was already released (webhook order,
 * stale-age cleanup) still counts; a claim that already exists is kept as is.
 */
export async function recordPromoClaimFromCheckoutSession(input: {
	db: D1Database
	orgId: string
	session: { id: string; metadata?: Record<string, string> | null }
	now: Date
}): Promise<void> {
	const userId = input.session.metadata?.[promoClaimMetadataKeys.userId]?.trim()
	const promotionCodeId =
		input.session.metadata?.[promoClaimMetadataKeys.promotionCodeId]?.trim()
	if (!userId || !promotionCodeId) return
	const nowIso = input.now.toISOString()
	await input.db
		.prepare(
			`INSERT INTO billing_promo_claims
			 (user_id, promotion_code_id, org_id, status, checkout_session_id, reserved_at, claimed_at)
			 VALUES (?, ?, ?, 'claimed', ?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET
			   promotion_code_id = excluded.promotion_code_id,
			   org_id = excluded.org_id,
			   status = 'claimed',
			   checkout_session_id = excluded.checkout_session_id,
			   claimed_at = excluded.claimed_at
			 WHERE billing_promo_claims.status = 'reserved'`,
		)
		.bind(
			userId,
			promotionCodeId,
			input.orgId,
			input.session.id,
			nowIso,
			nowIso,
		)
		.run()
}
