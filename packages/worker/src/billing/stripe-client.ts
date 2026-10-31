/**
 * Minimal Stripe REST client (no SDK). Calls https://api.stripe.com/v1
 * (overridable via STRIPE_API_BASE_URL) with Bearer STRIPE_SECRET_KEY.
 * Responses are validated with remix/data-schema; only the fields Kody
 * needs are parsed.
 */
import {
	array,
	boolean,
	nullable,
	number,
	object,
	optional,
	parseSafe,
	record,
	string,
	type InferOutput,
} from 'remix/data-schema'

const defaultStripeApiBaseUrl = 'https://api.stripe.com'

export class StripeApiError extends Error {
	readonly status: number
	/** Stripe `error.code` (for example `resource_missing`) when the body had one. */
	readonly code: string | null
	/**
	 * Stripe `error.message` when the body had one. Many credit-note and refund
	 * validation failures come back as a bare `invalid_request_error` with no
	 * `code`, so callers that need to classify them read this instead. Never
	 * logged: it can embed object ids.
	 */
	readonly stripeMessage: string | null
	constructor(
		message: string,
		options: {
			status: number
			code?: string | null
			stripeMessage?: string | null
			cause?: unknown
		},
	) {
		super(message, { cause: options.cause })
		this.name = 'StripeApiError'
		this.status = options.status
		this.code = options.code ?? null
		this.stripeMessage = options.stripeMessage ?? null
	}
}

const stripeErrorBodySchema = object({
	error: object({ code: optional(string()), message: optional(string()) }),
})

function readStripeErrorBody(body: unknown): {
	code: string | null
	message: string | null
} {
	const parsed = parseSafe(stripeErrorBodySchema, body)
	if (!parsed.success) return { code: null, message: null }
	return {
		code: parsed.value.error.code ?? null,
		message: parsed.value.error.message ?? null,
	}
}

export class BillingNotConfiguredError extends Error {
	constructor() {
		super('Stripe billing is not configured on this deployment.')
		this.name = 'BillingNotConfiguredError'
	}
}

export type StripeEnv = {
	STRIPE_SECRET_KEY?: string
	STRIPE_API_BASE_URL?: string
}

const updatedSubscriptionItemSchema = object({
	id: string(),
	quantity: optional(number()),
})

const checkoutSessionSchema = object({
	id: string(),
	customer: nullable(string()),
	client_reference_id: nullable(string()),
	metadata: optional(nullable(record(string(), string()))),
})

const createdCheckoutSessionSchema = object({
	id: string(),
	url: nullable(string()),
})

const subscriptionItemSchema = object({
	id: optional(string()),
	quantity: optional(number()),
	price: object({
		id: string(),
	}),
	current_period_end: optional(nullable(number())),
})

const subscriptionSchema = object({
	id: string(),
	status: string(),
	cancel_at: nullable(number()),
	current_period_end: optional(nullable(number())),
	metadata: optional(record(string(), string())),
	items: object({
		data: array(subscriptionItemSchema),
	}),
})

const subscriptionListSchema = object({
	data: array(subscriptionSchema),
})

const billingPortalSessionSchema = object({
	url: string(),
})

const canceledSubscriptionSchema = object({
	id: string(),
	status: string(),
})

const deletedCustomerSchema = object({
	id: string(),
	deleted: boolean(),
})

/** Marks historical compute-overage invoices (invoicing is retired). */
export const computeOverageInvoiceMetadataKey = 'kody_compute_overage'

// `amount` is the line's gross amount before discounts and before exclusive
// tax; `discount_amounts` is only parsed so callers can see it exists. A
// credit note issued against the line credits those discounts and taxes
// proportionally, so the refundable value is whatever Stripe previews, never
// this raw number.
const invoiceLineItemSchema = object({
	id: string(),
	amount: number(),
	period: object({
		start: number(),
		end: number(),
	}),
	discount_amounts: optional(array(object({ amount: number() }))),
})

const paidInvoiceSchema = object({
	id: string(),
	amount_paid: number(),
	currency: string(),
	lines: object({
		data: array(invoiceLineItemSchema),
	}),
})

const paidInvoiceListSchema = object({
	data: array(paidInvoiceSchema),
})

const creditNoteSchema = object({
	id: string(),
	invoice: string(),
	total: number(),
	currency: string(),
	status: string(),
	metadata: optional(record(string(), string())),
})

const creditNoteListSchema = object({
	data: array(creditNoteSchema),
	has_more: boolean(),
})

// A preview is a credit note that was never persisted, so nothing about its
// identity is trusted; only the computed totals matter.
const creditNotePreviewSchema = object({
	total: number(),
	currency: string(),
})

export type StripeCheckoutSession = InferOutput<typeof checkoutSessionSchema>
export type StripeSubscription = InferOutput<typeof subscriptionSchema>

/** Seat count on a subscription line item (defaults to 1). */
export function subscriptionItemSeatQuantity(
	item: StripeSubscription['items']['data'][number],
): number {
	const quantity = item.quantity
	if (
		typeof quantity === 'number' &&
		Number.isFinite(quantity) &&
		quantity >= 1
	) {
		return Math.floor(quantity)
	}
	return 1
}

/** Newest period end from subscription items, then the top-level field. */
export function readStripeSubscriptionPeriodEndUnix(
	subscription: StripeSubscription,
): number | null {
	let latest: number | null = null
	for (const item of subscription.items.data) {
		const end = item.current_period_end
		if (typeof end === 'number' && Number.isFinite(end) && end > 0) {
			if (latest == null || end > latest) latest = end
		}
	}
	const top = subscription.current_period_end
	if (typeof top === 'number' && Number.isFinite(top) && top > 0) {
		if (latest == null || top > latest) latest = top
	}
	return latest
}
export type StripePaidInvoice = InferOutput<typeof paidInvoiceSchema>
export type StripeInvoiceLineItem = InferOutput<typeof invoiceLineItemSchema>
export type StripeCreditNote = InferOutput<typeof creditNoteSchema>

