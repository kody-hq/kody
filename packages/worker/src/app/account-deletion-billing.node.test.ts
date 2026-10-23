import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import * as stripeClient from '#worker/billing/stripe-client.ts'
import {
	AccountDeletionBillingError,
	deleteUserAccount,
} from './account-deletion.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { createSuccessfulDeletionEnv } from '#worker/test-support/account-deletion.ts'
import {
	createStripeUserDb,
	kodyCreditNote,
	paidInvoice,
	refundPeriodEnd,
	refundPeriodMidpointMs,
	refundPeriodStart,
	spyOnStripeRefundClient,
	stripeSubscription,
	thirtyDaysSeconds,
} from '#worker/test-support/account-deletion-billing.ts'

/**
 * Spies the whole Stripe client. Disposing restores the spies, real timers,
 * and any stubbed `fetch`; `nowMs` pins `Date` for refund proration.
 */
function spyOnStripeBillingClient(nowMs?: number) {
	if (nowMs !== undefined) {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date(nowMs))
	}
	const listSubscriptions = vi.spyOn(stripeClient, 'listSubscriptions')
	const cancelSubscription = vi
		.spyOn(stripeClient, 'cancelSubscription')
		.mockResolvedValue(undefined)
	const deleteCustomer = vi
		.spyOn(stripeClient, 'deleteCustomer')
		.mockResolvedValue(undefined)
	const refund = spyOnStripeRefundClient()
	return {
		listSubscriptions,
		cancelSubscription,
		deleteCustomer,
		...refund,
		[Symbol.dispose]() {
			listSubscriptions.mockRestore()
			cancelSubscription.mockRestore()
			deleteCustomer.mockRestore()
			refund.restore()
			vi.useRealTimers()
			vi.unstubAllGlobals()
		},
	}
}

const active = (id: string) => stripeSubscription(id, 'active')

function subscriptionIdsOf(calls: Array<[unknown, string, ...Array<unknown>]>) {
	return calls.map(([, subscriptionId]) => subscriptionId)
}

/** A seeded Stripe customer whose deletion runs against a stub env. */
function stripeUser(
	stableUserId: string,
	customerId: string | null,
	envOverrides: Partial<Env> = {},
) {
	const { db, rows } = createStripeUserDb({ id: 1, stableUserId, customerId })
	const deleteVectors = vi.fn(async () => undefined)
	const env = createSuccessfulDeletionEnv(db, {
		CAPABILITY_VECTOR_INDEX: { deleteByIds: deleteVectors },
		...envOverrides,
	})
	return {
		rows,
		deleteVectors,
		meter: userMeterRpc({ env, userId: ownerIdFromStored(stableUserId) }),
		deleteAccount: () =>
			deleteUserAccount({
				env,
				dbUserId: 1,
				mcpUserId: ownerIdFromStored(stableUserId),
			}),
	}
}

/** Billing failures reject before anything destructive and release the fence. */
async function expectBillingFailureRetainsAccount(
	user: ReturnType<typeof stripeUser>,
	input: {
		stableUserId: string
		customerId: string
		billingErrors: Array<string>
	},
) {
	const error = await user.deleteAccount().catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(AccountDeletionBillingError)
	expect((error as AccountDeletionBillingError).billingErrors).toEqual(
		input.billingErrors,
	)
	expect(user.deleteVectors).not.toHaveBeenCalled()
	expect(user.rows.users).toEqual([
		expect.objectContaining({
			id: 1,
			stable_user_id: input.stableUserId,
			stripe_customer_id: input.customerId,
			deleting_at: null,
		}),
	])
	expect(user.rows.mcp_memories).toEqual([
		{ id: `mem-${input.stableUserId}`, user_id: input.stableUserId },
	])
	expect(await user.meter.readDeletionState()).toEqual({ deletingAt: null })
	expect(consoleError).toHaveBeenCalledWith(
		'account_deletion_billing_cancel_failed',
		{ userId: input.stableUserId, billingErrors: input.billingErrors },
	)
}

