import {
	createBillingLinkReference,
	isBillingConfigured,
} from './billing-config.ts'
import { applyCreditPayment, type CreditTopUpResult } from './credit-wallet.ts'
import {
	createCreditTopUpCheckoutSession,
	getCreditTopUpCheckoutSession,
} from './stripe-client.ts'
import {
	buildOrgBillingMetadata,
	resolveOrgIdFromStripeMetadata,
} from './org-stripe-metadata.ts'

/** Checkout Session metadata marking a prepaid credit top-up. */
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
export const creditTopUpMetadataKey = 'kody_credit_top_up'

export class CreditTopUpError extends Error {
	readonly code:
		| 'billing_not_configured'
		| 'not_credit_top_up'
		| 'not_paid'
		| 'client_reference_mismatch'
		| 'user_not_found'

	constructor(code: CreditTopUpError['code'], message: string) {
		super(message)
		this.name = 'CreditTopUpError'
		this.code = code
	}
}

/**
 * Stripe success URL for a top-up started from `creditsUrl`. Stripe
 * substitutes the literal `{CHECKOUT_SESSION_ID}` placeholder, so it is
 * appended as raw text after the query; any fragment is dropped (the
 * confirm redirect adds it back).
 */
export function creditTopUpSuccessUrl(creditsUrl: string): string {
	const url = new URL(creditsUrl)
	url.hash = ''
	url.searchParams.set('topup', 'success')
	return `${url.toString()}&session_id={CHECKOUT_SESSION_ID}`
}

export async function startCreditTopUpCheckout(input: {
	env: Env
	stableUserId: string
	stripeCustomerId: string
	amountCents: number
	creditsUrl: string
}): Promise<{ url: string }> {
	const clientReferenceId = await createBillingLinkReference(
		input.env,
		input.stableUserId,
	)
	const session = await createCreditTopUpCheckoutSession(input.env, {
		customerId: input.stripeCustomerId,
		amountCents: input.amountCents,
		clientReferenceId,
		successUrl: creditTopUpSuccessUrl(input.creditsUrl),
		cancelUrl: input.creditsUrl,
		metadata: {
			[creditTopUpMetadataKey]: '1',
			...buildOrgBillingMetadata(input.stableUserId),
		},
	})
	return { url: session.url }
}

/**
 * Credit a completed top-up Checkout Session. Shared by the success
 * redirect (which passes the signed-in user) and the
 * `checkout.session.completed` webhook. The amount is Stripe's
 * `amount_total`, never client input; `client_reference_id` must match the
 * owning user's signed billing reference.
 */
export async function applyCreditTopUpFromCheckoutSession(input: {
	env: Env
	sessionId: string
	expectedStableUserId?: string
	now: Date
}): Promise<CreditTopUpResult & { stableUserId: string }> {
	if (!isBillingConfigured(input.env)) {
		throw new CreditTopUpError(
			'billing_not_configured',
			'Stripe billing is not configured on this deployment.',
		)
	}
	const session = await getCreditTopUpCheckoutSession(
		input.env,
		input.sessionId,
	)
	if (
		session.mode !== 'payment' ||
		session.metadata?.[creditTopUpMetadataKey] !== '1'
	) {
		throw new CreditTopUpError(
			'not_credit_top_up',
			'That checkout session is not a credit top-up.',
		)
	}
	const amountCents = session.amount_total ?? 0
	if (
		session.payment_status !== 'paid' ||
		session.currency !== 'usd' ||
		amountCents <= 0
	) {
		throw new CreditTopUpError('not_paid', 'That top-up has not been paid.')
	}
	const stableUserId =
		input.expectedStableUserId ??
		resolveOrgIdFromStripeMetadata(session.metadata ?? undefined) ??
		''
	if (!stableUserId) {
		throw new CreditTopUpError(
			'user_not_found',
			'No Kody account matched this top-up.',
		)
	}
	const expectedReference = await createBillingLinkReference(
		input.env,
		stableUserId,
	)
	if (session.client_reference_id !== expectedReference) {
		throw new CreditTopUpError(
			'client_reference_mismatch',
			'This top-up does not belong to your account.',
		)
	}
	// Wallets are keyed by org id (personal or team). Metadata stores orgs.id —
	// for personal orgs that is users.personal_org_id when set, else
	// users.stable_user_id — so look up the org row by that id, not by person id.
	// Skip orgs mid-delete (`deleting_at`) the same way credit debit does —
	// a Stripe return during delete must not refill a wallet about to vanish.
	const org = await input.env.APP_DB.prepare(
		`SELECT id FROM orgs WHERE id = ? AND deleting_at IS NULL${andLiveDeletedAtSql()}`,
	)
		.bind(stableUserId)
		.first<{ id: string }>()
	if (!org) {
		throw new CreditTopUpError(
			'user_not_found',
			'No Kody account matched this top-up.',
		)
	}
	const result = await applyCreditPayment({
		db: input.env.APP_DB,
		userId: stableUserId,
		kind: 'top_up',
		amountCents,
		stripeReference: session.id,
		paymentMethodId: session.payment_intent?.payment_method ?? null,
		now: input.now,
	})
	return { ...result, stableUserId }
}