/**
 * Marks credit notes Kody issues during account deletion so a retried
 * deletion can find the earlier one instead of refunding twice, and so the
 * deletion report can list every note Kody issued for the customer.
 * `accountDeletionCreditNoteSubscriptionMetadataKey` records which
 * subscription the note refunded, since Stripe credit notes only reference the
 * invoice.
 */
export const accountDeletionCreditNoteMetadataKey = 'kody_account_deletion'
export const accountDeletionCreditNoteSubscriptionMetadataKey =
	'kody_subscription_id'
export const accountDeletionCreditNoteMemo =
	'Prorated refund for unused time after account deletion'

/**
 * Only the metadata marker counts. The memo is customer-facing text that a
 * support agent could reuse on a manual credit note, so it is never treated
 * as proof that Kody issued the note.
 */
export function isAccountDeletionCreditNote(creditNote: StripeCreditNote) {
	return (
		creditNote.status === 'issued' &&
		creditNote.metadata?.[accountDeletionCreditNoteMetadataKey] === '1'
	)
}

/**
 * Stripe reports an invoice whose charge was already refunded in full (for
 * example by support, outside a credit note) either with the
 * `charge_already_refunded` code or as a bare `invalid_request_error` whose
 * message says so. Account deletion treats that as "nothing left to refund".
 * Any other rejection — including an amount that merely exceeds what is
 * creditable, which means Kody's math disagrees with Stripe — is a billing
 * failure that must retain the account.
 */
export function isStripeNothingToRefundError(error: unknown) {
	if (!(error instanceof StripeApiError)) return false
	if (error.code === 'charge_already_refunded') return true
	if (error.status !== 400 || !error.stripeMessage) return false
	return /(?:already|fully) (?:been )?(?:fully )?(?:refunded|credited)/i.test(
		error.stripeMessage,
	)
}

/**
 * Stripe rejects a reused idempotency key when the new request body does not
 * match the first request (for example after billing metadata keys changed).
 */
export function isStripeIdempotencyParameterMismatchError(error: unknown) {
	if (!(error instanceof StripeApiError)) return false
	if (error.status !== 400 || !error.stripeMessage) return false
	return /can only be used with the same parameters/i.test(error.stripeMessage)
}

function resolveStripeApiBaseUrl(env: StripeEnv) {
	return (env.STRIPE_API_BASE_URL?.trim() || defaultStripeApiBaseUrl).replace(
		/\/$/,
		'',
	)
}

function requireStripeSecretKey(env: StripeEnv) {
	const key = env.STRIPE_SECRET_KEY?.trim()
	if (!key) throw new BillingNotConfiguredError()
	return key
}

async function stripeRequest(
	env: StripeEnv,
	input: {
		method: 'DELETE' | 'GET' | 'POST'
		path: string
		query?: Record<string, string>
		form?: Record<string, string>
		idempotencyKey?: string
	},
): Promise<unknown> {
	const secretKey = requireStripeSecretKey(env)
	const url = new URL(`${resolveStripeApiBaseUrl(env)}${input.path}`)
	if (input.query) {
		for (const [key, value] of Object.entries(input.query)) {
			url.searchParams.set(key, value)
		}
	}

	const headers: Record<string, string> = {
		accept: 'application/json',
		authorization: `Bearer ${secretKey}`,
	}
	const idempotencyKey = input.idempotencyKey?.trim()
	if (idempotencyKey) {
		headers['idempotency-key'] = idempotencyKey
	}

	const init: RequestInit = {
		method: input.method,
		headers,
		// A hung Stripe endpoint must not block billing page loads, portal
		// redirects, or the sequential cron sweep.
		signal: AbortSignal.timeout(10_000),
	}

	if (input.method === 'POST' && input.form) {
		headers['content-type'] = 'application/x-www-form-urlencoded'
		init.body = new URLSearchParams(input.form).toString()
	}

	const response = await fetch(url.toString(), init)
	const text = await response.text()
	// Resource paths embed customer, subscription, or session ids; keep them
	// out of logs while preserving the endpoint name for reconciliation.
	const loggablePath = input.path.replace(
		/(checkout\/sessions|customers|subscriptions|invoices|invoiceitems|credit_notes|payment_intents)\/(?!preview(?:$|[/?]))[^/?]+/,
		'$1/<redacted>',
	)
	let body: unknown = null
	if (text) {
		try {
			body = JSON.parse(text) as unknown
		} catch (error) {
			console.error('stripe_api_invalid_json', {
				status: response.status,
				path: loggablePath,
			})
			throw new StripeApiError('Stripe returned a non-JSON response.', {
				status: response.status,
				cause: error,
			})
		}
	}

	if (!response.ok) {
		console.error('stripe_api_error', {
			status: response.status,
			path: loggablePath,
		})
		const stripeError = readStripeErrorBody(body)
		throw new StripeApiError(
			`Stripe API request failed with HTTP ${response.status}.`,
			{
				status: response.status,
				code: stripeError.code,
				stripeMessage: stripeError.message,
			},
		)
	}

	return body
}

