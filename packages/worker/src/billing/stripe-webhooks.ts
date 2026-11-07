/**
 * Platform Stripe billing webhook processing (not package inbound webhooks).
 *
 * Verifies Stripe-Signature against STRIPE_WEBHOOK_SECRET, processes the event
 * (handlers are idempotent), then records the event id so later deliveries can
 * short-circuit as duplicates. Failures do not insert, so Stripe can retry.
 */
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { releasePromoReservationForCheckoutSession } from './checkout-promo.ts'
import {
	any,
	nullable,
	object,
	optional,
	parseSafe,
	record,
	string,
} from 'remix/data-schema'
import { waitUntil } from 'cloudflare:workers'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { sendPaymentFailedEmail } from '#app/user-account-emails.ts'
import { readSignupOrgSlug } from '#worker/orgs/signup-org-slug.ts'
import {
	isBillingConfigured,
	selectKodyPlanRetainingSubscriptions,
} from './billing-config.ts'
import { recordCheckoutFunnelEvent } from '#worker/identity/onboarding-funnel.ts'
import {
	BillingLinkError,
	linkStripeCustomerFromCheckoutSessionAttribution,
	refreshStripePlanForOrg,
	refreshStripePlanForStripeCustomer,
	refreshStripePlanForUser,
} from './subscription-sync.ts'
import {
	listSubscriptions,
	readStripeSubscriptionPeriodEndUnix,
} from './stripe-client.ts'
import {
	isQualifyingPaidReferralInvoice,
	readStripeInvoiceCustomerId,
	readStripeInvoiceId,
	readStripeInvoicePeriodEndIso,
	readStripeInvoiceSubscriptionId,
	rewardReferralForPaidInvoice,
} from '#worker/entitlements/referral-program.ts'
import { unixSecondsToIso } from '#universal/referral-program.ts'
import {
	StripeWebhookSignatureError,
	verifyStripeWebhookSignature,
} from './stripe-webhook-signature.ts'
import {
	applyCreditTopUpFromCheckoutSession,
	creditTopUpMetadataKey,
	CreditTopUpError,
} from './credit-top-ups.ts'
import { sendToOrgBillingRecipients } from './org-billing-emails.ts'
import { resolveOrgIdFromStripeMetadata } from './org-stripe-metadata.ts'

import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
const stripeEventSchema = object({
	id: string(),
	type: string(),
	data: object({
		object: record(string(), any()),
	}),
})

const checkoutSessionObjectSchema = object({
	id: string(),
	customer: optional(nullable(string())),
	client_reference_id: optional(nullable(string())),
	customer_email: optional(nullable(string())),
	customer_details: optional(
		nullable(
			object({
				email: optional(nullable(string())),
			}),
		),
	),
	metadata: optional(nullable(record(string(), string()))),
})

const customerObjectSchema = object({
	customer: optional(nullable(string())),
})

export type StripeWebhookProcessResult = {
	status: number
	body: { ok: boolean; duplicate?: boolean; ignored?: boolean; error?: string }
}

function readCustomerId(value: unknown): string | null {
	if (typeof value === 'string' && value.trim()) return value.trim()
	return null
}

