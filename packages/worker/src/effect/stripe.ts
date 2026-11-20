import {
	accountDeletionCreditNoteMemo,
	accountDeletionCreditNoteMetadataKey,
	accountDeletionCreditNoteSubscriptionMetadataKey,
	creditNoteCapFitAttempts,
	creditNoteListMaxPages,
	type CreditNoteLineInput,
	type ProratedRefundCreditNoteOutcome,
	type StripeEnv,
} from '#worker/billing/stripe-client.ts'
import { Context, Effect, Layer, Schema } from 'effect'
import { outbound } from '#worker/effect/outbound.ts'
import { WorkerEnv } from '#worker/effect/worker-env.ts'
import * as StripeApi from '#worker/effect/stripe-api.ts'

const defaultStripeApiBaseUrl = 'https://api.stripe.com'
const creditNoteListPageSize = 100

/** Stripe answered with an error status, a non-JSON body, or a body whose shape is not what Kody parses. */
export class StripeApiError extends Schema.TaggedError<StripeApiError>()(
	'StripeApiError',
	{
		message: Schema.String,
		status: Schema.Number,
		code: Schema.NullOr(Schema.String),
		/** Stripe `error.message`; never logged, it can embed object ids. */
		stripeMessage: Schema.NullOr(Schema.String),
	},
) {}

/** A credit note listing still had `has_more` after `creditNoteListMaxPages` pages. */
export class StripeCreditNoteListIncompleteError extends Schema.TaggedError<StripeCreditNoteListIncompleteError>()(
	'StripeCreditNoteListIncompleteError',
	{ pages: Schema.Number, message: Schema.String },
) {}

export class StripeNotConfiguredError extends Schema.TaggedError<StripeNotConfiguredError>()(
	'StripeNotConfiguredError',
	{ message: Schema.String },
) {}

/** The request never got an answer: network failure or the 10 second deadline. */
export class StripeUnavailableError extends Schema.TaggedError<StripeUnavailableError>()(
	'StripeUnavailableError',
	{ message: Schema.String, path: Schema.String },
) {}

export type StripeFailure =
	| StripeApiError
	| StripeNotConfiguredError
	| StripeUnavailableError

const StringRecord = Schema.Record(Schema.String, Schema.String)

/**
 * A field Stripe may omit, decoded to a key that is always present (possibly
 * `undefined`), matching the shapes the billing helpers take.
 */
const omittable = <S extends Schema.Top>(schema: S) =>
	Schema.UndefinedOr(schema).pipe(Schema.withDecodingDefaultKey(Effect.void))

const StripeErrorBody = Schema.Struct({
	error: Schema.Struct({
		code: Schema.optional(Schema.String),
		message: Schema.optional(Schema.String),
	}),
})

export const StripeSubscription = Schema.Struct({
	id: Schema.String,
	status: Schema.String,
	cancel_at: Schema.NullOr(Schema.Number),
	current_period_end: omittable(Schema.NullOr(Schema.Number)),
	currency: omittable(Schema.NullOr(Schema.String)),
	metadata: omittable(StringRecord),
	items: Schema.Struct({
		data: Schema.mutable(
			Schema.Array(
				Schema.Struct({
					id: omittable(Schema.String),
					quantity: omittable(Schema.Number),
					price: Schema.Struct({
						id: Schema.String,
						unit_amount: omittable(Schema.NullOr(Schema.Number)),
						recurring: omittable(
							Schema.NullOr(
								Schema.Struct({
									interval: Schema.String,
									interval_count: omittable(Schema.Number),
								}),
							),
						),
					}),
					current_period_end: omittable(Schema.NullOr(Schema.Number)),
				}),
			),
		),
	}),
})
export type StripeSubscription = typeof StripeSubscription.Type

const SubscriptionList = Schema.Struct({
	data: Schema.mutable(Schema.Array(StripeSubscription)),
})

const CanceledSubscription = Schema.Struct({
	id: Schema.String,
	status: Schema.Literal('canceled'),
})