export async function getCheckoutSession(
	env: StripeEnv,
	sessionId: string,
): Promise<StripeCheckoutSession> {
	const trimmed = sessionId.trim()
	if (!trimmed) {
		throw new StripeApiError('Checkout session id is required.', {
			status: 400,
		})
	}
	const body = await stripeRequest(env, {
		method: 'GET',
		path: `/v1/checkout/sessions/${encodeURIComponent(trimmed)}`,
	})
	const parsed = parseSafe(checkoutSessionSchema, body)
	if (!parsed.success) {
		throw new StripeApiError('Unexpected Stripe checkout session shape.', {
			status: 502,
		})
	}
	return parsed.value
}

/**
 * Creates a Stripe Checkout Session (mode=subscription) for an authenticated
 * subscribe flow. `success_url` must include the literal placeholder text
 * `{CHECKOUT_SESSION_ID}` so Stripe can substitute the session id on redirect.
 *
 * URLSearchParams encodes braces as `%7B` / `%7D` in the form body
 * (`session_id=%7BCHECKOUT_SESSION_ID%7D`). That is fine: Stripe decodes form
 * values before storing them, and placeholder substitution runs on the
 * decoded stored URL.
 */
export async function createCheckoutSession(
	env: StripeEnv,
	input: {
		priceId: string
		clientReferenceId: string
		successUrl: string
		cancelUrl: string
		customerId?: string
		customerEmail?: string
		/** Opaque session metadata (e.g. kody_org_id for webhook lookup). */
		metadata?: Record<string, string>
		quantity?: number
		/** A promotion code Kody already validated (`promo_...`). */
		promotionCodeId?: string
	},
): Promise<{ id: string; url: string }> {
	const priceId = input.priceId.trim()
	const clientReferenceId = input.clientReferenceId.trim()
	const successUrl = input.successUrl.trim()
	const cancelUrl = input.cancelUrl.trim()
	const customerId = input.customerId?.trim() || undefined
	const customerEmail = input.customerEmail?.trim() || undefined
	if (!priceId) {
		throw new StripeApiError('Price id is required.', { status: 400 })
	}
	if (!clientReferenceId) {
		throw new StripeApiError('Client reference id is required.', {
			status: 400,
		})
	}
	if (!successUrl) {
		throw new StripeApiError('Success URL is required.', { status: 400 })
	}
	if (!cancelUrl) {
		throw new StripeApiError('Cancel URL is required.', { status: 400 })
	}
	const quantityRaw = input.quantity ?? 1
	if (!Number.isSafeInteger(quantityRaw) || quantityRaw < 1) {
		throw new StripeApiError('Checkout quantity must be a positive integer.', {
			status: 400,
		})
	}

	const form: Record<string, string> = {
		mode: 'subscription',
		'line_items[0][price]': priceId,
		'line_items[0][quantity]': String(quantityRaw),
		client_reference_id: clientReferenceId,
		success_url: successUrl,
		cancel_url: cancelUrl,
		// Stripe Tax is active on the account; with no registrations it computes
		// 0 and tracks thresholds, and once a registration exists Checkout starts
		// collecting without a code change. Tax IDs let business customers apply
		// reverse charge.
		'automatic_tax[enabled]': 'true',
		'tax_id_collection[enabled]': 'true',
	}
	// No `allow_promotion_codes`: coupons can only be limited by product, and
	// monthly and annual are one product, so Stripe's own code box would let a
	// one-month code zero out a year. Kody checks the interval first
	// (checkout-promo.ts) and attaches the code here.
	const promotionCodeId = input.promotionCodeId?.trim()
	if (promotionCodeId) {
		form['discounts[0][promotion_code]'] = promotionCodeId
	}
	// Stripe accepts either `customer` or `customer_email`, never both.
	if (customerId) {
		form.customer = customerId
		// Automatic tax and tax-id collection on an existing customer require
		// Checkout to be allowed to save the address and name it collects.
		form['customer_update[address]'] = 'auto'
		form['customer_update[name]'] = 'auto'
	} else if (customerEmail) {
		form.customer_email = customerEmail
	}
	if (input.metadata) {
		for (const [key, value] of Object.entries(input.metadata)) {
			const trimmedKey = key.trim()
			const trimmedValue = value.trim()
			if (!trimmedKey || !trimmedValue) continue
			// Session metadata for webhook/success attribution, and
			// subscription_data so the created Subscription carries the same
			// org keys (ADR 0065). Checkout does not copy session metadata
			// onto the subscription by itself.
			form[`metadata[${trimmedKey}]`] = trimmedValue
			form[`subscription_data[metadata][${trimmedKey}]`] = trimmedValue
		}
	}

	const body = await stripeRequest(env, {
		method: 'POST',
		path: '/v1/checkout/sessions',
		form,
	})
	const parsed = parseSafe(createdCheckoutSessionSchema, body)
	if (!parsed.success) {
		throw new StripeApiError('Unexpected Stripe checkout session shape.', {
			status: 502,
		})
	}
	const url = parsed.value.url?.trim()
	if (!url) {
		throw new StripeApiError('Stripe checkout session did not include a URL.', {
			status: 502,
		})
	}
	return { id: parsed.value.id, url }
}

const promotionCodeSchema = object({
	id: string(),
	code: string(),
	active: boolean(),
	expires_at: optional(nullable(number())),
	max_redemptions: optional(nullable(number())),
	times_redeemed: optional(number()),
})

const promotionCodeListSchema = object({
	data: array(promotionCodeSchema),
})

export type StripePromotionCode = InferOutput<typeof promotionCodeSchema>

/**
 * The active promotion code a customer typed. Stripe matches `code`
 * case-insensitively. Null when no active code has that text.
 */