function readStringField(
	recordValue: Record<string, unknown>,
	key: string,
): string | null {
	const value = recordValue[key]
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Records a successfully processed event. UNIQUE conflict means another
 * delivery already finished the same event — treat as duplicate success.
 */
export async function recordStripeWebhookEvent(input: {
	env: Env
	eventId: string
	eventType: string
	now?: Date
}): Promise<'recorded' | 'duplicate'> {
	const now = input.now ?? new Date()
	try {
		await input.env.APP_DB.prepare(
			`INSERT INTO stripe_webhook_events (event_id, event_type, processed_at)
			 VALUES (?, ?, ?)`,
		)
			.bind(input.eventId, input.eventType, now.toISOString())
			.run()
		return 'recorded'
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (/UNIQUE constraint failed/i.test(message)) {
			return 'duplicate'
		}
		throw error
	}
}

async function handleCheckoutSessionCompleted(input: {
	env: Env
	object: Record<string, unknown>
	now?: Date
}) {
	const parsed = parseSafe(checkoutSessionObjectSchema, input.object)
	if (!parsed.success) {
		console.error('stripe_webhook_checkout_shape', {
			error: 'unexpected checkout session shape',
		})
		return
	}
	const session = parsed.value
	const customerEmail =
		session.customer_details?.email?.trim() ||
		session.customer_email?.trim() ||
		null
	const stableUserIdHint = resolveOrgIdFromStripeMetadata(session.metadata)

	if (session.metadata?.[creditTopUpMetadataKey] === '1') {
		await handleCreditTopUpCompleted({
			env: input.env,
			sessionId: session.id,
			now: input.now,
		})
		return
	}

	try {
		await linkStripeCustomerFromCheckoutSessionAttribution({
			env: input.env,
			sessionId: session.id,
			clientReferenceId: session.client_reference_id,
			stableUserIdHint,
			metadata: session.metadata ?? undefined,
			customerId: session.customer,
			customerEmail,
			now: input.now,
		})
		recordCheckoutFunnelEvent(input.env, {
			stage: 'checkout_completed',
			userId: stableUserIdHint,
			plan: session.metadata?.kody_plan,
		})
	} catch (error) {
		if (error instanceof BillingLinkError) {
			switch (error.code) {
				case 'billing_not_configured':
				case 'missing_session':
				case 'client_reference_mismatch':
				case 'missing_customer':
				case 'customer_already_linked':
				case 'account_already_linked':
				case 'user_not_found':
					console.error('stripe_webhook_checkout_link_skipped', {
						code: error.code,
						sessionId: session.id,
					})
					return
				case 'stripe_error':
					throw error
				default: {
					const exhaustive: never = error.code
					throw new Error(
						`Unhandled BillingLinkError code: ${String(exhaustive)}`,
					)
				}
			}
		}
		throw error
	}
}

async function handleCreditTopUpCompleted(input: {
	env: Env
	sessionId: string
	now?: Date
}) {
	try {
		const result = await applyCreditTopUpFromCheckoutSession({
			env: input.env,
			sessionId: input.sessionId,
			now: input.now ?? new Date(),
		})
		if (!result.applied) {
			console.info('stripe_webhook_credit_top_up_replay', {
				sessionId: input.sessionId,
			})
		}
	} catch (error) {
		if (error instanceof CreditTopUpError) {
			console.error('stripe_webhook_credit_top_up_skipped', {
				code: error.code,
				sessionId: input.sessionId,
			})
			return
		}
		throw error
	}
}

async function handleCustomerSubscriptionChange(input: {
	env: Env
	object: Record<string, unknown>
	now?: Date
}) {
	const parsed = parseSafe(customerObjectSchema, input.object)
	const customerId =
		(parsed.success ? readCustomerId(parsed.value.customer) : null) ??
		readStringField(input.object, 'customer')
	if (!customerId) {
		console.error('stripe_webhook_subscription_missing_customer')
		return
	}
	const metadata =
		input.object.metadata && typeof input.object.metadata === 'object'
			? (input.object.metadata as Record<string, string>)
			: null
	const orgOrUserHint = resolveOrgIdFromStripeMetadata(metadata)
	let result = await refreshStripePlanForStripeCustomer({
		env: input.env,
		customerId,
		now: input.now,
	})
	if (result.userId == null && result.orgId == null && orgOrUserHint) {
		const user = await input.env.APP_DB.prepare(
			`SELECT id FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
			.bind(orgOrUserHint)
			.first<{ id: number }>()
		const org = await input.env.APP_DB.prepare(
			`SELECT id, stripe_customer_id FROM orgs
			 WHERE id = ? AND deleted_at IS NULL`,
		)
			.bind(orgOrUserHint)
			.first<{ id: OwnerId; stripe_customer_id: string | null }>()
		// Subscription objects may carry org metadata before
		// checkout.session.completed links stripe_customer_id. Unlinked
		// team refresh throws (Stripe retries forever); unlinked personal
		// refresh no-ops the UPDATE but still runs forgive/email/Discord,
		// which checkout then repeats. Defer both until the customer is linked.
		if (
			(user?.id != null || org?.id) &&
			org?.stripe_customer_id !== customerId
		) {
			console.info('stripe_webhook_subscription_org_not_linked_yet', {
				orgId: org?.id ?? orgOrUserHint,
				customerId,
			})
			return
		}
		if (user?.id != null) {
			const resolved = await refreshStripePlanForUser({
				env: input.env,
				userId: user.id,
				customerId,
				now: input.now,
			})
			result = { userId: user.id, orgId: orgOrUserHint, resolved }
		} else if (org?.id) {
			const resolved = await refreshStripePlanForOrg({
				env: input.env,
				orgId: org.id,
				customerId,
				now: input.now,
			})
			result = { userId: null, orgId: org.id, resolved }
		}
	}
	if (result.userId == null && result.orgId == null) {
		console.error('stripe_webhook_subscription_user_not_found', { customerId })
	}
}

async function handleInvoicePaymentFailed(input: {
	env: Env
	object: Record<string, unknown>
	now?: Date
}) {
	const parsed = parseSafe(customerObjectSchema, input.object)
	const customerId =
		(parsed.success ? readCustomerId(parsed.value.customer) : null) ??
		readStringField(input.object, 'customer')
	if (!customerId) {
		console.error('stripe_webhook_invoice_missing_customer')
		return
	}
	const result = await refreshStripePlanForStripeCustomer({
		env: input.env,
		customerId,
		now: input.now,
	})
	const orgId =
		result.orgId ??
		(result.userId != null
			? (
					await input.env.APP_DB.prepare(
						`SELECT stable_user_id FROM users WHERE id = ?${andLiveDeletedAtSql()}`,
					)
						.bind(result.userId)
						.first<{ stable_user_id: string }>()
				)?.stable_user_id
			: null)
	if (!orgId) {
		console.error('stripe_webhook_invoice_user_not_found', { customerId })
		return
	}
	const subscriptionStatus = result.resolved?.subscriptionStatus ?? null
	console.error('stripe_webhook_invoice_payment_failed', {
		userId: result.userId,
		orgId,
		customerId,
		subscriptionStatus,
	})
	// refreshStripePlanForUser already sends past-due when Stripe has moved
	// the subscription there. Skip the invoice-specific mail in that case so
	// one failed charge is not two emails.
	if (subscriptionStatus === 'past_due' || subscriptionStatus === 'unpaid') {
		return
	}
	const day = utcDayKey(input.now ?? new Date())
	waitUntil(
		sendToOrgBillingRecipients({
			db: input.env.APP_DB,
			orgId,
			sendOne: async (recipient) => {
				await sendPaymentFailedEmail({
					env: input.env,
					email: recipient.email,
					userId: recipient.userId,
					orgSlug: await readSignupOrgSlug(input.env.APP_DB, orgId),
					day,
				})
			},
		}).catch((error) => {
			console.warn('billing-payment-failed-email-failed', error)
		}),
	)
}

export async function latestReferrerPaidPeriodEnd(input: {
	env: Env
	referrerStableUserId: string
}): Promise<string | null> {
	const row = await input.env.APP_DB.prepare(
		`SELECT stripe_customer_id FROM orgs WHERE id = ? AND deleted_at IS NULL`,
	)
		.bind(input.referrerStableUserId)
		.first<{ stripe_customer_id: string | null }>()
	const customerId = row?.stripe_customer_id?.trim()
	if (!customerId) return null
	const subscriptions = selectKodyPlanRetainingSubscriptions(
		input.env,
		await listSubscriptions(input.env, customerId),
	)
	let latest: string | null = null
	for (const subscription of subscriptions) {
		const iso = unixSecondsToIso(
			readStripeSubscriptionPeriodEndUnix(subscription),
		)
		if (!iso) continue
		if (!latest || Date.parse(iso) > Date.parse(latest)) latest = iso
	}
	return latest
}

async function handleInvoicePaid(input: {
	env: Env
	object: Record<string, unknown>
	now?: Date
}) {
	const customerId = readStripeInvoiceCustomerId(input.object)
	const invoiceId = readStripeInvoiceId(input.object)
	if (!customerId || !invoiceId) {
		console.error('stripe_webhook_invoice_paid_missing_ids')
		return
	}
	const subscriptionId = readStripeInvoiceSubscriptionId(input.object)
	const qualifies = isQualifyingPaidReferralInvoice({
		status: input.object.status,
		paid: input.object.paid,
		amount_paid: input.object.amount_paid,
		billing_reason: input.object.billing_reason,
		subscription: subscriptionId,
		metadata:
			input.object.metadata && typeof input.object.metadata === 'object'
				? (input.object.metadata as Record<string, string>)
				: null,
	})
	if (!qualifies) return

	const user = await input.env.APP_DB.prepare(
		`SELECT id AS stable_user_id FROM orgs WHERE stripe_customer_id = ? AND deleted_at IS NULL`,
	)
		.bind(customerId)
		.first<{ stable_user_id: string }>()
	if (!user?.stable_user_id) {
		// Soft-deleted (or unlinked) accounts must not fail the webhook: Stripe
		// retries and can disable the endpoint for every customer. Soft-delete
		// cancels Kody subscriptions; acknowledge and skip referral handling.
		console.error('stripe_webhook_invoice_paid_user_not_linked', {
			customerId,
		})
		return
	}

	await input.env.APP_DB.prepare(
		`UPDATE orgs
		 SET referral_first_paid_at = COALESCE(referral_first_paid_at, ?)
		 WHERE id = ? AND deleted_at IS NULL`,
	)
		.bind((input.now ?? new Date()).toISOString(), user.stable_user_id)
		.run()

	const pending = await input.env.APP_DB.prepare(
		`SELECT referrer_stable_user_id
		 FROM referrals
		 WHERE referee_stable_user_id = ? AND status = 'pending'`,
	)
		.bind(user.stable_user_id)
		.first<{ referrer_stable_user_id: string }>()
	if (pending) {
		const referrerPaidPeriodEndAt = await latestReferrerPaidPeriodEnd({
			env: input.env,
			referrerStableUserId: pending.referrer_stable_user_id,
		})
		await rewardReferralForPaidInvoice({
			db: input.env.APP_DB,
			refereeStableUserId: user.stable_user_id,
			invoiceId,
			invoiceQualifies: true,
			paidPeriodEndAt: readStripeInvoicePeriodEndIso(input.object),
			referrerPaidPeriodEndAt,
			now: input.now,
		})
	}

	const heldAsReferrer = await input.env.APP_DB.prepare(
		`SELECT referee_stable_user_id, held_invoice_id, held_period_end_at
		 FROM referrals
		 WHERE referrer_stable_user_id = ?
		   AND status = 'pending'
		   AND held_invoice_id IS NOT NULL`,
	)
		.bind(user.stable_user_id)
		.all<{
			referee_stable_user_id: string
			held_invoice_id: string | null
			held_period_end_at: string | null
		}>()
	const heldRows = heldAsReferrer.results ?? []
	if (heldRows.length === 0) return

	const referrerPaidPeriodEndAt = await latestReferrerPaidPeriodEnd({
		env: input.env,
		referrerStableUserId: user.stable_user_id,
	})
	for (const row of heldRows) {
		if (!row.held_invoice_id) continue
		await rewardReferralForPaidInvoice({
			db: input.env.APP_DB,
			refereeStableUserId: row.referee_stable_user_id,
			invoiceId: row.held_invoice_id,
			invoiceQualifies: true,
			paidPeriodEndAt: row.held_period_end_at,
			referrerPaidPeriodEndAt,
			now: input.now,
		})
	}
}

export async function processStripeWebhookEvent(input: {
	env: Env
	eventType: string
	object: Record<string, unknown>
	now?: Date
}): Promise<void> {
	switch (input.eventType) {
		case 'checkout.session.completed':
			await handleCheckoutSessionCompleted({
				env: input.env,
				object: input.object,
				now: input.now,
			})
			return
		case 'checkout.session.expired': {
			const sessionId = input.object.id
			if (typeof sessionId !== 'string' || !sessionId) return
			await releasePromoReservationForCheckoutSession({
				db: input.env.APP_DB,
				checkoutSessionId: sessionId,
			})
			return
		}
		case 'customer.subscription.updated':
		case 'customer.subscription.deleted':
			await handleCustomerSubscriptionChange({
				env: input.env,
				object: input.object,
				now: input.now,
			})
			return
		case 'invoice.payment_failed':
			await handleInvoicePaymentFailed({
				env: input.env,
				object: input.object,
				now: input.now,
			})
			return
		case 'invoice.paid':
			await handleInvoicePaid({
				env: input.env,
				object: input.object,
				now: input.now,
			})
			return
		default:
			// Unknown types are acknowledged after a successful process+record.
			return
	}
}

/**
 * Full HTTP handler body for POST /webhooks/stripe.
 * Uses the raw request text for signature verification.
 */
export async function handleStripeWebhookRequest(input: {
	env: Env
	request: Request
	now?: Date
}): Promise<StripeWebhookProcessResult> {
	const secret = input.env.STRIPE_WEBHOOK_SECRET?.trim()
	if (!secret) {
		return {
			status: 503,
			body: { ok: false, error: 'Stripe webhooks are not configured.' },
		}
	}

	if (!isBillingConfigured(input.env)) {
		return {
			status: 503,
			body: { ok: false, error: 'Stripe billing is not configured.' },
		}
	}

	const rawBody = await input.request.text()
	try {
		await verifyStripeWebhookSignature({
			secret,
			signatureHeader: input.request.headers.get('stripe-signature'),
			rawBody,
			nowSeconds: input.now
				? Math.floor(input.now.valueOf() / 1000)
				: undefined,
		})
	} catch (error) {
		if (error instanceof StripeWebhookSignatureError) {
			return {
				status: 400,
				body: { ok: false, error: error.message },
			}
		}
		throw error
	}

	let parsedJson: unknown
	try {
		parsedJson = JSON.parse(rawBody) as unknown
	} catch {
		return {
			status: 400,
			body: { ok: false, error: 'Invalid JSON payload.' },
		}
	}

	const parsedEvent = parseSafe(stripeEventSchema, parsedJson)
	if (!parsedEvent.success) {
		return {
			status: 400,
			body: { ok: false, error: 'Unexpected Stripe event shape.' },
		}
	}

	const event = parsedEvent.value
	try {
		await processStripeWebhookEvent({
			env: input.env,
			eventType: event.type,
			object: event.data.object,
			now: input.now,
		})
	} catch (error) {
		console.error('stripe_webhook_process_failed', {
			eventId: event.id,
			eventType: event.type,
			error: error instanceof Error ? error.message : String(error),
		})
		return {
			status: 500,
			body: { ok: false, error: 'Failed to process Stripe webhook event.' },
		}
	}

	const record = await recordStripeWebhookEvent({
		env: input.env,
		eventId: event.id,
		eventType: event.type,
		now: input.now,
	})
	if (record === 'duplicate') {
		return { status: 200, body: { ok: true, duplicate: true } }
	}

	return { status: 200, body: { ok: true } }
}
