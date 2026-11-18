/**
 * Second-agent gift: one 14-day overlay of Pro when a user first reaches
 * two unique inbound MCP OAuth clientIds. The column and helper names keep
 * "Standard" from before the Pro-only ladder (#2617). Overlay Pro uses the
 * retired Pro ceilings (no credit wallet); topping up still needs the
 * purchasable Pro subscription.
 *
 * Enforcement composes {@link resolveEffectivePlan}. The overlay only
 * raises Free. An account with a paid Kody Stripe subscription gets the same
 * 2 weeks as a Stripe invoice credit (14 days of its subscription price)
 * instead. Manual standard/pro/max grants without Stripe are a no-op.
 */

import {
	parseStripePlanName,
	resolveEffectivePlan,
	type PlanName,
} from '#universal/plans.ts'

const secondAgentStandardGiftPlan = 'pro' satisfies PlanName

/** 14 days. Observed through grant `expires_at`, not this export alone. */
const secondAgentStandardGiftDurationMs = 14 * 24 * 60 * 60 * 1000

const secondAgentStandardGiftStatuses = [
	'none',
	'active',
	'expired',
	'invoice_credit',
	'already_paid',
] as const

type SecondAgentStandardGiftStatus =
	(typeof secondAgentStandardGiftStatuses)[number]

export type SecondAgentStandardGiftState = {
	/** True after the one gift attempt has been recorded. */
	received: boolean
	/** True while the overlay currently raises a free account to Pro. */
	active: boolean
	status: SecondAgentStandardGiftStatus
	expiresAt: string | null
	grantedAt: string | null
}

function addSecondAgentStandardGiftDuration(now: Date): Date {
	return new Date(now.getTime() + secondAgentStandardGiftDurationMs)
}

export function isSecondAgentStandardGiftActive(
	expiresAt: string | null | undefined,
	now: Date = new Date(),
) {
	if (!expiresAt) return false
	const expiresMs = Date.parse(expiresAt)
	return Number.isFinite(expiresMs) && expiresMs > now.getTime()
}

export function describeSecondAgentStandardGift(input: {
	grantedAt?: string | null
	expiresAt?: string | null
	invoiceCreditRequestedAt?: string | null
	now?: Date
}): SecondAgentStandardGiftState {
	const grantedAt = input.grantedAt?.trim() || null
	const expiresAt = input.expiresAt?.trim() || null
	if (!grantedAt) {
		return {
			received: false,
			active: false,
			status: 'none',
			expiresAt: null,
			grantedAt: null,
		}
	}
	if (!expiresAt) {
		return {
			received: true,
			active: false,
			status: input.invoiceCreditRequestedAt?.trim()
				? 'invoice_credit'
				: 'already_paid',
			expiresAt: null,
			grantedAt,
		}
	}
	const active = isSecondAgentStandardGiftActive(expiresAt, input.now)
	return {
		received: true,
		active,
		status: active ? 'active' : 'expired',
		expiresAt,
		grantedAt,
	}
}

/**
 * Effective plan plus the second-agent / referral overlay. The overlay only
 * raises Free to Pro (`isProOverlay`), so retired Standard and
 * legacy-ladder subscribers keep their own tables; it never lowers paid or
 * manual grants. Overlay Pro is not credits-eligible: it uses the retired
 * Pro ceilings, not the purchasable-Pro credits table.
 */
export function resolveEffectivePlanWithSecondAgentGift(
	manualPlan: PlanName,
	stripePlan: string | null,
	giftExpiresAt: string | null | undefined,
	now: Date = new Date(),
): PlanName {
	return resolvePlanOverlay(manualPlan, stripePlan, giftExpiresAt, now).plan
}

/**
 * {@link resolveEffectivePlanWithSecondAgentGift} plus whether the result
 * came from the overlay. An overlaid `pro` uses the retired Pro table
 * without a credit wallet (not the purchasable-Pro credits table).
 */
export function resolvePlanOverlay(
	manualPlan: PlanName,
	stripePlan: string | null,
	giftExpiresAt: string | null | undefined,
	now: Date = new Date(),
): { plan: PlanName; isProOverlay: boolean } {
	const base = resolveEffectivePlan(manualPlan, stripePlan)
	if (base === 'free' && isSecondAgentStandardGiftActive(giftExpiresAt, now)) {
		return { plan: secondAgentStandardGiftPlan, isProOverlay: true }
	}
	return { plan: base, isProOverlay: false }
}

/**
 * How the one gift is delivered:
 * - `invoice_credit`: a paid Kody Stripe subscription. Stripe credits the
 *   customer balance with 14 days of the subscription price, so the next
 *   invoice is lower by 2 weeks of the plan.
 * - `overlay`: the base plan is Free, so Pro overlays for 14 days.
 * - `included`: a manual standard/pro/max grant without Stripe. Nothing to
 *   extend; the ledger row is still written once.
 */
export type SecondAgentStandardGiftWrite =
	| { kind: 'invoice_credit'; expiresAt: null }
	| { kind: 'overlay'; expiresAt: string }
	| { kind: 'included'; expiresAt: null }

export function resolveSecondAgentStandardGiftWrite(input: {
	manualPlan: PlanName
	stripePlan: string | null
	hasStripeCustomer: boolean
	now: Date
}): SecondAgentStandardGiftWrite {
	if (input.hasStripeCustomer && parseStripePlanName(input.stripePlan)) {
		return { kind: 'invoice_credit', expiresAt: null }
	}
	if (resolveEffectivePlan(input.manualPlan, input.stripePlan) !== 'free') {
		return { kind: 'included', expiresAt: null }
	}
	return {
		kind: 'overlay',
		expiresAt: addSecondAgentStandardGiftDuration(input.now).toISOString(),
	}
}

const daysPerBillingInterval = {
	day: 1,
	week: 7,
	month: 30,
	year: 365,
} as const

/**
 * 14 days of a recurring price, in the price's minor currency unit. Returns
 * 0 for an unknown interval or a free price.
 */
export function secondAgentGiftInvoiceCreditMinor(input: {
	unitAmountMinor: number
	quantity: number
	interval: string
	intervalCount: number
}): number {
	const days =
		daysPerBillingInterval[
			input.interval as keyof typeof daysPerBillingInterval
		]
	if (!days || input.intervalCount < 1) return 0
	const periodDays = days * input.intervalCount
	const giftDays = secondAgentStandardGiftDurationMs / (24 * 60 * 60 * 1000)
	const amount =
		(input.unitAmountMinor * Math.max(1, input.quantity) * giftDays) /
		periodDays
	return Math.max(0, Math.round(amount))
}