export async function findActivePromotionCode(
	env: StripeEnv,
	code: string,
): Promise<StripePromotionCode | null> {
	const trimmed = code.trim()
	if (!trimmed) return null
	const body = await stripeRequest(env, {
		method: 'GET',
		path: '/v1/promotion_codes',
		query: { code: trimmed, active: 'true', limit: '1' },
	})
	const parsed = parseSafe(promotionCodeListSchema, body)
	if (!parsed.success) {
		throw new StripeApiError('Unexpected Stripe promotion code list shape.', {
			status: 502,
		})
	}
	return parsed.value.data[0] ?? null
}

/**
 * Lists subscriptions for a customer with `status=all`, then callers filter
 * to `active` / `trialing`. Using status=all avoids a second request for
 * trialing while still letting canceled history contribute nothing once
 * filtered.
 */
export async function listSubscriptions(
	env: StripeEnv,
	customerId: string,
): Promise<Array<StripeSubscription>> {
	const trimmed = customerId.trim()
	if (!trimmed) {
		throw new StripeApiError('Customer id is required.', { status: 400 })
	}
	const body = await stripeRequest(env, {
		method: 'GET',
		path: '/v1/subscriptions',
		query: {
			customer: trimmed,
			status: 'all',
			limit: '100',
		},
	})
	const parsed = parseSafe(subscriptionListSchema, body)
	if (!parsed.success) {
		throw new StripeApiError('Unexpected Stripe subscriptions list shape.', {
			status: 502,
		})
	}
	return parsed.value.data
}

/**
 * Updates a subscription item seat quantity. Omits `proration_behavior` so
 * Stripe uses the account default (create prorations).
 */
export async function updateSubscriptionItemQuantity(
	env: StripeEnv,
	input: { subscriptionItemId: string; quantity: number },
): Promise<void> {
	const subscriptionItemId = input.subscriptionItemId.trim()
	if (!subscriptionItemId) {
		throw new StripeApiError('Subscription item id is required.', {
			status: 400,
		})
	}
	if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
		throw new StripeApiError('Quantity must be a positive integer.', {
			status: 400,
		})
	}
	const body = await stripeRequest(env, {
		method: 'POST',
		path: `/v1/subscription_items/${encodeURIComponent(subscriptionItemId)}`,
		form: { quantity: String(input.quantity) },
	})
	const parsed = parseSafe(updatedSubscriptionItemSchema, body)
	if (!parsed.success) {
		throw new StripeApiError('Unexpected Stripe subscription item shape.', {
			status: 502,
		})
	}
}

/**
 * Immediately cancels a subscription. Account deletion intentionally does not
 * use cancel_at_period_end because the user is relinquishing portal access and
 * all account state.
 *
 * Idempotent: a subscription Stripe no longer knows (`resource_missing`) is
 * treated as canceled so a retried account deletion does not fail on a
 * subscription an earlier attempt already removed.
 */
export async function cancelSubscription(
	env: StripeEnv,
	subscriptionId: string,
): Promise<void> {
	const trimmed = subscriptionId.trim()
	if (!trimmed) {
		throw new StripeApiError('Subscription id is required.', { status: 400 })
	}
	let body: unknown
	try {
		body = await stripeRequest(env, {
			method: 'DELETE',
			path: `/v1/subscriptions/${encodeURIComponent(trimmed)}`,
		})
	} catch (error) {
		if (error instanceof StripeApiError && error.code === 'resource_missing') {
			return
		}
		throw error
	}
	const parsed = parseSafe(canceledSubscriptionSchema, body)
	if (!parsed.success || parsed.value.status !== 'canceled') {
		throw new StripeApiError('Unexpected Stripe canceled subscription shape.', {
			status: 502,
		})
	}
}

/**
 * Lists the most recent paid invoices for a subscription (Stripe orders
 * newest first), or an empty list when nothing has been paid yet, for example
 * a trial that has not converted. Several are fetched because the newest paid
 * invoice can be a $0 proration invoice (a downgrade) whose lines carry no
 * refundable value; callers walk back to the invoice that still covers the
 * current period. Only the fields the prorated-refund math needs are parsed.
 */
export async function listPaidInvoicesForSubscription(
	env: StripeEnv,
	subscriptionId: string,
): Promise<Array<StripePaidInvoice>> {
	const trimmed = subscriptionId.trim()
	if (!trimmed) {
		throw new StripeApiError('Subscription id is required.', { status: 400 })
	}
	const body = await stripeRequest(env, {
		method: 'GET',
		path: '/v1/invoices',
		query: {
			subscription: trimmed,
			status: 'paid',
			limit: '10',
		},
	})
	const parsed = parseSafe(paidInvoiceListSchema, body)
	if (!parsed.success) {
		throw new StripeApiError('Unexpected Stripe invoice list shape.', {
			status: 502,
		})
	}
	return parsed.value.data
}

const creditNoteListPageSize = 100
/**
 * 2,000 credit notes on one invoice or customer is far beyond anything Kody
 * issues; past this the listing is treated as unknowable rather than trusted
 * as complete, because an under-count would over-refund.
 */
export const creditNoteListMaxPages = 20

/**
 * A credit note listing that was still reporting `has_more` after
 * {@link creditNoteListMaxPages} pages. Callers that use the listing to bound
 * a refund must treat the bound as unknown (nothing creditable), never as the
 * partial sum.
 */
export class StripeCreditNoteListIncompleteError extends StripeApiError {
	readonly pages: number

	constructor(pages: number) {
		super(
			`Stripe credit note listing still had more results after ${pages} pages.`,
			{ status: 502 },
		)
		this.name = 'StripeCreditNoteListIncompleteError'
		this.pages = pages
	}
}

/**
 * Follows `has_more` / `starting_after` to the end of the listing so a
 * customer or invoice with more than one page of credit notes is never
 * under-counted.
 */