test('account deletion cancels Stripe billing before cleanup and keeps customer deletion best-effort', async () => {
	using stripe = spyOnStripeBillingClient()
	stripe.listSubscriptions.mockResolvedValue([
		active('sub_active'),
		stripeSubscription('sub_trialing', 'trialing'),
		// Dunning and paused states can still invoice or resume, so they
		// must be canceled too; only terminal states are skipped.
		stripeSubscription('sub_past_due', 'past_due'),
		stripeSubscription('sub_unpaid', 'unpaid'),
		stripeSubscription('sub_paused', 'paused'),
		stripeSubscription('sub_incomplete', 'incomplete'),
		stripeSubscription('sub_canceled', 'canceled'),
		stripeSubscription('sub_expired', 'incomplete_expired'),
		// Shared Stripe account product: never cancel or refund.
		{
			id: 'sub_gratitext',
			status: 'active',
			cancel_at: null,
			current_period_end: undefined,
			metadata: undefined,
			items: {
				data: [
					{
						id: undefined,
						quantity: undefined,
						price: { id: 'price_gratitext_premium_15' },
						current_period_end: undefined,
					},
				],
			},
		},
	])
	const pro = stripeUser('user-pro', 'cus_pro')
	const result = await pro.deleteAccount()

	expect(stripe.listSubscriptions).toHaveBeenCalledTimes(1)
	expect(stripe.listSubscriptions).toHaveBeenCalledWith(
		expect.any(Object),
		'cus_pro',
	)
	expect(subscriptionIdsOf(stripe.cancelSubscription.mock.calls)).toEqual([
		'sub_active',
		'sub_trialing',
		'sub_past_due',
		'sub_unpaid',
		'sub_paused',
		'sub_incomplete',
	])
	expect(subscriptionIdsOf(stripe.cancelSubscription.mock.calls)).not.toContain(
		'sub_gratitext',
	)
	expect(stripe.deleteCustomer).toHaveBeenCalledWith(
		expect.any(Object),
		'cus_pro',
	)
	expect(pro.rows.users).toEqual([])
	expect(result.warnings).toEqual([])
	// Only subscriptions in good standing are even considered for a refund;
	// with no paid invoice there is nothing to credit.
	expect(
		subscriptionIdsOf(stripe.listPaidInvoicesForSubscription.mock.calls),
	).toEqual(['sub_active', 'sub_trialing'])
	expect(stripe.createProratedRefundCreditNote).not.toHaveBeenCalled()
	expect(stripe.listCreditNotesForCustomer).toHaveBeenCalledWith(
		expect.any(Object),
		'cus_pro',
	)
	expect(result.stripeRefunds).toEqual([])

	// Customer deletion after a successful cancel stays warning-only: nothing
	// bills a customer with no billable subscription.
	vi.clearAllMocks()
	stripe.listSubscriptions.mockResolvedValue([active('sub_active')])
	stripe.deleteCustomer.mockRejectedValue(
		new Error('Stripe customer unavailable'),
	)
	consoleError.mockImplementation(() => {})
	const customerFailure = stripeUser('user-customer-failure', 'cus_failure')
	const customerFailureResult = await customerFailure.deleteAccount()

	expect(stripe.cancelSubscription).toHaveBeenCalledWith(
		expect.any(Object),
		'sub_active',
	)
	expect(stripe.deleteCustomer).toHaveBeenLastCalledWith(
		expect.any(Object),
		'cus_failure',
	)
	expect(customerFailure.rows.users).toEqual([])
	expect(customerFailureResult.warnings).toEqual([
		expect.stringContaining('Stripe customer cleanup failed'),
	])
	expect(consoleError).toHaveBeenCalledOnce()
	expect(consoleError).toHaveBeenCalledWith(
		'account_deletion_stripe_cleanup_failed',
		expect.objectContaining({
			userId: ownerIdFromStored('user-customer-failure'),
			error: expect.any(Error),
		}),
	)

	vi.clearAllMocks()
	const free = stripeUser('user-free', null)
	await free.deleteAccount()
	expect(stripe.listSubscriptions).not.toHaveBeenCalled()
	expect(stripe.listCreditNotesForCustomer).not.toHaveBeenCalled()
	expect(stripe.deleteCustomer).not.toHaveBeenCalled()
	expect(free.rows.users).toEqual([])
})

test('a failed Stripe cancellation retains the account, releases the fence, and touches nothing else', async () => {
	using stripe = spyOnStripeBillingClient()
	consoleError.mockImplementation(() => {})
	const cases: Array<[string, () => void, string]> = [
		[
			'user-list-fails',
			() =>
				stripe.listSubscriptions.mockRejectedValue(
					new Error('Stripe subscriptions unavailable'),
				),
			'Stripe subscriptions could not be listed: Stripe subscriptions unavailable',
		],
		[
			'user-cancel-fails',
			() => {
				// The cancel is rejected and the subscription stays active.
				stripe.listSubscriptions.mockResolvedValue([active('sub_active')])
				stripe.cancelSubscription.mockRejectedValue(
					new Error('Stripe cancel rejected'),
				)
			},
			'Stripe subscription sub_active could not be canceled: Stripe cancel rejected',
		],
	]
	for (const [stableUserId, arrange, billingError] of cases) {
		stripe.listSubscriptions.mockReset()
		stripe.cancelSubscription.mockReset()
		stripe.deleteCustomer.mockReset().mockResolvedValue(undefined)
		arrange()
		await expectBillingFailureRetainsAccount(
			stripeUser(stableUserId, 'cus_billing'),
			{
				stableUserId,
				customerId: 'cus_billing',
				billingErrors: [billingError],
			},
		)
		expect(stripe.deleteCustomer).not.toHaveBeenCalled()
	}
})