const DeletedCustomer = Schema.Struct({
	id: Schema.String,
	deleted: Schema.Literal(true),
})

export const StripePaidInvoice = Schema.Struct({
	id: Schema.String,
	amount_paid: Schema.Number,
	currency: Schema.String,
	lines: Schema.Struct({
		data: Schema.mutable(
			Schema.Array(
				Schema.Struct({
					id: Schema.String,
					amount: Schema.Number,
					period: Schema.Struct({ start: Schema.Number, end: Schema.Number }),
					discount_amounts: omittable(
						Schema.mutable(
							Schema.Array(Schema.Struct({ amount: Schema.Number })),
						),
					),
				}),
			),
		),
	}),
})
export type StripePaidInvoice = typeof StripePaidInvoice.Type

const PaidInvoiceList = Schema.Struct({
	data: Schema.mutable(Schema.Array(StripePaidInvoice)),
})

export const StripeCreditNote = Schema.Struct({
	id: Schema.String,
	invoice: Schema.String,
	total: Schema.Number,
	currency: Schema.String,
	status: Schema.String,
	metadata: omittable(StringRecord),
})
export type StripeCreditNote = typeof StripeCreditNote.Type

const CreditNoteList = Schema.Struct({
	data: Schema.Array(StripeCreditNote),
	has_more: Schema.Boolean,
})

const CreditNotePreview = Schema.Struct({
	total: Schema.Int,
	currency: Schema.String,
})

export function isAccountDeletionCreditNote(creditNote: StripeCreditNote) {
	return (
		creditNote.status === 'issued' &&
		creditNote.metadata?.[accountDeletionCreditNoteMetadataKey] === '1'
	)
}

/**
 * Stripe reports an invoice whose charge was already refunded in full either
 * with `charge_already_refunded` or as a bare 400 whose message says so.
 */
export function isStripeNothingToRefund(error: StripeFailure) {
	if (error._tag !== 'StripeApiError') return false
	if (error.code === 'charge_already_refunded') return true
	if (error.status !== 400 || !error.stripeMessage) return false
	return /(?:already|fully) (?:been )?(?:fully )?(?:refunded|credited)/i.test(
		error.stripeMessage,
	)
}

type StripeRequest = {
	readonly method: 'DELETE' | 'GET' | 'POST'
	readonly path: string
	readonly query?: Record<string, string>
	readonly form?: Record<string, string>
}

const loggablePath = (path: string) =>
	path.replace(
		/(checkout\/sessions|customers|subscriptions|invoices|invoiceitems|credit_notes|payment_intents)\/(?!preview(?:$|[/?]))[^/?]+/,
		'$1/<redacted>',
	)

const shapeError = (message: string) =>
	new StripeApiError({ message, status: 502, code: null, stripeMessage: null })

const requiredId = (label: string, value: string) => {
	const trimmed = value.trim()
	return trimmed
		? Effect.succeed(trimmed)
		: Effect.fail(
				new StripeApiError({
					message: `${label} is required.`,
					status: 400,
					code: null,
					stripeMessage: null,
				}),
			)
}

/**
 * The Stripe calls account deletion makes. Every request is abortable with a
 * 10 second deadline and every response body is decoded with a schema.
 */
export class Stripe extends Context.Service<
	Stripe,
	{
		listSubscriptions(
			customerId: string,
		): Effect.Effect<Array<StripeSubscription>, StripeFailure>
		cancelSubscription(
			subscriptionId: string,
		): Effect.Effect<void, StripeFailure>
		listPaidInvoicesForSubscription(
			subscriptionId: string,
		): Effect.Effect<Array<StripePaidInvoice>, StripeFailure>
		listCreditNotesForInvoice(
			invoiceId: string,
		): Effect.Effect<
			Array<StripeCreditNote>,
			StripeFailure | StripeCreditNoteListIncompleteError
		>
		listCreditNotesForCustomer(
			customerId: string,
		): Effect.Effect<
			Array<StripeCreditNote>,
			StripeFailure | StripeCreditNoteListIncompleteError
		>
		createProratedRefundCreditNote(input: {
			readonly invoiceId: string
			readonly subscriptionId: string
			readonly lines: ReadonlyArray<CreditNoteLineInput>
			readonly maxRefundMinor: number
			readonly reason: 'order_change'
		}): Effect.Effect<ProratedRefundCreditNoteOutcome, StripeFailure>
		deleteCustomer(customerId: string): Effect.Effect<void, StripeFailure>
	}
