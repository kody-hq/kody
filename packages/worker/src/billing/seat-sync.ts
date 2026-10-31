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
	getCreditsEligiblePriceIds,
	selectKodyPlanRetainingSubscriptions,
	type BillingEnv,
} from './billing-config.ts'
import { countLiveSeats, isPaidOrgBilling } from '#worker/orgs/billing.ts'
import {
	listSubscriptions,
	subscriptionItemSeatQuantity,
	updateSubscriptionItemQuantity,
	type StripeEnv,
	type StripeSubscription,
} from './stripe-client.ts'
import { sendSeatChangeEmail } from './org-billing-emails.ts'
import {
	recordOrgAuditEvent,
	type OrgAuditWriter,
} from '#worker/orgs/org-audit.ts'
type SeatSyncEnv = BillingEnv & StripeEnv
export const billingSeatQuantitySyncedAction = 'billing_seat_quantity_synced'

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

export function selectPurchasableSeatSubscription(
	env: SeatSyncEnv,
	subscriptions: ReadonlyArray<StripeSubscription>,
): {
	subscription: StripeSubscription
	subscriptionItemId: string
	seatQuantity: number
} | null {
	const selected = selectKodyPlanRetainingSubscriptions(env, subscriptions)
	if (selected.length !== 1) return null
	const subscription = selected[0]!
	const eligiblePriceIds = new Set(getCreditsEligiblePriceIds(env))
	for (const item of subscription.items.data) {
		const id = item.id?.trim()
		if (id && eligiblePriceIds.has(item.price.id)) {
			return {
				subscription,
				subscriptionItemId: id,
				seatQuantity: subscriptionItemSeatQuantity(item),
			}
		}
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
	audit?: OrgAuditWriter | null
}): Promise<{ previousQuantity: number; nextQuantity: number } | null> {
	void input.now
	const orgId = input.orgId.trim()
	if (!orgId) return null

	const billing = await loadOrgBillingRow(input.db, orgId)
	if (!billing || !isPaidOrgBilling(billing)) return null

	const customerId = billing.stripe_customer_id?.trim()
	if (!customerId) return null

	const selected = selectPurchasableSeatSubscription(
		input.env,
		await listSubscriptions(input.env, customerId),
	)
	if (!selected) return null
	const { subscriptionItemId, seatQuantity: previousQuantity } = selected
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
	try {
		if (input.audit) {
			await recordOrgAuditEvent(input.audit, {
				orgId,
				action: billingSeatQuantitySyncedAction,
				resourceType: 'org_subscription',
				details: {
					previousQuantity,
					nextQuantity: confirmedQuantity,
				},
			})
		}
	} catch (error) {
		console.warn('org-seat-sync-audit-failed', { orgId, error })
	}
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