test('account deletion refunds unused time with a credit note before canceling each paid subscription', async () => {
	using stripe = spyOnStripeBillingClient(refundPeriodMidpointMs)
	stripe.listSubscriptions.mockResolvedValue([
		active('sub_active'),
		stripeSubscription('sub_trialing', 'trialing'),
		stripeSubscription('sub_past_due', 'past_due'),
	])
	stripe.listPaidInvoicesForSubscription.mockImplementation(
		async (_env, subscriptionId) =>
			subscriptionId === 'sub_active'
				? [paidInvoice({ id: 'in_active', amountPaid: 1201 })]
				: // A trial that has not converted has a $0 paid invoice.
					[paidInvoice({ id: 'in_trial', amountPaid: 0 })],
	)
	stripe.createProratedRefundCreditNote.mockResolvedValue({
		outcome: 'issued',
		id: 'cn_active',
		total: 600,
		currency: 'usd',
	})
	const user = stripeUser('user-refund', 'cus_refund')
	const result = await user.deleteAccount()

	// floor(1201 * 15d / 30d) = 600: the odd cent stays with Kody, never
	// rounds up against the invoice.
	expect(stripe.createProratedRefundCreditNote).toHaveBeenCalledOnce()
	expect(stripe.createProratedRefundCreditNote).toHaveBeenCalledWith(
		expect.any(Object),
		{
			invoiceId: 'in_active',
			subscriptionId: 'sub_active',
			lines: [{ invoiceLineItemId: 'il_in_active', amount: 600 }],
			maxRefundMinor: 1201,
			reason: 'order_change',
		},
	)
	expect(stripe.listCreditNotesForInvoice).toHaveBeenCalledWith(
		expect.any(Object),
		'in_active',
	)
	// Refund precedes the cancel of the same subscription so the invoice
	// line's service period is still intact when Stripe prorates tax.
	const creditNoteOrder =
		stripe.createProratedRefundCreditNote.mock.invocationCallOrder[0]!
	const activeCancelIndex = stripe.cancelSubscription.mock.calls.findIndex(
		([, subscriptionId]) => subscriptionId === 'sub_active',
	)
	expect(
		stripe.cancelSubscription.mock.invocationCallOrder[activeCancelIndex]!,
	).toBeGreaterThan(creditNoteOrder)
	expect(
		subscriptionIdsOf(stripe.listPaidInvoicesForSubscription.mock.calls),
	).toEqual(['sub_active', 'sub_trialing'])
	expect(subscriptionIdsOf(stripe.cancelSubscription.mock.calls)).toEqual([
		'sub_active',
		'sub_trialing',
		'sub_past_due',
	])
	expect(result.stripeRefunds).toEqual([
		{
			subscriptionId: 'sub_active',
			amountMinor: 600,
			currency: 'usd',
			invoiceId: 'in_active',
			creditNoteId: 'cn_active',
		},
	])
	expect(user.rows.users).toEqual([])
	expect(result.warnings).toEqual([])
	expect(logAuditEventSpy).toHaveBeenCalledWith({
		db: null,
		category: 'account',
		action: 'account_deletion_refund',
		result: 'success',
		email: 'user-refund@example.com',
		reason: 'usd:600',
	})
	expect(auditEventSummaries()).toEqual(['account_deletion_refund:success'])
})

test('discounts and tax are settled by the credit note preview, not by the gross line fraction', async () => {
	using stripe = spyOnStripeBillingClient(refundPeriodMidpointMs)
	stripe.listSubscriptions.mockResolvedValue([active('sub_promo')])
	// A 50% promotion code: the line's gross amount is $12.00 but the
	// customer paid $6.00. The invoice line's `amount` stays gross.
	const promoLine = { id: 'il_promo', amount: 1200 }
	stripe.listPaidInvoicesForSubscription.mockResolvedValue([
		paidInvoice({
			id: 'in_promo',
			amountPaid: 600,
			lines: [{ ...promoLine, discount_amounts: [{ amount: 600 }] }],
		}),
	])
	// Stripe prorates the discount into the credit note: crediting half the
	// gross line ($6.00) nets $3.00 back to the customer.
	stripe.createProratedRefundCreditNote.mockResolvedValue({
		outcome: 'issued',
		id: 'cn_promo',
		total: 300,
		currency: 'usd',
	})
	const result = await stripeUser('user-promo', 'cus_promo').deleteAccount()

	// The credit note line is the gross fraction; the refund is the total
	// Stripe previewed after applying the line's discount share.
	expect(stripe.createProratedRefundCreditNote).toHaveBeenCalledWith(
		expect.any(Object),
		expect.objectContaining({
			invoiceId: 'in_promo',
			lines: [{ invoiceLineItemId: 'il_promo', amount: 600 }],
		}),
	)
	expect(result.stripeRefunds).toEqual([
		expect.objectContaining({ amountMinor: 300, creditNoteId: 'cn_promo' }),
	])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'account_deletion_refund',
			reason: 'usd:300',
		}),
	)
})

test('every recurring line covering the period is credited on one credit note', async () => {
	using stripe = spyOnStripeBillingClient(refundPeriodMidpointMs)
	stripe.listSubscriptions.mockResolvedValue([active('sub_multi')])
	stripe.listPaidInvoicesForSubscription.mockResolvedValue([
		paidInvoice({
			id: 'in_multi',
			amountPaid: 1500,
			lines: [
				{ id: 'il_plan', amount: 1000 },
				{ id: 'il_addon', amount: 501 },
				// A one-off line for a period that already ended has no unused
				// time and is left alone.
				{
					id: 'il_setup',
					amount: 2000,
					period: {
						start: refundPeriodStart - thirtyDaysSeconds,
						end: refundPeriodStart,
					},
				},
			],
		}),
	])
	stripe.createProratedRefundCreditNote.mockResolvedValue({
		outcome: 'issued',
		id: 'cn_multi',
		total: 750,
		currency: 'usd',
	})
	const result = await stripeUser('user-multi', 'cus_multi').deleteAccount()

	expect(stripe.createProratedRefundCreditNote).toHaveBeenCalledOnce()
	expect(stripe.createProratedRefundCreditNote).toHaveBeenCalledWith(
		expect.any(Object),
		{
			invoiceId: 'in_multi',
			subscriptionId: 'sub_multi',
			lines: [
				{ invoiceLineItemId: 'il_plan', amount: 500 },
				{ invoiceLineItemId: 'il_addon', amount: 250 },
			],
			maxRefundMinor: 1500,
			reason: 'order_change',
		},
	)
	expect(result.stripeRefunds).toEqual([
		expect.objectContaining({ amountMinor: 750, creditNoteId: 'cn_multi' }),
	])
})

