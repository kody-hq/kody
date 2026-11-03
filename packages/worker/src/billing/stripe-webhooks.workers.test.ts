import { env } from 'cloudflare:test'
import { expect, test, vi } from 'vitest'
import { silenceExpectedConsoleErrors } from '#worker/test-support/console-spies.ts'
import { createBillingLinkReference } from './billing-config.ts'
import { buildStripeWebhookSignatureHeader } from './stripe-webhook-signature.ts'
import { handleStripeWebhookRequest } from './stripe-webhooks.ts'
import { readCreditWallet } from './credit-wallet.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { ensureCreditWalletTestSchema } from './test-schema.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'

const webhookSecret = 'whsec_test_workers_secret'
const now = new Date('2026-07-25T12:00:00.000Z')
const processFailed = {
	status: 500,
	body: { ok: false, error: 'Failed to process Stripe webhook event.' },
}

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function createWebhookEnv(overrides: Partial<Env> = {}): Env {
	const testProPriceId: string = 'price_pro'
	return {
		...env,
		STRIPE_SECRET_KEY: 'sk_test_secret',
		STRIPE_WEBHOOK_SECRET: webhookSecret,
		STRIPE_PRO_PRICE_ID: testProPriceId,
		STRIPE_API_BASE_URL: 'https://stripe.mock',
		...overrides,
	} as Env
}

async function seedUser(input: {
	email: string
	stripeCustomerId?: string | null
	stripePlan?: string | null
}) {
	await ensureCreditWalletTestSchema(env.APP_DB)
	const stableUserId = testStableUserIdFromEmail(input.email)
	const username = `wh-${crypto.randomUUID().slice(0, 8)}`
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id
		) VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(
			username,
			input.email,
			'test-password-hash',
			now.toISOString(),
			stableUserId,
		)
		.run()
	await provisionPersonalOrg(env.APP_DB, {
		stableUserId,
		username,
		plan: 'free',
		stripeCustomerId: input.stripeCustomerId ?? null,
		stripePlan: input.stripePlan ?? null,
		createdAt: now.toISOString(),
	})
	const row = await env.APP_DB.prepare(`SELECT id FROM users WHERE email = ?`)
		.bind(input.email)
		.first<{ id: number }>()
	if (!row) throw new Error(`Failed to seed user ${input.email}`)
	return {
		id: row.id,
		stableUserId,
		linkReference: await createBillingLinkReference(env, stableUserId),
	}
}

type SeededUser = Awaited<ReturnType<typeof seedUser>>

async function seedReferral(
	referrer: SeededUser,
	referee: SeededUser,
	createdAt: string,
	held?: { invoiceId: string; periodEndAt: string },
) {
	await env.APP_DB.prepare(
		`INSERT INTO referrals (
			referrer_stable_user_id, referee_stable_user_id, created_at, status,
			held_invoice_id, held_period_end_at
		) VALUES (?, ?, ?, 'pending', ?, ?)`,
	)
		.bind(
			referrer.stableUserId,
			referee.stableUserId,
			createdAt,
			held?.invoiceId ?? null,
			held?.periodEndAt ?? null,
		)
		.run()
}

function readReferral<T>(referee: SeededUser, columns: string) {
	return env.APP_DB.prepare(
		`SELECT ${columns} FROM referrals WHERE referee_stable_user_id = ?`,
	)
		.bind(referee.stableUserId)
		.first<T>()
}

function readUserBilling(userId: number) {
	return env.APP_DB.prepare(
		`SELECT o.stripe_customer_id, o.stripe_plan, o.stripe_plan_refreshed_at
		 FROM users u
		 INNER JOIN orgs o ON o.id = u.stable_user_id
		 WHERE u.id = ?`,
	)
		.bind(userId)
		.first()
}

function readWebhookEvent(eventId: string) {
	return env.APP_DB.prepare(
		`SELECT event_id, event_type FROM stripe_webhook_events WHERE event_id = ?`,
	)
		.bind(eventId)
		.first()
}