async function listCreditNotes(
	env: StripeEnv,
	query: Record<string, string>,
): Promise<Array<StripeCreditNote>> {
	const creditNotes: Array<StripeCreditNote> = []
	let startingAfter: string | null = null
	for (let page = 1; page <= creditNoteListMaxPages; page++) {
		const body = await stripeRequest(env, {
			method: 'GET',
			path: '/v1/credit_notes',
			query: {
				...query,
				limit: String(creditNoteListPageSize),
				...(startingAfter ? { starting_after: startingAfter } : {}),
			},
		})
		const parsed = parseSafe(creditNoteListSchema, body)
		if (!parsed.success) {
			throw new StripeApiError('Unexpected Stripe credit note list shape.', {
				status: 502,
			})
		}
		creditNotes.push(...parsed.value.data)
		const last = parsed.value.data.at(-1)
		if (!parsed.value.has_more || !last) return creditNotes
		startingAfter = last.id
	}
	throw new StripeCreditNoteListIncompleteError(creditNoteListMaxPages)
}

/**
 * Lists the credit notes already issued against an invoice so a retried
 * account deletion can recognise its own earlier refund (see
 * {@link isAccountDeletionCreditNote}) before issuing another.
 */
export async function listCreditNotesForInvoice(
	env: StripeEnv,
	invoiceId: string,
): Promise<Array<StripeCreditNote>> {
	const trimmed = invoiceId.trim()
	if (!trimmed) {
		throw new StripeApiError('Invoice id is required.', { status: 400 })
	}
	return listCreditNotes(env, { invoice: trimmed })
}

/**
 * Lists every credit note issued to a customer so a retried account deletion
 * can report refunds an earlier attempt already issued for subscriptions that
 * are no longer billable.
 */
export async function listCreditNotesForCustomer(
	env: StripeEnv,
	customerId: string,
): Promise<Array<StripeCreditNote>> {
	const trimmed = customerId.trim()
	if (!trimmed) {
		throw new StripeApiError('Customer id is required.', { status: 400 })
	}
	return listCreditNotes(env, { customer: trimmed })
}

export type CreditNoteLineInput = {
	invoiceLineItemId: string
	/** Gross (pre-discount, tax-exclusive) amount to credit on this line. */
	amount: number
}

function buildCreditNoteLinesForm(input: {
	invoiceId: string
	lines: ReadonlyArray<CreditNoteLineInput>
}): Record<string, string> {
	const form: Record<string, string> = { invoice: input.invoiceId }
	input.lines.forEach((line, index) => {
		form[`lines[${index}][type]`] = 'invoice_line_item'
		form[`lines[${index}][invoice_line_item]`] = line.invoiceLineItemId
		form[`lines[${index}][amount]`] = String(line.amount)
	})
	return form
}

async function previewCreditNoteTotal(
	env: StripeEnv,
	linesForm: Record<string, string>,
): Promise<number> {
	const previewBody = await stripeRequest(env, {
		method: 'GET',
		path: '/v1/credit_notes/preview',
		query: linesForm,
	})
	const preview = parseSafe(creditNotePreviewSchema, previewBody)
	if (!preview.success || !Number.isSafeInteger(preview.value.total)) {
		throw new StripeApiError('Unexpected Stripe credit note preview shape.', {
			status: 502,
		})
	}
	return preview.value.total
}

// Integer arithmetic on purpose: `amount * (cap / total)` can land a hair
// under an exact integer and floor one unit too low. With cap < total every
// positive line strictly shrinks, so repeated scaling always makes progress.
function scaleCreditNoteLines(
	lines: ReadonlyArray<CreditNoteLineInput>,
	cap: number,
	total: number,
) {
	return lines
		.map((line) => ({
			...line,
			amount: Math.floor((line.amount * cap) / total),
		}))
		.filter((line) => line.amount > 0)
}

/**
 * How many times the lines are scaled down and re-previewed to get under the
 * refund cap. One pass lands within rounding of the cap; a second absorbs the
 * rounding. The rest is headroom for tax and discount rounding on many lines.
 */
export const creditNoteCapFitAttempts = 6

export type ProratedRefundCreditNoteOutcome =
	| { outcome: 'issued'; id: string; total: number; currency: string }
	/**
	 * The preview totalled zero (for example a 100% discounted line) or every
	 * line scaled away under the cap; no note was created.
	 */
	| { outcome: 'nothing_to_refund' }
	/**
	 * Every scaled preview still exceeded the cap after
	 * {@link creditNoteCapFitAttempts} passes; no note was created.
	 * `lastPreviewMinor` is the final previewed total.
	 */
	| { outcome: 'unfittable'; lastPreviewMinor: number }

/**
 * Issues a credit note that refunds part of one or more invoice line items to
 * the original payment method. A credit note (rather than a raw refund)
 * reverses each line's discounts and tax proportionally and leaves the
 * customer a document that matches the invoice.
 *
 * Each line `amount` is the gross line amount to credit — the same basis as
 * the invoice line's `amount`, before discounts and exclusive tax. Stripe
 * prorates that line's discounts and tax into the credit note and requires
 * the refund to equal the resulting total, which is only known after Stripe
 * computes it, so the note is previewed first and `refund_amount` is set to
 * that total. The issued `total` is what the customer actually gets back.
 *
 * `maxRefundMinor` is the hard ceiling (what the invoice was paid minus what
 * was already credited). While the preview exceeds it, every line is scaled by
 * `maxRefundMinor / previewedTotal` (floored, so the gross lines and the
 * net-of-discount, tax-inclusive preview are only ever compared as a ratio)
 * and previewed again, up to {@link creditNoteCapFitAttempts} times. The note
 * is never issued for more than the cap; if the preview still will not fit the
 * outcome is `unfittable` and nothing is created, so the caller decides
 * whether that blocks anything.
 */
