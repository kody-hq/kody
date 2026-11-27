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
 * the Kody billing page, and Kody applies it only to the billing interval
 * named by the promotion code's `kody_interval` metadata (`month` or
 * `year`). An untagged code is monthly.
 *
 * Claims are per person across organizations. A code without a claim-scope
 * tag is blocked by any earlier claim or live reservation. With
 * `kody_claim_scope: campaign`, only a claim or live reservation for the
 * same campaign (`kody_campaign`, defaulting to the Stripe promotion code ID)
 * or Stripe promotion code blocks checkout.
 */

export const promoIntervalMetadataKey = 'kody_interval'
export const promoClaimScopeMetadataKey = 'kody_claim_scope'
export const promoCampaignMetadataKey = 'kody_campaign'

/** Claim key of the one-claim-ever rule for untagged promotion codes. */
const lifetimePromoClaimKey = 'lifetime'

export const monthlyPromoOnAnnualRejection =
	'That promo code is for monthly billing. Choose monthly to use it.'

export const annualPromoOnMonthlyRejection =
	'That promo code is for annual billing. Choose annual to use it.'

export const existingSubscriptionPromoRejection =
	'Promo codes apply to new subscriptions only. This organization already has one.'

export const promoAlreadyClaimedRejection =
	'You have already used a promo code. Promo codes can be claimed once per person, across all of your organizations.'

export const campaignPromoAlreadyClaimedRejection =
	'You have already claimed this promotion. It can be claimed once per person, across all of your organizations.'

export const misconfiguredPromoRejection =
	"That promo code isn't set up correctly. Please contact support."