function subscriptionList(id: string, status: string, item = {}) {
	return {
		data: [
			{
				id,
				status,
				cancel_at: null,
				items: { data: [{ price: { id: 'price_pro' }, ...item }] },
			},
		],
	}
}

function stubFetch(
	handler: (
		url: string,
		init?: RequestInit,
		request?: RequestInfo | URL,
	) => Response | Promise<Response>,
) {
	const fetchStub = vi.fn(
		async (request: RequestInfo | URL, init?: RequestInit) =>
			handler(String(request), init, request),
	)
	vi.stubGlobal('fetch', fetchStub)
	return Object.assign(fetchStub, {
		[Symbol.dispose]: () => vi.unstubAllGlobals(),
	})
}

function stubStripeFetch(input: {
	checkout?: unknown
	subscriptions: unknown
}) {
	return stubFetch((url, init) => {
		if (url.includes('/v1/checkout/sessions/')) {
			return jsonResponse(input.checkout)
		}
		if (
			url.includes('/v1/customers/') &&
			(init?.method ?? 'GET').toUpperCase() === 'POST'
		) {
			return jsonResponse({ id: 'cus_metadata' })
		}
		if (url.includes('/v1/subscriptions')) {
			return jsonResponse(input.subscriptions)
		}
		return jsonResponse({ error: 'unexpected stripe path' }, 500)
	})
}

const stripeDown = () =>
	stubFetch(() => jsonResponse({ error: 'stripe down' }, 500))

const noFetch = (reason: string) =>
	stubFetch(() => {
		throw new Error(`fetch should not run for ${reason}`)
	})

async function deliver(
	event: Record<string, unknown>,
	secret = webhookSecret,
	envOverrides: Partial<Env> = {},
) {
	const rawBody = JSON.stringify(event)
	const signature = await buildStripeWebhookSignatureHeader({
		secret,
		rawBody,
		timestamp: Math.floor(now.valueOf() / 1000),
	})
	return handleStripeWebhookRequest({
		env: createWebhookEnv(envOverrides),
		request: new Request('https://test.kody.dev/webhooks/stripe', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'stripe-signature': signature,
			},
			body: rawBody,
		}),
		now,
	})
}

function invoicePaid(
	id: string,
	created: number,
	invoice: {
		id: string
		customer: string
		subscription: string
		amount_paid: number
		billing_reason?: string
	},
) {
	return {
		id,
		type: 'invoice.paid',
		created,
		data: {
			object: {
				object: 'invoice',
				status: 'paid',
				billing_reason: 'subscription_create',
				...invoice,
			},
		},
	}
}