/** An undiscounted, untaxed invoice: the credit note total is the gross sum. */
function previewGrossSum(lineAmounts: Array<number>) {
	return lineAmounts.reduce((sum, amount) => sum + amount, 0)
}

/**
 * Stubs the credit note preview and create endpoints so the real
 * `createProratedRefundCreditNote` runs against the cap logic. `previewTotal`
 * stands in for Stripe's prorating of each line's discounts and tax into the
 * note; the stub is swapped per case through the returned setter.
 */
function stubStripeCreditNoteEndpoints() {
	const previews: Array<Record<string, string>> = []
	const creates: Array<Record<string, string>> = []
	let previewTotal = previewGrossSum
	const json = (body: unknown) =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			const parsed = new URL(url)
			if (parsed.pathname === '/v1/credit_notes/preview') {
				const query = Object.fromEntries(parsed.searchParams)
				previews.push(query)
				const total = previewTotal(
					Object.entries(query)
						.filter(([key]) => /^lines\[\d+\]\[amount\]$/.test(key))
						.map(([, value]) => Number(value)),
				)
				return json({ object: 'credit_note', total, currency: 'usd' })
			}
			if (parsed.pathname === '/v1/credit_notes' && init?.method === 'POST') {
				const form = Object.fromEntries(
					new URLSearchParams(init.body as string),
				)
				creates.push(form)
				return json({
					id: `cn_${creates.length}`,
					object: 'credit_note',
					invoice: form.invoice,
					total: Number(form.refund_amount),
					currency: 'usd',
					status: 'issued',
					metadata: {
						kody_account_deletion: '1',
						kody_subscription_id: form['metadata[kody_subscription_id]'],
					},
				})
			}
			throw new Error(`Unexpected Stripe request: ${init?.method} ${url}`)
		}),
	)
	return {
		previews,
		creates,
		previewLineAmounts: () =>
			previews.map((preview) => Number(preview['lines[0][amount]'])),
		setPreviewTotal(next: (lineAmounts: Array<number>) => number) {
			previewTotal = next
		},
	}
}

/**
 * A 50% promotion code plus 10% exclusive tax, rounded the way per-line
 * prorating can round: the discount down, the tax up. Scaling the gross line
 * by `cap / total` then lands the next preview a unit above the cap, which is
 * what the cap-fitting loop has to absorb.
 */
function previewHalfOffPlusTax(lineAmounts: Array<number>) {
	return lineAmounts.reduce((sum, amount) => {
		const net = amount - Math.floor(amount * 0.5)
		return sum + net + Math.ceil(net * 0.1)
	}, 0)
}

function upgradeInvoice() {
	// Portal upgrades bill with `always_invoice`: the new plan for the rest of
	// the period plus a negative unused-time credit for the old plan, so the
	// customer paid the 1700 net rather than the 2900 line.
	return paidInvoice({
		id: 'in_upgrade',
		amountPaid: 1700,
		lines: [
			{ id: 'il_pro', amount: 2900 },
			{ id: 'il_standard_credit', amount: -1200 },
		],
	})
}

/** 90% of the refund period is still unused. */
const refundPeriodTenthMs = (refundPeriodStart + thirtyDaysSeconds * 0.1) * 1000

const supportNote = (id: string, invoice: string, total: number) =>
	kodyCreditNote({ id, invoice, total, marker: false })

