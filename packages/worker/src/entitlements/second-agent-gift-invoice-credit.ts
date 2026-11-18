/**
 * Applies the queued second-agent gift for accounts on a paid Kody Stripe
 * subscription: a customer balance credit worth 14 days of the subscription
 * price, so Stripe takes 2 weeks of the plan off the next invoice.
 *
 * `orgs.second_agent_gift_invoice_credit_requested_at` queues the credit and
 * `orgs.second_agent_gift_invoice_credit_id` records the Stripe balance
 * transaction. Stripe writes use one idempotency key per org and look up an
 * existing transaction by metadata first, so a crash between Stripe and D1
 * cannot credit twice. When the subscription ended before the credit applied,
 * the gift falls back to the same delivery a new grant would get today (the
 * Free overlay or nothing for a manual grant).
 */

import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import { parseStoredPlanName } from '#universal/plans.ts'
import {
	resolveSecondAgentStandardGiftWrite,
	secondAgentGiftInvoiceCreditMinor,
} from '#universal/second-agent-standard-gift.ts'
import {
	selectKodyPlanRetainingSubscriptions,
	type BillingEnv,
} from '#worker/billing/billing-config.ts'
import { buildOrgBillingMetadata } from '#worker/billing/org-stripe-metadata.ts'
import {
	createCustomerBalanceCredit,
	listCustomerBalanceTransactions,
	listSubscriptions,
	type StripeEnv,
	type StripeSubscription,
} from '#worker/billing/stripe-client.ts'
import { updateOrgBillingColumns } from '#worker/orgs/org-billing-columns.ts'

export const secondAgentGiftMetadataKey = 'kody_second_agent_gift_org_id'
const batchSize = 8

type PendingCreditRow = {
	id: string
	plan: string
	stripe_customer_id: string | null
}

type InvoiceCreditEnv = BillingEnv & StripeEnv & { APP_DB: D1Database }

export function secondAgentGiftInvoiceCreditFor(
	subscription: StripeSubscription,
): { amountMinor: number; currency: string } {
	let amountMinor = 0
	for (const item of subscription.items.data) {
		const recurring = item.price.recurring
		if (!recurring || item.price.unit_amount == null) continue
		amountMinor += secondAgentGiftInvoiceCreditMinor({
			unitAmountMinor: item.price.unit_amount,
			quantity: item.quantity ?? 1,
			interval: recurring.interval,
			intervalCount: recurring.interval_count ?? 1,
		})
	}
	return { amountMinor, currency: subscription.currency?.trim() || 'usd' }
}

async function existingGiftCreditId(
	env: InvoiceCreditEnv,
	customerId: string,
	orgId: string,
) {
	const { transactions } = await listCustomerBalanceTransactions(
		env,
		customerId,
	)
	return (
		transactions.find(
			(transaction) =>
				transaction.metadata?.[secondAgentGiftMetadataKey] === orgId,
		)?.id ?? null
	)
}

async function recordCreditId(
	env: InvoiceCreditEnv,
	orgId: string,
	creditId: string,
	now: Date,
) {
	await updateOrgBillingColumns({
		db: env.APP_DB,
		orgId,
		setClause: `second_agent_gift_invoice_credit_id = ?, updated_at = ?`,
		values: [creditId, utcSqliteTimestamp(now)],
		orgWhereSuffix: ` AND second_agent_gift_invoice_credit_id IS NULL`,
	})
}

async function applyOne(
	env: InvoiceCreditEnv,
	row: PendingCreditRow,
	now: Date,
): Promise<'credited' | 'fallback'> {
	const customerId = row.stripe_customer_id?.trim() ?? ''
	const existingCreditId = customerId
		? await existingGiftCreditId(env, customerId, row.id)
		: null
	if (existingCreditId) {
		await recordCreditId(env, row.id, existingCreditId, now)
		return 'credited'
	}
	const subscription = customerId
		? selectKodyPlanRetainingSubscriptions(
				env,
				await listSubscriptions(env, customerId),
			)[0]
		: undefined
	const credit = subscription
		? secondAgentGiftInvoiceCreditFor(subscription)
		: null
	if (customerId && credit && credit.amountMinor > 0) {
		const created = await createCustomerBalanceCredit(env, {
			customerId,
			amountMinor: credit.amountMinor,
			currency: credit.currency,
			description: 'Kody second-agent bonus: 2 weeks of your plan',
			metadata: {
				[secondAgentGiftMetadataKey]: row.id,
				...buildOrgBillingMetadata(row.id),
			},
			idempotencyKey: `kody-second-agent-gift-${row.id}`,
		})
		await recordCreditId(env, row.id, created.id, now)
		return 'credited'
	}
	const write = resolveSecondAgentStandardGiftWrite({
		manualPlan: parseStoredPlanName(row.plan),
		stripePlan: null,
		hasStripeCustomer: false,
		now,
	})
	await updateOrgBillingColumns({
		db: env.APP_DB,
		orgId: row.id,
		setClause: `second_agent_gift_invoice_credit_requested_at = NULL,
		            second_agent_standard_gift_expires_at = ?,
		            updated_at = ?`,
		values: [write.expiresAt, utcSqliteTimestamp(now)],
		orgWhereSuffix: ` AND second_agent_gift_invoice_credit_id IS NULL
			AND second_agent_gift_invoice_credit_requested_at IS NOT NULL`,
	})
	return 'fallback'
}

/**
 * Applies up to eight queued credits. A failure moves the row to the back of
 * the queue so one stuck account cannot hold up the rest.
 */
export async function applySecondAgentGiftInvoiceCredits(input: {
	env: InvoiceCreditEnv
	now: Date
}) {
	const page = await input.env.APP_DB.prepare(
		`SELECT id, plan, stripe_customer_id FROM orgs
		 WHERE second_agent_gift_invoice_credit_requested_at IS NOT NULL
		   AND second_agent_gift_invoice_credit_id IS NULL
		   AND deleted_at IS NULL AND deleting_at IS NULL
		 ORDER BY second_agent_gift_invoice_credit_requested_at, id
		 LIMIT ?`,
	)
		.bind(batchSize)
		.all<PendingCreditRow>()
	const result = { credited: 0, fallback: 0, failed: 0 }
	for (const row of page.results) {
		try {
			result[await applyOne(input.env, row, input.now)] += 1
		} catch (error) {
			result.failed += 1
			console.warn('second-agent-gift-invoice-credit-failed', row.id, error)
			await updateOrgBillingColumns({
				db: input.env.APP_DB,
				orgId: row.id,
				setClause: `second_agent_gift_invoice_credit_requested_at = ?`,
				values: [input.now.toISOString()],
				orgWhereSuffix: ` AND second_agent_gift_invoice_credit_id IS NULL
					AND second_agent_gift_invoice_credit_requested_at IS NOT NULL`,
			}).catch(() => {})
		}
	}
	return result
}