test('stripe webhook verifies signature, links checkout, refreshes subscription, and is idempotent', async () => {
	// Guard: returns 503 when webhook secret is not configured.
	await ensureCreditWalletTestSchema(env.APP_DB)
	const unconfigured = await handleStripeWebhookRequest({
		env: createWebhookEnv({ STRIPE_WEBHOOK_SECRET: '' }),
		request: new Request('https://test.kody.dev/webhooks/stripe', {
			method: 'POST',
			body: '{}',
		}),
		now,
	})
	expect(unconfigured.status).toBe(503)
	expect(unconfigured.body.ok).toBe(false)

	// Main journey: checkout completion, subscription update, unknown event, bad signature.
	const email = `wh-checkout-${crypto.randomUUID()}@example.com`
	const user = await seedUser({ email })
	const checkoutSession = {
		id: 'cs_webhook',
		customer: 'cus_webhook',
		client_reference_id: user.linkReference,
	}
	const checkoutEvent = {
		id: `evt_checkout_${crypto.randomUUID()}`,
		type: 'checkout.session.completed',
		data: {
			object: {
				...checkoutSession,
				customer_email: email,
				metadata: { kody_org_id: user.stableUserId },
			},
		},
	}
	const linkedPro = {
		stripe_customer_id: 'cus_webhook',
		stripe_plan: 'pro',
		stripe_plan_refreshed_at: now.toISOString(),
	}
	{
		using _fetch = stubStripeFetch({
			checkout: checkoutSession,
			subscriptions: subscriptionList('sub_webhook', 'active'),
		})
		expect(await deliver(checkoutEvent)).toEqual({
			status: 200,
			body: { ok: true },
		})
		expect(await readUserBilling(user.id)).toEqual(linkedPro)
		expect(await readWebhookEvent(checkoutEvent.id)).toEqual({
			event_id: checkoutEvent.id,
			event_type: 'checkout.session.completed',
		})
		expect(await deliver(checkoutEvent)).toEqual({
			status: 200,
			body: { ok: true, duplicate: true },
		})
	}

	using _fetch = stubStripeFetch({
		subscriptions: subscriptionList('sub_webhook', 'past_due'),
	})
	const updated = await deliver({
		id: `evt_sub_${crypto.randomUUID()}`,
		type: 'customer.subscription.updated',
		data: {
			object: {
				id: 'sub_webhook',
				customer: 'cus_webhook',
				status: 'past_due',
			},
		},
	})
	expect(updated).toEqual({ status: 200, body: { ok: true } })
	// past_due keeps paid entitlements through Stripe's dunning window.
	expect(await readUserBilling(user.id)).toEqual(linkedPro)

	const unknownEvent = {
		id: `evt_unknown_${crypto.randomUUID()}`,
		type: 'radar.early_fraud_warning.created',
		data: { object: { id: 'issfr_1' } },
	}
	expect(await deliver(unknownEvent)).toEqual({
		status: 200,
		body: { ok: true },
	})
	expect(await readWebhookEvent(unknownEvent.id)).toEqual({
		event_id: unknownEvent.id,
		event_type: 'radar.early_fraud_warning.created',
	})

	const badSig = await deliver(
		{
			id: `evt_bad_${crypto.randomUUID()}`,
			type: 'checkout.session.completed',
			data: { object: { id: 'cs_x' } },
		},
		'whsec_wrong_secret',
	)
	expect(badSig.status).toBe(400)
	expect(badSig.body.ok).toBe(false)
})

test('stripe webhook process failure returns 500 without recording the event', async () => {
	silenceExpectedConsoleErrors([
		'stripe_api_error',
		'stripe_webhook_process_failed',
	])
	const user = await seedUser({
		email: `wh-fail-${crypto.randomUUID()}@example.com`,
		stripeCustomerId: 'cus_fail_retry',
	})
	const eventId = `evt_fail_${crypto.randomUUID()}`
	const event = {
		id: eventId,
		type: 'customer.subscription.updated',
		data: {
			object: { id: 'sub_fail', customer: 'cus_fail_retry', status: 'active' },
		},
	}
	{
		using _fetch = stripeDown()
		const result = await deliver(event)
		expect(result.status).toBe(500)
		expect(result.body.ok).toBe(false)
		expect(await readWebhookEvent(eventId)).toBeNull()
	}

	// A later delivery must still be able to process after the failed attempt
	// (no stuck claim that would ack duplicates with 200).
	using _fetch = stubStripeFetch({
		subscriptions: subscriptionList('sub_fail', 'active'),
	})
	expect(await deliver(event)).toEqual({ status: 200, body: { ok: true } })
	expect(await readWebhookEvent(eventId)).toEqual({
		event_id: eventId,
		event_type: 'customer.subscription.updated',
	})
	expect(await readUserBilling(user.id)).toMatchObject({
		stripe_customer_id: 'cus_fail_retry',
		stripe_plan: 'pro',
	})
})

