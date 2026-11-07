import type {
	StripeCreditNote,
	StripeInvoiceLineItem,
	StripePaidInvoice,
} from './stripe-client.ts'

/**
 * Unused-time refund for one invoice line, in the smallest currency unit:
 * `floor(lineAmount * (periodEnd - now) / (periodEnd - periodStart))`. Zero
 * when the period has already ended, has no length, or the line was free.
 *
 * `lineAmount` is the line's gross amount (before discounts and exclusive
 * tax), so this is the gross amount to credit, not what the customer gets
 * back: Stripe prorates the line's discounts and tax into the credit note and
 * the previewed total is what is refunded.
 */
export function computeProratedRefundMinor(input: {
	lineAmount: number
	periodStart: number
	periodEnd: number
	nowSeconds: number
}) {
	const periodLength = input.periodEnd - input.periodStart
	const remaining = input.periodEnd - input.nowSeconds
	if (input.lineAmount <= 0 || periodLength <= 0 || remaining <= 0) return 0
	const unusedFraction = Math.min(1, remaining / periodLength)
	return Math.floor(input.lineAmount * unusedFraction)
}

/**
 * Every positive invoice line whose service period covers `now`. A mid-cycle
 * upgrade invoice also carries a negative proration credit for the old price,
 * which cannot be credited again; lines for periods that already ended (or
 * have not started) have no unused time.
 */
export function selectRefundableInvoiceLines(
	invoice: StripePaidInvoice,
	nowSeconds: number,
): Array<StripeInvoiceLineItem> {
	return invoice.lines.data.filter(
		(line) =>
			line.amount > 0 &&
			line.period.start <= nowSeconds &&
			line.period.end > nowSeconds,
	)
}

/**
 * Walks the subscription's recent paid invoices, newest first, to the first
 * one that both took money and still has a line covering `now`. The newest
 * paid invoice is often a $0 proration invoice (a downgrade) with nothing to
 * give back; the real payment for the running period sits behind it.
 */
export function selectRefundableInvoice(
	invoices: ReadonlyArray<StripePaidInvoice>,
	nowSeconds: number,
) {
	for (const invoice of invoices) {
		if (invoice.amount_paid <= 0) continue
		const lines = selectRefundableInvoiceLines(invoice, nowSeconds)
		if (lines.length > 0) return { invoice, lines }
	}
	return null
}

/**
 * The most an invoice can still give back: what was actually paid minus every
 * credit note already issued against it, by anyone. A mid-cycle upgrade
 * invoice (portal upgrades use `always_invoice`) carries a positive new-plan
 * line plus a negative unused-time credit for the old plan, so `amount_paid`
 * is the net and the unused fraction of the positive line alone can exceed
 * it; Stripe would reject that credit note.
 */
export function computeMaxRefundMinor(
	invoice: StripePaidInvoice,
	creditNotes: ReadonlyArray<StripeCreditNote>,
) {
	const credited = creditNotes
		.filter((creditNote) => creditNote.status === 'issued')
		.reduce((sum, creditNote) => sum + creditNote.total, 0)
	return invoice.amount_paid - credited
}