>()('kody/effect/Stripe') {
	/** Reads the Worker's Stripe settings on every request (see `stripe-api.ts`). */
	static readonly layer = Layer.effect(
		Stripe,
		Effect.gen(function* () {
			return StripeApi.makeStripe(yield* WorkerEnv)
		}),
	)
}

/** The live Stripe service: abortable fetch, 10 second deadline, schema-decoded bodies. */
export function makeStripeLive(env: StripeEnv): Stripe['Service'] {
	const request = Effect.fn('Stripe.request')(function* <A>(
		input: StripeRequest,
		schema: Schema.Decoder<A>,
		shapeMessage: string,
	) {
		const secretKey = env.STRIPE_SECRET_KEY?.trim()
		if (!secretKey) {
			return yield* new StripeNotConfiguredError({
				message: 'Stripe billing is not configured on this deployment.',
			})
		}
		const path = loggablePath(input.path)
		yield* Effect.annotateCurrentSpan({
			'stripe.method': input.method,
			'stripe.path': path,
		})
		const baseUrl = (
			env.STRIPE_API_BASE_URL?.trim() || defaultStripeApiBaseUrl
		).replace(/\/$/, '')
		const url = new URL(`${baseUrl}${input.path}`)
		for (const [key, value] of Object.entries(input.query ?? {})) {
			url.searchParams.set(key, value)
		}
		const headers: Record<string, string> = {
			accept: 'application/json',
			authorization: `Bearer ${secretKey}`,
		}
		const form =
			input.method === 'POST' && input.form
				? new URLSearchParams(input.form).toString()
				: undefined
		if (form !== undefined) {
			headers['content-type'] = 'application/x-www-form-urlencoded'
		}
		const response = yield* outbound(
			'stripe.fetch',
			async (signal) => {
				const res = await fetch(url.toString(), {
					method: input.method,
					headers,
					signal,
					...(form === undefined ? {} : { body: form }),
				})
				return { status: res.status, ok: res.ok, text: await res.text() }
			},
			{ timeout: '10 seconds' },
		).pipe(
			Effect.mapError(
				(error) => new StripeUnavailableError({ message: error.message, path }),
			),
		)
		const body = yield* Effect.try({
			try: () =>
				response.text ? (JSON.parse(response.text) as unknown) : null,
			catch: () =>
				new StripeApiError({
					message: 'Stripe returned a non-JSON response.',
					status: response.status,
					code: null,
					stripeMessage: null,
				}),
		}).pipe(
			Effect.tapError(() =>
				Effect.logError('stripe_api_invalid_json', {
					status: response.status,
					path,
				}),
			),
		)
		if (!response.ok) {
			yield* Effect.logError('stripe_api_error', {
				status: response.status,
				path,
			})
			const stripeError = Schema.decodeUnknownOption(StripeErrorBody)(body)
			return yield* new StripeApiError({
				message: `Stripe API request failed with HTTP ${response.status}.`,
				status: response.status,
				code:
					stripeError._tag === 'Some'
						? (stripeError.value.error.code ?? null)
						: null,
				stripeMessage:
					stripeError._tag === 'Some'
						? (stripeError.value.error.message ?? null)
						: null,
			})
		}
		return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
			Effect.mapError(() => shapeError(shapeMessage)),
		)
	})

	const listCreditNotes = Effect.fn('Stripe.listCreditNotes')(function* (
		query: Record<string, string>,
	) {
		const creditNotes: Array<StripeCreditNote> = []
		let startingAfter: string | null = null
		for (let page = 1; page <= creditNoteListMaxPages; page++) {
			const listed: typeof CreditNoteList.Type = yield* request(
				{
					method: 'GET',
					path: '/v1/credit_notes',
					query: {
						...query,
						limit: String(creditNoteListPageSize),
						...(startingAfter ? { starting_after: startingAfter } : {}),
					},
				},
				CreditNoteList,
				'Unexpected Stripe credit note list shape.',
			)
			creditNotes.push(...listed.data)
			const last = listed.data.at(-1)
			if (!listed.has_more || !last) return creditNotes
			startingAfter = last.id
		}
		return yield* new StripeCreditNoteListIncompleteError({
			pages: creditNoteListMaxPages,
			message: `Stripe credit note listing still had more results after ${creditNoteListMaxPages} pages.`,
		})
	})

	const linesForm = (
		invoiceId: string,
		lines: ReadonlyArray<CreditNoteLineInput>,
	) => {
		const form: Record<string, string> = { invoice: invoiceId }
		lines.forEach((line, index) => {
			form[`lines[${index}][type]`] = 'invoice_line_item'
			form[`lines[${index}][invoice_line_item]`] = line.invoiceLineItemId
			form[`lines[${index}][amount]`] = String(line.amount)
		})
		return form
	}

	const previewTotal = (form: Record<string, string>) =>
		request(
			{ method: 'GET', path: '/v1/credit_notes/preview', query: form },
			CreditNotePreview,
			'Unexpected Stripe credit note preview shape.',
		).pipe(Effect.map((preview) => preview.total))

	const invalid = (message: string) =>
		new StripeApiError({
			message,
			status: 400,
			code: null,
			stripeMessage: null,
		})

	/** Scales the lines until the previewed total fits under the cap. Read-only. */
	const fitUnderCap = Effect.fn('Stripe.fitCreditNoteUnderCap')(function* (
		invoiceId: string,
		input: ReadonlyArray<CreditNoteLineInput>,
		cap: number,
	) {
		if (!Number.isSafeInteger(cap) || cap <= 0) {
			return yield* invalid('Refund cap must be a positive integer.')
		}
		let lines = input.map((line) => ({
			invoiceLineItemId: line.invoiceLineItemId.trim(),
			amount: line.amount,
		}))
		if (lines.length === 0) {
			return yield* invalid('At least one credit note line is required.')
		}
		for (const line of lines) {
			if (!line.invoiceLineItemId) {
				return yield* invalid('Invoice line item id is required.')
			}
			if (!Number.isSafeInteger(line.amount) || line.amount <= 0) {
				return yield* invalid(
					'Credit note line amount must be a positive integer.',
				)
			}
		}
		let form = linesForm(invoiceId, lines)
		let total = yield* previewTotal(form)
		if (total <= 0) return { outcome: 'nothing_to_refund' } as const
		for (
			let attempt = 0;
			total > cap && attempt < creditNoteCapFitAttempts;
			attempt++
		) {
			const scaledTotal = total
			lines = lines
				.map((line) => ({
					...line,
					amount: Math.floor((line.amount * cap) / scaledTotal),
				}))
				.filter((line) => line.amount > 0)
			if (lines.length === 0) {
				return { outcome: 'nothing_to_refund' } as const
			}
			form = linesForm(invoiceId, lines)
			total = yield* previewTotal(form)
			if (total <= 0) return { outcome: 'nothing_to_refund' } as const
		}
		if (total > cap) {
			return { outcome: 'unfittable', lastPreviewMinor: total } as const
		}
		return { outcome: 'fitted', form, total } as const
	})

	return Stripe.of({
		listSubscriptions: Effect.fn('Stripe.listSubscriptions')(
			function* (customerId) {
				const customer = yield* requiredId('Customer id', customerId)
				const listed = yield* request(
					{
						method: 'GET',
						path: '/v1/subscriptions',
						query: { customer, status: 'all', limit: '100' },
					},
					SubscriptionList,
					'Unexpected Stripe subscriptions list shape.',
				)
				return listed.data
			},
		),
		cancelSubscription: Effect.fn('Stripe.cancelSubscription')(
			function* (subscriptionId) {
				const id = yield* requiredId('Subscription id', subscriptionId)
				yield* request(
					{
						method: 'DELETE',
						path: `/v1/subscriptions/${encodeURIComponent(id)}`,
					},
					CanceledSubscription,
					'Unexpected Stripe canceled subscription shape.',
				).pipe(
					Effect.catchIf(
						(error) =>
							error._tag === 'StripeApiError' &&
							error.code === 'resource_missing',
						() => Effect.void,
					),
				)
			},
		),
		listPaidInvoicesForSubscription: Effect.fn(
			'Stripe.listPaidInvoicesForSubscription',
		)(function* (subscriptionId) {
			const subscription = yield* requiredId('Subscription id', subscriptionId)
			const listed = yield* request(
				{
					method: 'GET',
					path: '/v1/invoices',
					query: { subscription, status: 'paid', limit: '10' },
				},
				PaidInvoiceList,
				'Unexpected Stripe invoice list shape.',
			)
			return listed.data
		}),
		listCreditNotesForInvoice: Effect.fn('Stripe.listCreditNotesForInvoice')(
			function* (invoiceId) {
				const invoice = yield* requiredId('Invoice id', invoiceId)
				return yield* listCreditNotes({ invoice })
			},
		),
		listCreditNotesForCustomer: Effect.fn('Stripe.listCreditNotesForCustomer')(
			function* (customerId) {
				const customer = yield* requiredId('Customer id', customerId)
				return yield* listCreditNotes({ customer })
			},
		),
		createProratedRefundCreditNote: Effect.fn(
			'Stripe.createProratedRefundCreditNote',
		)(function* (input) {
			const invoiceId = yield* requiredId('Invoice id', input.invoiceId)
			const subscriptionId = yield* requiredId(
				'Subscription id',
				input.subscriptionId,
			)
			const fitted = yield* fitUnderCap(
				invoiceId,
				input.lines,
				input.maxRefundMinor,
			)
			if (fitted.outcome !== 'fitted') return fitted
			const cap = input.maxRefundMinor
			const created = yield* request(
				{
					method: 'POST',
					path: '/v1/credit_notes',
					form: {
						...fitted.form,
						refund_amount: String(fitted.total),
						reason: input.reason,
						memo: accountDeletionCreditNoteMemo,
						[`metadata[${accountDeletionCreditNoteMetadataKey}]`]: '1',
						[`metadata[${accountDeletionCreditNoteSubscriptionMetadataKey}]`]:
							subscriptionId,
					},
				},
				StripeCreditNote,
				'Unexpected Stripe credit note shape.',
			).pipe(
				Effect.mapError((error) =>
					error._tag === 'StripeApiError' &&
					error.message !== 'Unexpected Stripe credit note shape.'
						? new StripeApiError({
								message: `Stripe rejected the credit note for ${invoiceId} (previewed ${fitted.total}, cap ${cap}, HTTP ${error.status}).`,
								status: error.status,
								code: error.code,
								stripeMessage: error.stripeMessage,
							})
						: error,
				),
			)
			return {
				outcome: 'issued',
				id: created.id,
				total: created.total,
				currency: created.currency,
			} as const
		}),
		deleteCustomer: Effect.fn('Stripe.deleteCustomer')(function* (customerId) {
			const id = yield* requiredId('Customer id', customerId)
			yield* request(
				{ method: 'DELETE', path: `/v1/customers/${encodeURIComponent(id)}` },
				DeletedCustomer,
				'Unexpected Stripe deleted customer shape.',
			)
		}),
	})
}