export async function createProratedRefundCreditNote(
	env: StripeEnv,
	input: {
		invoiceId: string
		subscriptionId: string
		lines: ReadonlyArray<CreditNoteLineInput>
		maxRefundMinor: number
		reason:
			| 'duplicate'
			| 'fraudulent'
			| 'order_change'
			| 'product_unsatisfactory'
	},
): Promise<ProratedRefundCreditNoteOutcome> {
	const invoiceId = input.invoiceId.trim()
	const subscriptionId = input.subscriptionId.trim()
	if (!invoiceId) {
		throw new StripeApiError('Invoice id is required.', { status: 400 })
	}
	if (!subscriptionId) {
		throw new StripeApiError('Subscription id is required.', { status: 400 })
	}
	if (
		!Number.isSafeInteger(input.maxRefundMinor) ||
		input.maxRefundMinor <= 0
	) {
		throw new StripeApiError('Refund cap must be a positive integer.', {
			status: 400,
		})
	}
	let lines: ReadonlyArray<CreditNoteLineInput> = input.lines.map((line) => ({
		invoiceLineItemId: line.invoiceLineItemId.trim(),
		amount: line.amount,
	}))
	if (lines.length === 0) {
		throw new StripeApiError('At least one credit note line is required.', {
			status: 400,
		})
	}
	for (const line of lines) {
		if (!line.invoiceLineItemId) {
			throw new StripeApiError('Invoice line item id is required.', {
				status: 400,
			})
		}
		if (!Number.isSafeInteger(line.amount) || line.amount <= 0) {
			throw new StripeApiError(
				'Credit note line amount must be a positive integer.',
				{ status: 400 },
			)
		}
	}
	const cap = input.maxRefundMinor

	let linesForm = buildCreditNoteLinesForm({ invoiceId, lines })
	let total = await previewCreditNoteTotal(env, linesForm)
	if (total <= 0) return { outcome: 'nothing_to_refund' }
	for (
		let attempt = 0;
		total > cap && attempt < creditNoteCapFitAttempts;
		attempt++
	) {
		lines = scaleCreditNoteLines(lines, cap, total)
		if (lines.length === 0) return { outcome: 'nothing_to_refund' }
		linesForm = buildCreditNoteLinesForm({ invoiceId, lines })
		total = await previewCreditNoteTotal(env, linesForm)
		if (total <= 0) return { outcome: 'nothing_to_refund' }
	}
	if (total > cap) return { outcome: 'unfittable', lastPreviewMinor: total }

	let body: unknown
	try {
		body = await stripeRequest(env, {
			method: 'POST',
			path: '/v1/credit_notes',
			form: {
				...linesForm,
				refund_amount: String(total),
				reason: input.reason,
				memo: accountDeletionCreditNoteMemo,
				[`metadata[${accountDeletionCreditNoteMetadataKey}]`]: '1',
				[`metadata[${accountDeletionCreditNoteSubscriptionMetadataKey}]`]:
					subscriptionId,
			},
		})
	} catch (error) {
		// Stripe's own message can embed ids and is never logged; the invoice
		// id and the amounts involved make a repeat diagnosable without it.
		if (error instanceof StripeApiError) {
			throw new StripeApiError(
				`Stripe rejected the credit note for ${invoiceId} (previewed ${total}, cap ${cap}, HTTP ${error.status}).`,
				{
					status: error.status,
					code: error.code,
					stripeMessage: error.stripeMessage,
					cause: error,
				},
			)
		}
		throw error
	}
	const parsed = parseSafe(creditNoteSchema, body)
	if (!parsed.success) {
		throw new StripeApiError('Unexpected Stripe credit note shape.', {
			status: 502,
		})
	}
	return {
		outcome: 'issued',
		id: parsed.value.id,
		total: parsed.value.total,
		currency: parsed.value.currency,
	}
}

/**
 * Merge metadata onto an existing Stripe Customer or Subscription. Only sets
 * the supplied keys; other metadata on the object is left alone. Used when
 * Checkout created the object without org keys (legacy sessions) or when an
 * operator backfills attribution.
 */
export async function mergeStripeObjectMetadata(
	env: StripeEnv,
	input: {
		object: 'customers' | 'subscriptions'
		id: string
		metadata: Record<string, string>
	},
): Promise<void> {
	const id = input.id.trim()
	if (!id) {
		throw new StripeApiError(`${input.object} id is required.`, { status: 400 })
	}
	const form: Record<string, string> = {}
	for (const [key, value] of Object.entries(input.metadata)) {
		const trimmedKey = key.trim()
		const trimmedValue = value.trim()
		if (!trimmedKey || !trimmedValue) continue
		form[`metadata[${trimmedKey}]`] = trimmedValue
	}
	if (Object.keys(form).length === 0) return
	await stripeRequest(env, {
		method: 'POST',
		path: `/v1/${input.object}/${encodeURIComponent(id)}`,
		form,
	})
}

/**
 * Permanently deletes a Stripe customer after its active subscriptions have
 * been canceled, preventing future invoices for an account that no longer
 * exists in Kody.
 */