test('an invoice never refunds more than it was paid net of earlier credit notes', async () => {
	using stripe = spyOnStripeBillingClient(refundPeriodMidpointMs)
	stripe.createProratedRefundCreditNote.mockRestore()
	const stripeHttp = stubStripeCreditNoteEndpoints()
	stripe.listSubscriptions.mockResolvedValue([active('sub_capped')])
	const cases: Array<{
		stableUserId: string
		nowMs?: number
		invoice: ReturnType<typeof paidInvoice>
		creditNotes?: Array<ReturnType<typeof kodyCreditNote>>
		previewTotal?: (lineAmounts: Array<number>) => number
		/** The `lines[0][amount]` of every preview, in order. */
		expectedPreviews: Array<number>
		/** `[lines[0][amount], refund_amount]` of the created note. */
		expectedCreate: [number, number] | null
	}> = [
		// (a) Upgrade invoice, half the period remaining:
		// floor(2900 * 15d / 30d) = 1450 fits under the 1700 net.
		{
			stableUserId: ownerIdFromStored('user-cap-fits'),
			invoice: upgradeInvoice(),
			expectedPreviews: [1450],
			expectedCreate: [1450, 1450],
		},
		// (b) Upgrade invoice, 90% remaining: floor(2900 * 27d / 30d) = 2610
		// exceeds the 1700 net, so the line is scaled by 1700 / 2610 and
		// previewed again.
		{
			stableUserId: ownerIdFromStored('user-cap-scaled'),
			nowMs: refundPeriodTenthMs,
			invoice: upgradeInvoice(),
			expectedPreviews: [2610, 1700],
			expectedCreate: [1700, 1700],
		},
		// (c) Support already credited 1000 of the 1200 paid, by any issuer, so
		// only 200 is left to give back.
		{
			stableUserId: ownerIdFromStored('user-cap-prior-note'),
			invoice: paidInvoice({ id: 'in_prior', amountPaid: 1200 }),
			creditNotes: [supportNote('cn_support', 'in_prior', 1000)],
			expectedPreviews: [600, 200],
			expectedCreate: [200, 200],
		},
		// (d) Earlier notes already consumed everything paid; a voided note
		// does not count against the cap.
		{
			stableUserId: ownerIdFromStored('user-cap-exhausted'),
			invoice: paidInvoice({ id: 'in_exhausted', amountPaid: 1200 }),
			creditNotes: [
				supportNote('cn_support_a', 'in_exhausted', 700),
				supportNote('cn_support_b', 'in_exhausted', 500),
				kodyCreditNote({
					id: 'cn_voided',
					invoice: 'in_exhausted',
					total: 300,
					status: 'void',
					marker: false,
				}),
			],
			expectedPreviews: [],
			expectedCreate: null,
		},
		// (e) A 50%-off promotion code with 10% tax: the 2900 line was paid as
		// (2900 - 1450) * 1.1 = 1595, and support already credited 945, so the
		// cap is 650. The half-period line (1450) previews at 798; scaling it
		// by 650 / 798 gives 1181, whose preview rounds to 651 — one over the
		// cap — so the loop scales by 650 / 651 once more to 1179, which
		// previews at 649 and is issued. The gross line and the net,
		// tax-inclusive preview only ever meet as a ratio.
		{
			stableUserId: ownerIdFromStored('user-cap-promo-tax'),
			invoice: paidInvoice({
				id: 'in_promo_tax',
				amountPaid: 1595,
				lines: [
					{ id: 'il_pro', amount: 2900, discount_amounts: [{ amount: 1450 }] },
				],
			}),
			creditNotes: [supportNote('cn_support_promo', 'in_promo_tax', 945)],
			previewTotal: previewHalfOffPlusTax,
			expectedPreviews: [1450, 1181, 1179],
			expectedCreate: [1179, 649],
		},
	]
	for (const testCase of cases) {
		vi.setSystemTime(new Date(testCase.nowMs ?? refundPeriodMidpointMs))
		stripe.listPaidInvoicesForSubscription.mockResolvedValue([testCase.invoice])
		stripe.listCreditNotesForInvoice.mockResolvedValue(
			testCase.creditNotes ?? [],
		)
		stripe.cancelSubscription.mockClear()
		stripeHttp.setPreviewTotal(testCase.previewTotal ?? previewGrossSum)
		stripeHttp.previews.length = 0
		stripeHttp.creates.length = 0
		const user = stripeUser(testCase.stableUserId, 'cus_capped', {
			STRIPE_SECRET_KEY: 'sk_test_secret',
		})
		const result = await user.deleteAccount()

		expect(stripeHttp.previewLineAmounts()).toEqual(testCase.expectedPreviews)
		if (testCase.expectedCreate === null) {
			expect(stripeHttp.creates).toEqual([])
			expect(result.stripeRefunds).toEqual([])
		} else {
			const [lineAmount, refundAmount] = testCase.expectedCreate
			// Only the positive line is ever credited.
			expect(stripeHttp.creates).toEqual([
				expect.objectContaining({
					invoice: testCase.invoice.id,
					'lines[0][invoice_line_item]': testCase.invoice.lines.data[0]!.id,
					'lines[0][amount]': String(lineAmount),
					refund_amount: String(refundAmount),
				}),
			])
			expect(stripeHttp.creates[0]).not.toHaveProperty('lines[1][amount]')
			expect(result.stripeRefunds).toEqual([
				expect.objectContaining({
					invoiceId: testCase.invoice.id,
					amountMinor: refundAmount,
				}),
			])
		}
		expect(stripe.cancelSubscription).toHaveBeenCalledWith(
			expect.any(Object),
			'sub_capped',
		)
		expect(user.rows.users).toEqual([])
		expect(result.warnings).toEqual([])
	}
})

test('a refund that cannot be bounded is skipped with an audit row and the deletion still completes', async () => {
	// 90% of the period left on the upgrade invoice: 2610 against a 1700
	// cap. A preview that stays above the cap however far the line shrinks
	// (Stripe's minimum, a rounding floor, a stub) must not block deletion:
	// a missing refund on an edge is a support ticket, a blocked deletion is
	// a broken promise in the other direction.
	using stripe = spyOnStripeBillingClient(refundPeriodTenthMs)
	stripe.createProratedRefundCreditNote.mockRestore()
	const stripeHttp = stubStripeCreditNoteEndpoints()
	consoleWarn.mockImplementation(() => {})
	stripe.listSubscriptions.mockResolvedValue([active('sub_unfittable')])
	stripe.listPaidInvoicesForSubscription.mockResolvedValue([upgradeInvoice()])
	stripeHttp.setPreviewTotal(() => 1701)
	const user = stripeUser('user-refund-unfittable', 'cus_unfittable', {
		STRIPE_SECRET_KEY: 'sk_test_secret',
	})
	const result = await user.deleteAccount()

	// Every pass scales the gross line by cap / preview, then gives up after
	// the attempt budget without issuing anything.
	expect(stripeHttp.previewLineAmounts()).toEqual([
		2610, 2608, 2606, 2604, 2602, 2600, 2598,
	])
	expect(stripeHttp.creates).toEqual([])
	expect(consoleWarn).toHaveBeenCalledWith(
		'account_deletion_refund_unfittable',
		{
			invoiceId: 'in_upgrade',
			amountPaid: 1700,
			maxRefundMinor: 1700,
			lastPreviewMinor: 1701,
		},
	)
	expect(auditEventSummaries()).toEqual([
		'account_deletion_refund_skipped:failure',
	])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'account_deletion_refund_skipped',
			result: 'failure',
			email: 'user-refund-unfittable@example.com',
			reason: 'unfittable:usd:1700',
		}),
	)
	// Nothing refunded for that invoice; the cancel and the deletion went
	// ahead.
	expect(result.stripeRefunds).toEqual([])
	expect(stripe.cancelSubscription).toHaveBeenCalledWith(
		expect.any(Object),
		'sub_unfittable',
	)
	expect(stripe.deleteCustomer).toHaveBeenCalledWith(
		expect.any(Object),
		'cus_unfittable',
	)
	expect(result.warnings).toEqual([])
	expect(user.rows.users).toEqual([])
	expect(user.rows.mcp_memories).toEqual([])
})