test('invoice.paid rewards both parties once and ignores $0 trial invoices', async () => {
	const referrer = await seedUser({
		email: 'referrer-invoice-paid@example.com',
	})
	const referee = await seedUser({
		email: 'referee-invoice-paid@example.com',
		stripeCustomerId: 'cus_referral_invoice_paid',
	})
	await seedReferral(referrer, referee, '2026-09-07T00:00:00.000Z')
	using _fetch = noFetch('invoice.paid')
	const refereeInvoice = (id: string, amount_paid: number) => ({
		id,
		customer: 'cus_referral_invoice_paid',
		subscription: 'sub_referral',
		amount_paid,
	})
	const rewardState = () => readReferral(referee, 'status, reward_invoice_id')

	expect(
		await deliver(
			invoicePaid(
				'evt_invoice_trial',
				1_778_000_000,
				refereeInvoice('in_trial', 0),
			),
		),
	).toEqual({ status: 200, body: { ok: true } })
	expect(await rewardState()).toEqual({
		status: 'pending',
		reward_invoice_id: null,
	})

	expect(
		await deliver(
			invoicePaid(
				'evt_invoice_paid',
				1_778_000_100,
				refereeInvoice('in_paid', 2000),
			),
		),
	).toEqual({ status: 200, body: { ok: true } })
	const rewarded = { status: 'rewarded', reward_invoice_id: 'in_paid' }
	expect(await rewardState()).toEqual(rewarded)
	const expiries = await env.APP_DB.prepare(
		`SELECT o.referral_standard_credit_expires_at
		 FROM users u
		 INNER JOIN orgs o ON o.id = u.stable_user_id
		 WHERE u.id IN (?, ?)`,
	)
		.bind(referrer.id, referee.id)
		.all()
	expect(expiries.results).toEqual([
		{ referral_standard_credit_expires_at: '2026-08-24T12:00:00.000Z' },
		{ referral_standard_credit_expires_at: '2026-08-24T12:00:00.000Z' },
	])

	expect(
		await deliver(
			invoicePaid(
				'evt_invoice_paid_replay',
				1_778_000_100,
				refereeInvoice('in_paid_later', 2000),
			),
		),
	).toEqual({ status: 200, body: { ok: true } })
	expect(await rewardState()).toEqual(rewarded)
})

test('invoice.paid acks when a qualifying invoice has no linked live user', async () => {
	await ensureCreditWalletTestSchema(env.APP_DB)
	silenceExpectedConsoleErrors(['stripe_webhook_invoice_paid_user_not_linked'])
	using _fetch = noFetch('an unlinked invoice.paid')
	const result = await deliver(
		invoicePaid('evt_invoice_unlinked', 1_778_000_200, {
			id: 'in_unlinked',
			customer: 'cus_not_linked_yet',
			subscription: 'sub_unlinked',
			amount_paid: 1200,
		}),
	)
	// Soft-deleted / unlinked customers must not 500: Stripe retries disable
	// the webhook endpoint for every customer.
	expect(result).toEqual({ status: 200, body: { ok: true } })
})

test('invoice.paid acks soft-deleted customers without rewarding referrals', async () => {
	silenceExpectedConsoleErrors(['stripe_webhook_invoice_paid_user_not_linked'])
	const referrer = await seedUser({
		email: 'referrer-soft-deleted@example.com',
	})
	const referee = await seedUser({
		email: 'referee-soft-deleted@example.com',
		stripeCustomerId: 'cus_soft_deleted_invoice',
	})
	await seedReferral(referrer, referee, '2026-09-07T00:00:00.000Z')
	await env.APP_DB.prepare(`UPDATE users SET deleted_at = ? WHERE id = ?`)
		.bind(now.toISOString(), referee.id)
		.run()
	using _fetch = noFetch('soft-deleted invoice.paid')
	const result = await deliver(
		invoicePaid('evt_invoice_soft_deleted', 1_778_000_250, {
			id: 'in_soft_deleted',
			customer: 'cus_soft_deleted_invoice',
			subscription: 'sub_soft_deleted',
			amount_paid: 1200,
		}),
	)
	expect(result).toEqual({ status: 200, body: { ok: true } })
	expect(await readReferral(referee, 'status, reward_invoice_id')).toEqual({
		status: 'pending',
		reward_invoice_id: null,
	})
})