export async function deleteCustomer(
	env: StripeEnv,
	customerId: string,
): Promise<void> {
	const trimmed = customerId.trim()
	if (!trimmed) {
		throw new StripeApiError('Customer id is required.', { status: 400 })
	}
	const body = await stripeRequest(env, {
		method: 'DELETE',
		path: `/v1/customers/${encodeURIComponent(trimmed)}`,
	})
	const parsed = parseSafe(deletedCustomerSchema, body)
	if (!parsed.success || !parsed.value.deleted) {
		throw new StripeApiError('Unexpected Stripe deleted customer shape.', {
			status: 502,
		})
	}
}

export type BillingPortalFlowData = {
	type: 'subscription_update_confirm'
	/** Subscription the portal confirms a price change for. */
	subscriptionId: string
	/** Subscription item whose price changes. */
	subscriptionItemId: string
	/** Price the item moves to (the purchasable Pro). */
	priceId: string
	/** Where Stripe sends the customer once the update is confirmed. */
	afterCompletionRedirectUrl: string
	/** Seat quantity on the subscription item (defaults to 1). */
	quantity?: number
}

/**
 * Creates a Stripe Billing Portal session. Without `flowData` the portal
 * opens on its overview page. With a `subscription_update_confirm` flow it
 * opens on the confirmation step for moving one subscription item to one
 * price, so switching to Pro is a prorated update instead of a second
 * subscription and cannot land on a retired price.
 * `configuration` pins the portal configuration (proration behavior);
 * unset uses the Stripe account default.
 */
export async function createBillingPortalSession(
	env: StripeEnv,
	input: {
		customerId: string
		returnUrl: string
		configuration?: string | null
		flowData?: BillingPortalFlowData | null
	},
): Promise<{ url: string }> {
	const customerId = input.customerId.trim()
	const returnUrl = input.returnUrl.trim()
	const configuration = input.configuration?.trim() || undefined
	if (!customerId) {
		throw new StripeApiError('Customer id is required.', { status: 400 })
	}
	if (!returnUrl) {
		throw new StripeApiError('Return URL is required.', { status: 400 })
	}
	const form: Record<string, string> = {
		customer: customerId,
		return_url: returnUrl,
	}
	if (configuration) {
		form.configuration = configuration
	}
	if (input.flowData) {
		const subscriptionId = input.flowData.subscriptionId.trim()
		const subscriptionItemId = input.flowData.subscriptionItemId.trim()
		const priceId = input.flowData.priceId.trim()
		const afterCompletionRedirectUrl =
			input.flowData.afterCompletionRedirectUrl.trim()
		if (!subscriptionId || !subscriptionItemId || !priceId) {
			throw new StripeApiError(
				'Subscription, subscription item, and price ids are required.',
				{ status: 400 },
			)
		}
		if (!afterCompletionRedirectUrl) {
			throw new StripeApiError('After-completion redirect URL is required.', {
				status: 400,
			})
		}
		const flow = 'flow_data[subscription_update_confirm]'
		form['flow_data[type]'] = input.flowData.type
		form[`${flow}[subscription]`] = subscriptionId
		form[`${flow}[items][0][id]`] = subscriptionItemId
		form[`${flow}[items][0][price]`] = priceId
		const quantityRaw = input.flowData.quantity ?? 1
		if (!Number.isSafeInteger(quantityRaw) || quantityRaw < 1) {
			throw new StripeApiError(
				'Portal subscription quantity must be a positive integer.',
				{ status: 400 },
			)
		}
		form[`${flow}[items][0][quantity]`] = String(quantityRaw)
		form['flow_data[after_completion][type]'] = 'redirect'
		form['flow_data[after_completion][redirect][return_url]'] =
			afterCompletionRedirectUrl
	}
	const body = await stripeRequest(env, {
		method: 'POST',
		path: '/v1/billing_portal/sessions',
		form,
	})
	const parsed = parseSafe(billingPortalSessionSchema, body)
	if (!parsed.success) {
		throw new StripeApiError(
			'Unexpected Stripe billing portal session shape.',
			{
				status: 502,
			},
		)
	}
	return parsed.value
}

const creditCheckoutSessionSchema = object({
	id: string(),
	mode: string(),
	status: nullable(string()),
	payment_status: string(),
	amount_total: nullable(number()),
	currency: nullable(string()),
	customer: nullable(string()),
	client_reference_id: nullable(string()),
	metadata: optional(nullable(record(string(), string()))),
	payment_intent: nullable(
		object({
			id: string(),
			payment_method: nullable(string()),
		}),
	),
})

export type StripeCreditCheckoutSession = InferOutput<
	typeof creditCheckoutSessionSchema
>

/**
 * One-off Checkout Session (mode=payment) for a prepaid credit top-up. Card
 * only, saved for off-session reuse so auto-refill can charge the same card
 * later. The amount comes from `price_data`; no Stripe Price is needed.
 */
export async function createCreditTopUpCheckoutSession(
	env: StripeEnv,
	input: {
		customerId: string
		amountCents: number
		clientReferenceId: string
		successUrl: string
		cancelUrl: string
		metadata: Record<string, string>
	},
): Promise<{ id: string; url: string }> {
	const customerId = input.customerId.trim()
	if (!customerId) {
		throw new StripeApiError('Customer id is required.', { status: 400 })
	}
	if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
		throw new StripeApiError('Top-up amount must be a positive integer.', {
			status: 400,
		})
	}
	const form: Record<string, string> = {
		mode: 'payment',
		customer: customerId,
		client_reference_id: input.clientReferenceId.trim(),
		success_url: input.successUrl.trim(),
		cancel_url: input.cancelUrl.trim(),
		'payment_method_types[0]': 'card',
		'payment_intent_data[setup_future_usage]': 'off_session',
		'line_items[0][quantity]': '1',
		'line_items[0][price_data][currency]': 'usd',
		'line_items[0][price_data][unit_amount]': String(input.amountCents),
		'line_items[0][price_data][product_data][name]': 'Kody credits',
	}
	for (const [key, value] of Object.entries(input.metadata)) {
		const trimmedKey = key.trim()
		const trimmedValue = value.trim()
		if (!trimmedKey || !trimmedValue) continue
		form[`metadata[${trimmedKey}]`] = trimmedValue
		form[`payment_intent_data[metadata][${trimmedKey}]`] = trimmedValue
	}
	const body = await stripeRequest(env, {
		method: 'POST',
		path: '/v1/checkout/sessions',
		form,
	})
	const parsed = parseSafe(createdCheckoutSessionSchema, body)
	const url = parsed.success ? parsed.value.url?.trim() : null
	if (!parsed.success || !url) {
		throw new StripeApiError('Unexpected Stripe checkout session shape.', {
			status: 502,
		})
	}
	return { id: parsed.value.id, url }
}