test('an invoice whose credit notes cannot be listed completely is not refunded and the deletion still completes', async () => {
	using stripe = spyOnStripeBillingClient(refundPeriodMidpointMs)
	consoleWarn.mockImplementation(() => {})
	stripe.listSubscriptions.mockResolvedValue([active('sub_endless')])
	stripe.listPaidInvoicesForSubscription.mockResolvedValue([
		paidInvoice({ id: 'in_endless', amountPaid: 1200 }),
	])
	// The cap is amount_paid minus what was already credited; when the
	// listing is too long to trust, the remainder is unknown and the only
	// safe cap is zero.
	stripe.listCreditNotesForInvoice.mockRejectedValue(
		new stripeClient.StripeCreditNoteListIncompleteError(
			stripeClient.creditNoteListMaxPages,
		),
	)
	const user = stripeUser('user-credit-notes-endless', 'cus_endless')
	const result = await user.deleteAccount()

	expect(stripe.createProratedRefundCreditNote).not.toHaveBeenCalled()
	expect(consoleWarn).toHaveBeenCalledWith(
		'account_deletion_refund_credit_notes_incomplete',
		{
			subscriptionId: 'sub_endless',
			invoiceId: 'in_endless',
			amountPaid: 1200,
			pages: stripeClient.creditNoteListMaxPages,
		},
	)
	expect(auditEventSummaries()).toEqual([
		'account_deletion_refund_skipped:failure',
	])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'account_deletion_refund_skipped',
			result: 'failure',
			email: 'user-credit-notes-endless@example.com',
			reason: 'credit_notes_incomplete:in_endless',
		}),
	)
	expect(result.stripeRefunds).toEqual([])
	expect(stripe.cancelSubscription).toHaveBeenCalledWith(
		expect.any(Object),
		'sub_endless',
	)
	expect(result.warnings).toEqual([])
	expect(user.rows.users).toEqual([])
})

test('a failed credit note retains the account, releases the fence, and cancels nothing', async () => {
	using stripe = spyOnStripeBillingClient(refundPeriodMidpointMs)
	consoleError.mockImplementation(() => {})
	consoleWarn.mockImplementation(() => {})
	stripe.listSubscriptions.mockResolvedValue([active('sub_active')])
	stripe.listPaidInvoicesForSubscription.mockResolvedValue([
		paidInvoice({ id: 'in_active', amountPaid: 1200 }),
	])
	const http400 = 'Stripe API request failed with HTTP 400.'
	const cases: Array<[string, Error]> = [
		// Network or 5xx failure.
		['user-refund-fails', new Error('Stripe credit note rejected')],
		// The amount exceeding what Stripe will credit means Kody's math
		// disagrees with the invoice; that is never silently "nothing to
		// refund".
		[
			'user-refund-exceeds',
			new stripeClient.StripeApiError(http400, {
				status: 400,
				stripeMessage:
					'The credit note amount exceeds the maximum creditable amount for this invoice.',
			}),
		],
	]
	for (const [stableUserId, error] of cases) {
		stripe.createProratedRefundCreditNote.mockRejectedValue(error)
		stripe.cancelSubscription.mockClear()
		stripe.deleteCustomer.mockClear()
		await expectBillingFailureRetainsAccount(
			stripeUser(stableUserId, 'cus_refund_fails'),
			{
				stableUserId,
				customerId: 'cus_refund_fails',
				billingErrors: [
					`Stripe subscription sub_active unused time could not be refunded: ${error.message}`,
				],
			},
		)
		// The subscription stays active so the retry can refund it.
		expect(stripe.cancelSubscription).not.toHaveBeenCalled()
		expect(stripe.deleteCustomer).not.toHaveBeenCalled()
		expect(auditEventSummaries()).toEqual([])
		// The rejection is logged with ids and amounts only, so a repeat can
		// be reconciled against the Stripe dashboard.
		expect(consoleWarn).toHaveBeenCalledWith(
			'account_deletion_refund_rejected',
			{
				subscriptionId: 'sub_active',
				invoiceId: 'in_active',
				amountPaid: 1200,
				maxRefundMinor: 1200,
				requestedMinor: 600,
				error: error.message,
			},
		)
	}
})