/** Checkout Session metadata that names the person claiming a promo code. */
export const promoClaimMetadataKeys = {
	userId: 'kody_promo_user_id',
	promotionCodeId: 'kody_promo_code_id',
	claimKey: 'kody_promo_claim_key',
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

/** The interval a promotion code is for; null when its tag is unrecognized. */
function promotionCodeInterval(
	metadata: Record<string, string> | null | undefined,
): BillingInterval | null {
	const tag = metadata?.[promoIntervalMetadataKey]?.trim().toLowerCase()
	if (!tag) return 'month'
	if (tag === 'month' || tag === 'year') return tag
	return null
}

/**
 * The claim key a promotion code's claims are recorded under: `lifetime`
 * when untagged, `campaign:<id>` for `kody_claim_scope: campaign`. Null when
 * the tags are unrecognized or `kody_campaign` is set without the scope.
 */
function promotionCodeClaimKey(promotion: {
	id: string
	metadata?: Record<string, string> | null
}): string | null {
	const scope = promotion.metadata?.[promoClaimScopeMetadataKey]
		?.trim()
		.toLowerCase()
	const campaign = promotion.metadata?.[promoCampaignMetadataKey]
		?.trim()
		.toLowerCase()
	if (!scope) return campaign ? null : lifetimePromoClaimKey
	if (scope !== 'campaign') return null
	return `campaign:${campaign || promotion.id}`
}

/** The 409 message for a person whose earlier claim blocks `claimKey`. */
export function promoClaimedRejection(claimKey: string): string {
	return claimKey === lifetimePromoClaimKey
		? promoAlreadyClaimedRejection
		: campaignPromoAlreadyClaimedRejection
}

function promoIntervalMismatch(
	codeInterval: BillingInterval,
	checkoutInterval: BillingInterval,
): string | null {
	if (codeInterval === checkoutInterval) return null
	switch (codeInterval) {
		case 'month':
			return monthlyPromoOnAnnualRejection
		case 'year':
			return annualPromoOnMonthlyRejection
		default: {
			const exhaustive: never = codeInterval
			return exhaustive
		}
	}
}

/**
 * Resolve the Stripe promotion code ID and claim key for the requested
 * billing interval. Check expiry and redemption limits for specific errors;
 * Stripe also checks coupon restrictions when creating the Checkout Session.
 */
export async function resolveCheckoutPromotionCode(
	env: StripeEnv,
	input: { code: string; interval: BillingInterval; now: Date },
): Promise<
	{ ok: true; id: string; claimKey: string } | { ok: false; error: string }
> {
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
	const codeInterval = promotionCodeInterval(promotion.metadata)
	if (!codeInterval) {
		console.error('billing_checkout_promo_interval_unrecognized', {
			promotionCodeId: promotion.id,
		})
		return { ok: false, error: unknownPromoRejection }
	}
	const claimKey = promotionCodeClaimKey(promotion)
	if (!claimKey) {
		console.error('billing_checkout_promo_claim_scope_unrecognized', {
			promotionCodeId: promotion.id,
			claimScope: promotion.metadata?.[promoClaimScopeMetadataKey] ?? null,
			campaign: promotion.metadata?.[promoCampaignMetadataKey] ?? null,
		})
		return { ok: false, error: misconfiguredPromoRejection }
	}
	const mismatch = promoIntervalMismatch(codeInterval, input.interval)
	if (mismatch) return { ok: false, error: mismatch }
	return { ok: true, id: promotion.id, claimKey }
}

/** Shown when Stripe still rejects a validated code at session creation. */
export const promoRejectedByStripe =
	"That promo code can't be applied to this plan."

/**
 * A reservation older than this is abandoned: Stripe expires a Checkout
 * Session after 24 hours at most, and `checkout.session.expired` releases the
 * row when it arrives. The age bound covers a webhook that never did.
 */
const promoReservationMaxAgeMs = 25 * 60 * 60 * 1000

/**
 * Reserve the person's claim under `claimKey` before the Checkout Session
 * exists. A lifetime claim is blocked by any earlier claim or live reservation;
 * a campaign claim only by one with the same claim key or promotion code.
 * Stale reservations are cleared first. The check and insert are one
 * statement. Returns false if no reservation was inserted.
 */
export async function reservePromoClaim(input: {
	db: D1Database
	userId: string
	promotionCodeId: string
	claimKey: string
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
			 (user_id, claim_key, promotion_code_id, org_id, status, checkout_session_id, reserved_at, claimed_at)
			 SELECT ?1, ?2, ?3, ?4, 'reserved', NULL, ?5, NULL
			 WHERE NOT EXISTS (
			   SELECT 1 FROM billing_promo_claims
			   WHERE user_id = ?1
			     AND (?2 = ?6 OR claim_key = ?2 OR promotion_code_id = ?3)
			 )`,
		)
		.bind(
			input.userId,
			input.claimKey,
			input.promotionCodeId,
			input.orgId,
			nowIso,
			lifetimePromoClaimKey,
		)
		.run()
	return (inserted.meta.changes ?? 0) > 0
}

/**
 * Read-only twin of the {@link reservePromoClaim} check for a campaign claim
 * key: true when the person has a claim, or a reservation that is not stale,
 * under `claimKey`.
 */
export async function hasBlockingPromoClaim(input: {
	db: D1Database
	userId: string
	claimKey: string
	now: Date
}): Promise<boolean> {
	const staleBefore = new Date(
		input.now.getTime() - promoReservationMaxAgeMs,
	).toISOString()
	const row = await input.db
		.prepare(
			`SELECT 1 AS blocked FROM billing_promo_claims
			 WHERE user_id = ? AND claim_key = ?
			   AND (status != 'reserved' OR reserved_at >= ?)
			 LIMIT 1`,
		)
		.bind(input.userId, input.claimKey, staleBefore)
		.first<{ blocked: number }>()
	return row !== null
}

/** Tie the reservation to the Checkout Session Stripe created for it. */
export async function attachPromoReservationSession(input: {
	db: D1Database
	userId: string
	claimKey: string
	checkoutSessionId: string
}): Promise<void> {
	await input.db
		.prepare(
			`UPDATE billing_promo_claims
			 SET checkout_session_id = ?
			 WHERE user_id = ? AND claim_key = ? AND status = 'reserved'`,
		)
		.bind(input.checkoutSessionId, input.userId, input.claimKey)
		.run()
}

/** Release a reservation whose checkout never started (Stripe refused it). */
export async function releasePromoReservation(input: {
	db: D1Database
	userId: string
	claimKey: string
}): Promise<void> {
	await input.db
		.prepare(
			`DELETE FROM billing_promo_claims
			 WHERE user_id = ? AND claim_key = ? AND status = 'reserved'`,
		)
		.bind(input.userId, input.claimKey)
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
	claimKey: string
}): Record<string, string> {
	return {
		[promoClaimMetadataKeys.userId]: input.userId,
		[promoClaimMetadataKeys.promotionCodeId]: input.promotionCodeId,
		[promoClaimMetadataKeys.claimKey]: input.claimKey,
	}
}

/**
 * Finalize the claim for a completed discounted checkout. Upserts so a
 * completed session whose reservation was already released (webhook order,
 * stale-age cleanup) still counts; a claim that already exists is kept as is.
 * A session without a claim key was started before claim scopes and is a
 * lifetime claim.
 * Remove when: 3 days after migration 0298 deploys, once Stripe Checkout
 * expiry and webhook retries for pre-0298 sessions have passed.
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
	const claimKey =
		input.session.metadata?.[promoClaimMetadataKeys.claimKey]?.trim() ||
		lifetimePromoClaimKey
	const nowIso = input.now.toISOString()
	await input.db
		.prepare(
			`INSERT INTO billing_promo_claims
			 (user_id, claim_key, promotion_code_id, org_id, status, checkout_session_id, reserved_at, claimed_at)
			 VALUES (?, ?, ?, ?, 'claimed', ?, ?, ?)
			 ON CONFLICT(user_id, claim_key) DO UPDATE SET
			   promotion_code_id = excluded.promotion_code_id,
			   org_id = excluded.org_id,
			   status = 'claimed',
			   checkout_session_id = excluded.checkout_session_id,
			   claimed_at = excluded.claimed_at
			 WHERE billing_promo_claims.status = 'reserved'`,
		)
		.bind(
			userId,
			claimKey,
			promotionCodeId,
			input.orgId,
			input.session.id,
			nowIso,
			nowIso,
		)
		.run()
}