/** Read a credit top-up session with its PaymentIntent expanded. */
export async function getCreditTopUpCheckoutSession(
	env: StripeEnv,
	sessionId: string,
): Promise<StripeCreditCheckoutSession> {
	const trimmed = sessionId.trim()
	if (!trimmed) {
		throw new StripeApiError('Checkout session id is required.', {
			status: 400,
		})
	}
	const body = await stripeRequest(env, {
		method: 'GET',
		path: `/v1/checkout/sessions/${encodeURIComponent(trimmed)}`,
		query: { 'expand[]': 'payment_intent' },
	})
	const parsed = parseSafe(creditCheckoutSessionSchema, body)
	if (!parsed.success) {
		throw new StripeApiError('Unexpected Stripe checkout session shape.', {
			status: 502,
		})
	}
	return parsed.value
}

const paymentIntentSchema = object({
	id: string(),
	status: string(),
	amount: number(),
	currency: string(),
})

export type StripePaymentIntent = InferOutput<typeof paymentIntentSchema>

/**
 * Charge a saved card off-session (credit auto-refill). Confirms
 * immediately; a card that needs the customer present comes back with a
 * non-`succeeded` status or a 402, and the caller treats both as a failed
 * refill.
 */
export async function createOffSessionPaymentIntent(
	env: StripeEnv,
	input: {
		customerId: string
		paymentMethodId: string
		amountCents: number
		description: string
		idempotencyKey: string
		metadata: Record<string, string>
	},
): Promise<StripePaymentIntent> {
	const customerId = input.customerId.trim()
	const paymentMethodId = input.paymentMethodId.trim()
	if (!customerId || !paymentMethodId) {
		throw new StripeApiError('Customer and payment method are required.', {
			status: 400,
		})
	}
	if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
		throw new StripeApiError('Charge amount must be a positive integer.', {
			status: 400,
		})
	}
	const form: Record<string, string> = {
		amount: String(input.amountCents),
		currency: 'usd',
		customer: customerId,
		payment_method: paymentMethodId,
		off_session: 'true',
		confirm: 'true',
		description: input.description,
	}
	for (const [key, value] of Object.entries(input.metadata)) {
		form[`metadata[${key}]`] = value
	}
	const body = await stripeRequest(env, {
		method: 'POST',
		path: '/v1/payment_intents',
		form,
		idempotencyKey: input.idempotencyKey,
	})
	const parsed = parseSafe(paymentIntentSchema, body)
	if (!parsed.success) {
		throw new StripeApiError('Unexpected Stripe payment intent shape.', {
			status: 502,
		})
	}
	return parsed.value
}

const paymentIntentListItemSchema = object({
	id: string(),
	status: string(),
	amount: number(),
	currency: string(),
	metadata: optional(record(string(), string())),
})

const paymentIntentListSchema = object({
	data: array(paymentIntentListItemSchema),
	has_more: optional(boolean()),
})

export type StripePaymentIntentListItem = InferOutput<
	typeof paymentIntentListItemSchema
>

/** Cap pages so a pathological customer history cannot hang the refill sweep. */
const paymentIntentListMaxPages = 5

/** Recent PaymentIntents for a customer (newest first), following `has_more`. */
export async function listPaymentIntentsForCustomer(
	env: StripeEnv,
	customerId: string,
	options?: { limit?: number; maxPages?: number },
): Promise<Array<StripePaymentIntentListItem>> {
	const trimmed = customerId.trim()
	if (!trimmed) {
		throw new StripeApiError('Customer id is required.', { status: 400 })
	}
	const limit = options?.limit ?? 100
	if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
		throw new StripeApiError('Payment intent list limit must be 1–100.', {
			status: 400,
		})
	}
	const maxPages = options?.maxPages ?? paymentIntentListMaxPages
	if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
		throw new StripeApiError('Payment intent list maxPages must be >= 1.', {
			status: 400,
		})
	}
	const collected: Array<StripePaymentIntentListItem> = []
	let startingAfter: string | undefined
	for (let page = 0; page < maxPages; page += 1) {
		const query: Record<string, string> = {
			customer: trimmed,
			limit: String(limit),
		}
		if (startingAfter) query.starting_after = startingAfter
		const body = await stripeRequest(env, {
			method: 'GET',
			path: '/v1/payment_intents',
			query,
		})
		const parsed = parseSafe(paymentIntentListSchema, body)
		if (!parsed.success) {
			throw new StripeApiError('Unexpected Stripe payment intent list shape.', {
				status: 502,
			})
		}
		const pageData = parsed.value.data
		collected.push(...pageData)
		if (!parsed.value.has_more || pageData.length === 0) break
		startingAfter = pageData[pageData.length - 1]?.id
		if (!startingAfter) break
	}
	return collected
}
