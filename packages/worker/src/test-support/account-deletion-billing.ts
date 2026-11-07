import { vi } from 'vitest'
import * as stripeClient from '#worker/billing/stripe-client.ts'
import { createTestDb } from '#worker/test-support/account-deletion.ts'

export function stripeSubscription(
	id: string,
	status: string,
): stripeClient.StripeSubscription {
	return {
		id,
		status,
		cancel_at: null,
		current_period_end: undefined,
		currency: undefined,
		// Kody ownership via metadata so deletion tests stay valid even when
		// the stub env omits STRIPE_PRO_* price ids (shared-account filter).
		metadata: { kody_plan: 'pro' },
		items: {
			data: [
				{
					id: undefined,
					quantity: undefined,
					price: { id: 'price_pro' },
					current_period_end: undefined,
				},
			],
		},
	}
}

export function createStripeUserDb(input: {
	id: number
	stableUserId: string
	customerId: string | null
}) {
	return createTestDb({
		users: [
			{
				id: input.id,
				email: `${input.stableUserId}@example.com`,
				stable_user_id: input.stableUserId,
				stripe_customer_id: input.customerId,
			},
		],
		mcp_memories: [
			{ id: `mem-${input.stableUserId}`, user_id: input.stableUserId },
		],
	})
}

/**
 * Spies the refund half of the Stripe client with "nothing paid yet, nothing
 * refunded before" defaults so cancel-focused tests do not accidentally issue
 * credit notes.
 */
export function spyOnStripeRefundClient() {
	const listPaidInvoicesForSubscription = vi
		.spyOn(stripeClient, 'listPaidInvoicesForSubscription')
		.mockResolvedValue([])
	const listCreditNotesForInvoice = vi
		.spyOn(stripeClient, 'listCreditNotesForInvoice')
		.mockResolvedValue([])
	const listCreditNotesForCustomer = vi
		.spyOn(stripeClient, 'listCreditNotesForCustomer')
		.mockResolvedValue([])
	const createProratedRefundCreditNote = vi
		.spyOn(stripeClient, 'createProratedRefundCreditNote')
		.mockRejectedValue(new Error('unexpected credit note'))
	return {
		listPaidInvoicesForSubscription,
		listCreditNotesForInvoice,
		listCreditNotesForCustomer,
		createProratedRefundCreditNote,
		restore() {
			listPaidInvoicesForSubscription.mockRestore()
			listCreditNotesForInvoice.mockRestore()
			listCreditNotesForCustomer.mockRestore()
			createProratedRefundCreditNote.mockRestore()
		},
	}
}

export const thirtyDaysSeconds = 30 * 24 * 60 * 60
export const refundPeriodStart = Math.floor(
	new Date('2026-09-01T00:00:00.000Z').getTime() / 1000,
)
export const refundPeriodEnd = refundPeriodStart + thirtyDaysSeconds
/** Exactly half of the 30-day period has elapsed. */
export const refundPeriodMidpointMs =
	(refundPeriodStart + thirtyDaysSeconds / 2) * 1000

export type PaidInvoiceLineInput = {
	id: string
	amount: number
	period?: { start: number; end: number }
	discount_amounts?: Array<{ amount: number }>
}

export function paidInvoice(input: {
	id: string
	amountPaid: number
	lines?: Array<PaidInvoiceLineInput>
}): stripeClient.StripePaidInvoice {
	const lines = input.lines ?? [
		{ id: `il_${input.id}`, amount: input.amountPaid },
	]
	return {
		id: input.id,
		amount_paid: input.amountPaid,
		currency: 'usd',
		lines: {
			data: lines.map((line) => ({
				id: line.id,
				amount: line.amount,
				period: line.period ?? {
					start: refundPeriodStart,
					end: refundPeriodEnd,
				},
				discount_amounts: line.discount_amounts,
			})),
		},
	}
}

export function kodyCreditNote(input: {
	id: string
	invoice: string
	total: number
	subscriptionId?: string
	status?: string
	marker?: boolean
}) {
	return {
		id: input.id,
		invoice: input.invoice,
		total: input.total,
		currency: 'usd',
		status: input.status ?? 'issued',
		metadata: {
			...(input.marker === false
				? {}
				: { [stripeClient.accountDeletionCreditNoteMetadataKey]: '1' }),
			...(input.subscriptionId
				? {
						[stripeClient.accountDeletionCreditNoteSubscriptionMetadataKey]:
							input.subscriptionId,
					}
				: {}),
		},
	}
}