test('invoice.paid returns 500 when the referrer paid period cannot be loaded', async () => {
	silenceExpectedConsoleErrors([
		'stripe_webhook_process_failed',
		'stripe_api_error',
	])
	const referrer = await seedUser({
		email: 'referrer-period-fail@example.com',
		stripeCustomerId: 'cus_referrer_period_fail',
		stripePlan: 'standard',
	})
	const referee = await seedUser({
		email: 'referee-period-fail@example.com',
		stripeCustomerId: 'cus_referee_period_fail',
	})
	await seedReferral(referrer, referee, now.toISOString())
	using _fetch = stripeDown()

	const result = await deliver(
		invoicePaid('evt_invoice_referrer_period_fail', 1_778_000_300, {
			id: 'in_referrer_period_fail',
			customer: 'cus_referee_period_fail',
			subscription: 'sub_referrer_period_fail',
			amount_paid: 2000,
		}),
	)
	expect(result).toEqual(processFailed)
	expect(await readWebhookEvent('evt_invoice_referrer_period_fail')).toBeNull()
	expect(await readReferral(referee, 'status, credits_granted_at')).toEqual({
		status: 'pending',
		credits_granted_at: null,
	})
})

test('invoice.paid for a referrer retries held outgoing referrals', async () => {
	const referrer = await seedUser({
		email: 'referrer-held-retry@example.com',
		stripeCustomerId: 'cus_referrer_held_retry',
		stripePlan: 'standard',
	})
	const referee = await seedUser({
		email: 'referee-held-retry@example.com',
		stripeCustomerId: 'cus_referee_held_retry',
	})
	await seedReferral(referrer, referee, now.toISOString(), {
		invoiceId: 'in_held_retry',
		periodEndAt: '2026-08-01T00:00:00.000Z',
	})
	using _fetch = stubStripeFetch({
		subscriptions: subscriptionList('sub_referrer_held_retry', 'active', {
			current_period_end: 1_781_568_000,
		}),
	})

	const result = await deliver(
		invoicePaid('evt_referrer_held_retry', 1_778_000_400, {
			id: 'in_referrer_own',
			customer: 'cus_referrer_held_retry',
			subscription: 'sub_referrer_held_retry',
			amount_paid: 2000,
			billing_reason: 'subscription_cycle',
		}),
	)
	expect(result).toEqual({ status: 200, body: { ok: true } })
	expect(await readReferral(referee, 'status, reward_invoice_id')).toEqual({
		status: 'rewarded',
		reward_invoice_id: 'in_held_retry',
	})
})

test('checkout.session.completed for a credit top-up credits the wallet once and never links a subscription', async () => {
	await ensureCreditWalletTestSchema(env.APP_DB)
	const user = await seedUser({
		email: `wh-credits-${crypto.randomUUID()}@example.com`,
		stripeCustomerId: `cus_${crypto.randomUUID().slice(0, 8)}`,
		stripePlan: 'pro',
	})
	const sessionId = `cs_credit_${crypto.randomUUID().slice(0, 8)}`
	const session = {
		id: sessionId,
		customer: 'cus_any',
		client_reference_id: user.linkReference,
		metadata: {
			kody_credit_top_up: '1',
			kody_org_id: user.stableUserId,
		},
	}
	using fetchStub = stubFetch((url) =>
		url.includes(`/v1/checkout/sessions/${sessionId}`)
			? jsonResponse({
					...session,
					mode: 'payment',
					status: 'complete',
					payment_status: 'paid',
					amount_total: 2_500,
					currency: 'usd',
					payment_intent: { id: 'pi_credit', payment_method: 'pm_card' },
				})
			: jsonResponse({ error: 'unexpected stripe path' }, 500),
	)
	for (const eventId of ['evt_credit_1', 'evt_credit_2']) {
		const result = await deliver({
			id: eventId,
			type: 'checkout.session.completed',
			data: { object: session },
		})
		expect(result.status).toBe(200)
	}
	const wallet = await readCreditWallet(env.APP_DB, user.stableUserId)
	expect(wallet.balanceMicroUsd).toBe(25_000_000)
	expect(wallet.autoRefillPaymentMethodId).toBe('pm_card')
	expect(
		fetchStub.mock.calls.some(([request]) =>
			String(request).includes('/v1/subscriptions'),
		),
	).toBe(false)
})

