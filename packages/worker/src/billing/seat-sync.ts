/**
 * Sync Stripe subscription seat quantity to live owner/member count (P6).
 * P5 membership write paths should call {@link syncOrgSeatQuantity} after
 * adds/removes; wiring tracked in cleanup when P5 lands.
 *
 * Only purchasable Pro (current seat) prices get quantity updates. Retired
 * Kody prices and non-Kody subscriptions on the shared Stripe account are
 * never modified (P6 inherits them exactly; price migration is separate).
 */
import {
	isPurchasableProSubscription,
	selectKodyPlanRetainingSubscriptions,
	type BillingEnv,
} from './billing-config.ts'
import { countLiveSeats, isPaidOrgBilling } from '#worker/orgs/billing.ts'
import {
	listSubscriptions,
	subscriptionSeatQuantity,
	updateSubscriptionItemQuantity,
	type StripeEnv,
	type StripeSubscription,
} from './stripe-client.ts'
import { sendSeatChangeEmail } from './org-billing-emails.ts'
type SeatSyncEnv = BillingEnv & StripeEnv

type OrgBillingRow = {
	plan: string
	stripe_plan: string | null
	stripe_customer_id: string | null
	slug: string | null
}

async function loadOrgBillingRow(
	db: D1Database,
	orgId: string,
): Promise<OrgBillingRow | null> {
	return await db
		.prepare(
			`SELECT plan, stripe_plan, stripe_customer_id, slug
			 FROM orgs
			 WHERE id = ?
			   AND deleted_at IS NULL`,
		)
		.bind(orgId)
		.first<OrgBillingRow>()
}

function primarySubscriptionItemId(
	subscription: StripeSubscription,
): string | null {
	for (const item of subscription.items.data) {
		const id = item.id?.trim()
		if (id) return id
	}
	return null
}

export async function syncOrgSeatQuantity(input: {
	db: D1Database
	env: SeatSyncEnv
	orgId: string
	now?: Date
	notifySeatChange?: boolean
	emailEnv?: Env
}): Promise<{ previousQuantity: number; nextQuantity: number } | null> {
	void input.now
	const orgId = input.orgId.trim()
	if (!orgId) return null

	const billing = await loadOrgBillingRow(input.db, orgId)
	if (!billing || !isPaidOrgBilling(billing)) return null

	const customerId = billing.stripe_customer_id?.trim()
	if (!customerId) return null

	const subscriptions = selectKodyPlanRetainingSubscriptions(
		input.env,
		await listSubscriptions(input.env, customerId),
	)
	if (subscriptions.length !== 1) return null

	const subscription = subscriptions[0]!
	// Retired Standard/Pro keep exact billing in P6 (quantity and price).
	if (!isPurchasableProSubscription(input.env, subscription)) return null

	const subscriptionItemId = primarySubscriptionItemId(subscription)
	if (!subscriptionItemId) return null

	const previousQuantity = subscriptionSeatQuantity(subscription)
	const seatCount = await countLiveSeats(input.db, orgId)
	const nextQuantity = Math.max(1, seatCount)
	if (previousQuantity === nextQuantity) {
		return { previousQuantity, nextQuantity }
	}

	// Seats can change while the Stripe subscription list is in flight; confirm
	// the count right before writing so we never push a stale quantity.
	const confirmedQuantity = Math.max(1, await countLiveSeats(input.db, orgId))
	if (previousQuantity === confirmedQuantity) {
		return { previousQuantity, nextQuantity: confirmedQuantity }
	}

	await updateSubscriptionItemQuantity(input.env, {
		subscriptionItemId,
		quantity: confirmedQuantity,
	})
	const emailEnv = input.emailEnv
	if (input.notifySeatChange !== false && billing.slug && emailEnv) {
		await sendSeatChangeEmail({
			env: emailEnv,
			db: input.db,
			orgId,
			slug: billing.slug,
			previousQuantity,
			nextQuantity: confirmedQuantity,
		}).catch((error: unknown) => {
			console.warn('org-seat-change-email-failed', error)
		})
	}
	return { previousQuantity, nextQuantity: confirmedQuantity }
}