test('a retried deletion reuses its earlier credit note and reports refunds from earlier attempts', async () => {
	using stripe = spyOnStripeBillingClient(refundPeriodMidpointMs)
	// Retry: the first attempt refunded and canceled sub_done, refunded
	// sub_retry but failed before canceling it, and never reached sub_new.
	stripe.listSubscriptions.mockResolvedValue([
		stripeSubscription('sub_done', 'canceled'),
		active('sub_retry'),
		active('sub_new'),
	])
	stripe.listPaidInvoicesForSubscription.mockImplementation(
		async (_env, subscriptionId) => [
			paidInvoice({ id: `in_${subscriptionId}`, amountPaid: 1200 }),
		],
	)
	const note = (
		id: string,
		subscriptionId: string,
		total: number,
		extra: { status?: string; marker?: boolean; linked?: boolean } = {},
	) =>
		kodyCreditNote({
			id,
			invoice: `in_${subscriptionId}`,
			total,
			status: extra.status,
			marker: extra.marker,
			subscriptionId: extra.linked === false ? undefined : subscriptionId,
		})
	stripe.listCreditNotesForInvoice.mockImplementation(
		async (_env, invoiceId) =>
			invoiceId === 'in_sub_retry'
				? [
						// Voided notes and notes without the metadata marker (even
						// with Kody's memo text) are never treated as ours.
						note('cn_voided', 'sub_retry', 600, { status: 'void' }),
						{
							id: 'cn_support',
							invoice: 'in_sub_retry',
							total: 100,
							currency: 'usd',
							status: 'issued',
							metadata: { memo: stripeClient.accountDeletionCreditNoteMemo },
						},
						note('cn_retry_earlier', 'sub_retry', 600),
					]
				: [],
	)
	stripe.createProratedRefundCreditNote.mockResolvedValue({
		outcome: 'issued',
		id: 'cn_new',
		total: 600,
		currency: 'usd',
	})
	stripe.listCreditNotesForCustomer.mockResolvedValue([
		note('cn_new', 'sub_new', 600),
		note('cn_retry_earlier', 'sub_retry', 600),
		note('cn_done_earlier', 'sub_done', 450),
		note('cn_done_voided', 'sub_done', 450, { status: 'void', linked: false }),
		note('cn_manual', 'sub_done', 100, { marker: false, linked: false }),
	])
	const user = stripeUser('user-refund-retry', 'cus_refund_retry')
	const result = await user.deleteAccount()

	// Only sub_new gets a new credit note; sub_retry reuses its earlier one.
	expect(stripe.createProratedRefundCreditNote).toHaveBeenCalledOnce()
	expect(stripe.createProratedRefundCreditNote).toHaveBeenCalledWith(
		expect.any(Object),
		expect.objectContaining({ invoiceId: 'in_sub_new' }),
	)
	expect(subscriptionIdsOf(stripe.cancelSubscription.mock.calls)).toEqual([
		'sub_retry',
		'sub_new',
	])
	expect(stripe.listCreditNotesForCustomer).toHaveBeenCalledWith(
		expect.any(Object),
		'cus_refund_retry',
	)
	const refund = (subscriptionId: string, amountMinor: number, id: string) => ({
		subscriptionId,
		amountMinor,
		currency: 'usd',
		invoiceId: `in_${subscriptionId}`,
		creditNoteId: id,
	})
	expect(result.stripeRefunds).toEqual([
		refund('sub_retry', 600, 'cn_retry_earlier'),
		refund('sub_new', 600, 'cn_new'),
		refund('sub_done', 450, 'cn_done_earlier'),
	])
	expect(user.rows.users).toEqual([])
	// Only the newly issued refund is audited; earlier attempts already did.
	expect(auditEventSummaries()).toEqual(['account_deletion_refund:success'])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({ reason: 'usd:600' }),
	)

	// The customer-wide listing only completes the report; when it fails the
	// deletion still finishes with what this run knows.
	stripe.listCreditNotesForCustomer.mockRejectedValue(
		new Error('Stripe credit notes unavailable'),
	)
	consoleWarn.mockImplementation(() => {})
	const partial = stripeUser(
		'user-refund-partial-report',
		'cus_refund_partial_report',
	)
	const partialResult = await partial.deleteAccount()
	expect(partial.rows.users).toEqual([])
	expect(partialResult.warnings).toEqual([])
	expect(
		partialResult.stripeRefunds.map((refund) => refund.creditNoteId),
	).toEqual(['cn_retry_earlier', 'cn_new'])
	expect(consoleWarn).toHaveBeenCalledWith(
		'account_deletion_refund_report_incomplete',
		{ error: 'Stripe credit notes unavailable' },
	)
})

test('a subscription that is already canceled counts as canceled so retried deletions proceed', async () => {
	using stripe = spyOnStripeBillingClient()
	// Retry after an earlier attempt already canceled everything: Stripe
	// lists the subscription as canceled, so nothing is canceled again.
	stripe.listSubscriptions.mockResolvedValue([
		stripeSubscription('sub_old', 'canceled'),
	])
	const retry = stripeUser('user-retry', 'cus_retry')
	const retryResult = await retry.deleteAccount()
	expect(stripe.cancelSubscription).not.toHaveBeenCalled()
	expect(retry.rows.users).toEqual([])
	expect(retryResult.warnings).toEqual([])

	// The cancel call errors (for example Stripe raced the cancellation) but
	// a fresh listing shows the subscription is no longer billable.
	stripe.listSubscriptions
		.mockReset()
		.mockResolvedValueOnce([active('sub_racing')])
		.mockResolvedValueOnce([stripeSubscription('sub_racing', 'canceled')])
	stripe.cancelSubscription.mockRejectedValue(
		new Error('Stripe API request failed with HTTP 400.'),
	)
	const race = stripeUser('user-race', 'cus_race')
	const raceResult = await race.deleteAccount()
	expect(stripe.cancelSubscription).toHaveBeenCalledWith(
		expect.any(Object),
		'sub_racing',
	)
	expect(stripe.listSubscriptions).toHaveBeenCalledTimes(2)
	expect(race.rows.users).toEqual([])
	expect(raceResult.warnings).toEqual([])
	expect(stripe.deleteCustomer).toHaveBeenCalledWith(
		expect.any(Object),
		'cus_race',
	)
})