test('subscription.updated with team org metadata defers until the customer is linked', async () => {
	await ensureOrgsTestSchema(env.APP_DB)
	const teamOrgId = testStableUserIdFromEmail(
		`team-unlinked-wh-${crypto.randomUUID()}@example.com`,
	)
	await env.APP_DB.prepare(
		`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
		 VALUES (?, ?, 'free', ?, ?)`,
	)
		.bind(
			teamOrgId,
			`team-${teamOrgId.slice(0, 8)}`,
			now.toISOString(),
			now.toISOString(),
		)
		.run()
	// No Stripe listSubscriptions: refresh must not run before checkout link.
	using _fetch = noFetch('unlinked team subscription.updated')
	const result = await deliver({
		id: `evt_team_meta_${crypto.randomUUID()}`,
		type: 'customer.subscription.updated',
		data: {
			object: {
				id: 'sub_team_meta',
				customer: 'cus_team_meta',
				status: 'active',
				metadata: {
					kody_org_id: ownerIdFromStored(teamOrgId),
				},
			},
		},
	})
	expect(result).toEqual({ status: 200, body: { ok: true } })
	const org = await env.APP_DB.prepare(
		`SELECT stripe_customer_id, stripe_plan FROM orgs WHERE id = ?`,
	)
		.bind(teamOrgId)
		.first<{ stripe_customer_id: string | null; stripe_plan: string | null }>()
	expect(org).toEqual({ stripe_customer_id: null, stripe_plan: null })
})

