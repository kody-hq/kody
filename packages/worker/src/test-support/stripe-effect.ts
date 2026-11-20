import { Effect } from 'effect'
import { beforeEach, vi } from 'vitest'
import * as stripeClient from '#worker/billing/stripe-client.ts'
import * as StripeApi from '#worker/effect/stripe-api.ts'
import {
	makeStripeLive,
	StripeApiError,
	StripeCreditNoteListIncompleteError,
} from '#worker/effect/stripe.ts'

const bridgedMethods = [
	'listSubscriptions',
	'cancelSubscription',
	'listPaidInvoicesForSubscription',
	'listCreditNotesForInvoice',
	'listCreditNotesForCustomer',
	'createProratedRefundCreditNote',
	'deleteCustomer',
] as const

function toTaggedStripeError(error: unknown) {
	if (error instanceof stripeClient.StripeCreditNoteListIncompleteError) {
		return new StripeCreditNoteListIncompleteError({
			pages: error.pages,
			message: error.message,
		})
	}
	if (error instanceof stripeClient.StripeApiError) {
		return new StripeApiError({
			message: error.message,
			status: error.status,
			code: error.code,
			stripeMessage: error.stripeMessage,
		})
	}
	return error
}

/**
 * Lets tests keep spying the Promise Stripe client: each Effect Stripe call
 * goes to the matching `stripe-client.ts` function while that function is a
 * `vi.spyOn` mock, and to the live Effect client (real `fetch`) otherwise.
 */
export function bridgeStripeClientSpies() {
	beforeEach(() => {
		vi.spyOn(StripeApi, 'makeStripe').mockImplementation((env) => {
			const live = makeStripeLive(env)
			const bridged: Record<string, unknown> = { ...live }
			for (const name of bridgedMethods) {
				bridged[name] = (...args: Array<unknown>) =>
					vi.isMockFunction(stripeClient[name])
						? Effect.tryPromise({
								try: () =>
									(stripeClient[name] as (...a: Array<unknown>) => Promise<unknown>)(
										env,
										...args,
									),
								catch: toTaggedStripeError,
							})
						: (live[name] as (...a: Array<unknown>) => unknown)(...args)
			}
			return bridged as typeof live
		})
	})
}