test('a $0 proration invoice on top does not hide the paid invoice that covers the period', async () => {
	using stripe = spyOnStripeBillingClient(refundPeriodMidpointMs)
	stripe.listSubscriptions.mockResolvedValue([active('sub_downgraded')])
	const changed = {
		start: refundPeriodStart + thirtyDaysSeconds / 3,
		end: refundPeriodEnd,
	}
	const previousPeriod = {
		start: refundPeriodStart - thirtyDaysSeconds,
		end: refundPeriodStart,
	}
	// Newest first, as Stripe lists them: the downgrade netted to $0, then
	// an old invoice for a period that already ended, then the real payment.
	stripe.listPaidInvoicesForSubscription.mockResolvedValue([
		paidInvoice({
			id: 'in_downgrade',
			amountPaid: 0,
			lines: [
				{ id: 'il_new_plan', amount: 400, period: changed },
				{ id: 'il_old_plan_credit', amount: -800, period: changed },
			],
		}),
		paidInvoice({
			id: 'in_previous_period',
			amountPaid: 1200,
			lines: [{ id: 'il_previous', amount: 1200, period: previousPeriod }],
		}),
		paidInvoice({ id: 'in_current', amountPaid: 1200 }),
	])
	stripe.createProratedRefundCreditNote.mockResolvedValue({
		outcome: 'issued',
		id: 'cn_current',
		total: 600,
		currency: 'usd',
	})
	const result = await stripeUser(
		'user-downgraded',
		'cus_downgraded',
	).deleteAccount()

	expect(stripe.createProratedRefundCreditNote).toHaveBeenCalledOnce()
	expect(stripe.createProratedRefundCreditNote).toHaveBeenCalledWith(
		expect.any(Object),
		expect.objectContaining({
			invoiceId: 'in_current',
			lines: [{ invoiceLineItemId: 'il_in_current', amount: 600 }],
		}),
	)
	expect(stripe.listCreditNotesForInvoice).toHaveBeenCalledWith(
		expect.any(Object),
		'in_current',
	)
	expect(result.stripeRefunds).toEqual([
		expect.objectContaining({
			invoiceId: 'in_current',
			creditNoteId: 'cn_current',
		}),
	])

	// With no paid invoice covering the running period at all, nothing is
	// refunded and the cancel still proceeds.
	stripe.createProratedRefundCreditNote.mockClear()
	stripe.listPaidInvoicesForSubscription.mockResolvedValue([
		paidInvoice({
			id: 'in_only_previous',
			amountPaid: 1200,
			lines: [{ id: 'il_only_previous', amount: 1200, period: previousPeriod }],
		}),
	])
	const expired = stripeUser('user-expired-period', 'cus_expired_period')
	const expiredResult = await expired.deleteAccount()
	expect(stripe.createProratedRefundCreditNote).not.toHaveBeenCalled()
	expect(expiredResult.stripeRefunds).toEqual([])
	expect(expired.rows.users).toEqual([])
})

test('an invoice with nothing left to refund is canceled without a refund', async () => {
	using stripe = spyOnStripeBillingClient(refundPeriodMidpointMs)
	stripe.listSubscriptions.mockResolvedValue([active('sub_active')])
	stripe.listPaidInvoicesForSubscription.mockResolvedValue([
		paidInvoice({ id: 'in_active', amountPaid: 1200 }),
	])
	const alreadyRefunded = (details: Record<string, unknown>) =>
		stripe.createProratedRefundCreditNote.mockRejectedValue(
			new stripeClient.StripeApiError(
				'Stripe API request failed with HTTP 400.',
				{ status: 400, ...details },
			),
		)
	const cases: Array<[string, () => void]> = [
		// A 100% discounted line previews to a $0 credit note; the client
		// reports that instead of creating an empty note.
		[
			'user-refund-zero',
			() =>
				stripe.createProratedRefundCreditNote.mockResolvedValue({
					outcome: 'nothing_to_refund',
				}),
		],
		// Support already refunded the charge by hand, outside a credit note,
		// so Stripe refuses a second refund (coded, then message only).
		[
			'user-refund-coded',
			() => alreadyRefunded({ code: 'charge_already_refunded' }),
		],
		[
			'user-refund-message',
			() =>
				alreadyRefunded({
					stripeMessage:
						'The charge for this invoice has already been fully refunded.',
				}),
		],
	]
	for (const [stableUserId, arrange] of cases) {
		stripe.createProratedRefundCreditNote.mockReset()
		stripe.cancelSubscription.mockClear()
		arrange()
		const user = stripeUser(stableUserId, 'cus_nothing_left')
		const result = await user.deleteAccount()

		expect(stripe.createProratedRefundCreditNote).toHaveBeenCalledOnce()
		expect(stripe.cancelSubscription).toHaveBeenCalledWith(
			expect.any(Object),
			'sub_active',
		)
		expect(result.stripeRefunds).toEqual([])
		expect(result.warnings).toEqual([])
		expect(user.rows.users).toEqual([])
		expect(auditEventSummaries()).toEqual([])
	}
})