test('subscription.updated before personal checkout link defers side effects until checkout', async () => {
	const email = `wh-personal-race-${crypto.randomUUID()}@example.com`
	const user = await seedUser({ email })
	const customerId = 'cus_personal_race'
	const checkoutSessionId = 'cs_personal_race'
	const sideEffectEnv = {
		DISCORD_BOT_TOKEN: 'bot-token-test',
		DISCORD_GUILD_ID: '111111111111111111',
		DISCORD_MEMBER_ROLE_ID: '222222222222222222',
		DISCORD_STANDARD_ROLE_ID: '444444444444444444',
		DISCORD_PRO_ROLE_ID: '555555555555555555',
		APP_BASE_URL: 'https://kody.codes',
		SYSTEM_EMAIL_DOMAIN: 'kody.codes',
		CLOUDFLARE_ACCOUNT_ID: 'account-123',
		CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test',
		CLOUDFLARE_API_TOKEN: 'token-123',
	} satisfies Partial<Env>

	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS oauth_connections (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			provider_name TEXT NOT NULL,
			provider_id TEXT NOT NULL,
			user_id INTEGER NOT NULL,
			provider_display_name TEXT,
			created_at TEXT,
			updated_at TEXT
		)`,
	).run()
	await env.APP_DB.prepare(
		`INSERT INTO oauth_connections (provider_name, provider_id, user_id)
		 VALUES ('discord', '333333333333333333', ?)`,
	)
		.bind(user.id)
		.run()
	// Usage above the free include so unlock forgiveness writes progress rows.
	await env.APP_DB.prepare(
		`INSERT INTO usage_rollups (user_id, metric, month, event_count)
		 VALUES (?, 'dynamic_worker_day', '2026-07', 900)`,
	)
		.bind(user.stableUserId)
		.run()

	const counts = {
		subscriptionLists: 0,
		discordRoleWrites: 0,
		billingSuccessEmails: 0,
	}
	using _fetch = stubFetch((url, init) => {
		if (url.includes('/v1/subscriptions')) {
			counts.subscriptionLists += 1
			return jsonResponse(subscriptionList('sub_personal_race', 'active'))
		}
		if (url.includes('/v1/checkout/sessions/')) {
			return jsonResponse({
				id: checkoutSessionId,
				customer: customerId,
				client_reference_id: user.linkReference,
			})
		}
		if (
			url.includes('/v1/customers/') &&
			(init?.method ?? 'GET').toUpperCase() === 'POST'
		) {
			return jsonResponse({ id: customerId })
		}
		if (url.includes('discord.com/api/v10/guilds/')) {
			counts.discordRoleWrites += 1
			return new Response(null, { status: 204 })
		}
		if (url.includes('/email/sending/send')) {
			counts.billingSuccessEmails += 1
			return jsonResponse({
				success: true,
				result: { message_id: 'msg_personal_race' },
			})
		}
		return jsonResponse({ error: 'unexpected path' }, 500)
	})

	const subscriptionMetadata = {
		kody_org_id: ownerIdFromStored(user.stableUserId),
	}
	const progressCount = () =>
		env.APP_DB.prepare(
			`SELECT COUNT(*) AS n FROM credit_debit_progress WHERE user_id = ?`,
		)
			.bind(user.stableUserId)
			.first<{ n: number }>()

	// Race: subscription.updated arrives before checkout.session.completed.
	expect(
		await deliver(
			{
				id: `evt_personal_race_sub_${crypto.randomUUID()}`,
				type: 'customer.subscription.updated',
				data: {
					object: {
						id: 'sub_personal_race',
						customer: customerId,
						status: 'active',
						metadata: subscriptionMetadata,
					},
				},
			},
			webhookSecret,
			sideEffectEnv,
		),
	).toEqual({ status: 200, body: { ok: true } })
	expect(await readUserBilling(user.id)).toEqual({
		stripe_customer_id: null,
		stripe_plan: null,
		stripe_plan_refreshed_at: null,
	})
	expect(counts).toEqual({
		subscriptionLists: 0,
		discordRoleWrites: 0,
		billingSuccessEmails: 0,
	})
	expect(await progressCount()).toEqual({ n: 0 })

	expect(
		await deliver(
			{
				id: `evt_personal_race_checkout_${crypto.randomUUID()}`,
				type: 'checkout.session.completed',
				data: {
					object: {
						id: checkoutSessionId,
						customer: customerId,
						client_reference_id: user.linkReference,
						customer_email: email,
						metadata: subscriptionMetadata,
					},
				},
			},
			webhookSecret,
			sideEffectEnv,
		),
	).toEqual({ status: 200, body: { ok: true } })
	expect(await readUserBilling(user.id)).toEqual({
		stripe_customer_id: customerId,
		stripe_plan: 'pro',
		stripe_plan_refreshed_at: now.toISOString(),
	})
	await vi.waitFor(() => {
		expect(counts.discordRoleWrites).toBe(3)
		expect(counts.billingSuccessEmails).toBe(1)
	})
	// One refresh after the link: Stripe list once, Discord sync once,
	// billing-success email once, credit forgiveness once.
	expect(counts).toEqual({
		subscriptionLists: 1,
		discordRoleWrites: 3,
		billingSuccessEmails: 1,
	})
	const forgiven = await progressCount()
	expect(forgiven?.n).toBeGreaterThan(0)
})

test('checkout.session.expired releases a reserved promo claim but never a finalized one', async () => {
	const reserved = `promo-reserved-${crypto.randomUUID()}`
	const claimed = `promo-claimed-${crypto.randomUUID()}`
	await env.APP_DB.prepare(
		`INSERT INTO billing_promo_claims
		 (user_id, promotion_code_id, org_id, status, checkout_session_id, reserved_at, claimed_at)
		 VALUES (?, 'promo_1', 'org-a', 'reserved', 'cs_expired_reserved', ?, NULL),
		        (?, 'promo_1', 'org-b', 'claimed', 'cs_expired_claimed', ?, ?)`,
	)
		.bind(
			reserved,
			now.toISOString(),
			claimed,
			now.toISOString(),
			now.toISOString(),
		)
		.run()
	for (const sessionId of ['cs_expired_reserved', 'cs_expired_claimed']) {
		expect(
			await deliver({
				id: `evt_expired_${crypto.randomUUID()}`,
				type: 'checkout.session.expired',
				data: { object: { id: sessionId } },
			}),
		).toEqual({ status: 200, body: { ok: true } })
	}
	const rows = await env.APP_DB.prepare(
		`SELECT user_id, status FROM billing_promo_claims WHERE user_id IN (?, ?) ORDER BY user_id`,
	)
		.bind(claimed, reserved)
		.all<{ user_id: string; status: string }>()
	expect(rows.results).toEqual([{ user_id: claimed, status: 'claimed' }])
})
