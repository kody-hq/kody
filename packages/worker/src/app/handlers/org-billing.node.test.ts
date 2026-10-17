import { BillingPlanUnavailableError } from '#app/account-billing-data.ts'
import { completeOrgBillingCheckout } from './org-billing.ts'
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadRequestOrgResolution } from '#app/org-request-binding.ts'
import { createBillingLinkReference } from '#worker/billing/billing-config.ts'
import {
	annualPromoRejection,
	existingSubscriptionPromoRejection,
	promoAlreadyClaimedRejection,
	promoClaimMetadataKeys,
	promoRejectedByStripe,
} from '#worker/billing/checkout-promo.ts'
import type * as StripeClient from '#worker/billing/stripe-client.ts'
import { StripeApiError } from '#worker/billing/stripe-client.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	requireAuthenticatedPageUser: vi.fn(),
	userHasMcpOAuthGrants: vi.fn(async (..._args: Array<unknown>) => false),
	linkStripeCustomerFromCheckoutSessionAttribution:
		vi.fn<(...args: Array<unknown>) => Promise<unknown>>(),
	loadAccountBillingData: vi.fn(async (input: Record<string, unknown>) => ({
		ok: true,
		org: input.org,
		seats: input.seats,
	})),
	createCheckoutSession:
		vi.fn<(...args: Array<unknown>) => Promise<{ id: string; url: string }>>(),
	createBillingPortalSession:
		vi.fn<(...args: Array<unknown>) => Promise<{ url: string }>>(),
	listSubscriptions:
		vi.fn<(...args: Array<unknown>) => Promise<Array<unknown>>>(),
	findActivePromotionCode:
		vi.fn<(...args: Array<unknown>) => Promise<unknown>>(),
	submitPlatformFeedback:
		vi.fn<(...args: Array<unknown>) => Promise<{ id: string }>>(),
	enqueuePlatformFeedbackDispatch:
		vi.fn<(...args: Array<unknown>) => Promise<void>>(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))
vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (...args: Array<unknown>) =>
		mocks.requireAuthenticatedPageUser(...args),
}))
vi.mock('#app/onboarding-data.ts', () => ({
	userHasMcpOAuthGrants: (...args: Array<unknown>) =>
		mocks.userHasMcpOAuthGrants(...args),
}))
vi.mock('#app/account-billing-data.ts', () => ({
	BillingPlanUnavailableError: class BillingPlanUnavailableError extends Error {},
	loadAccountBillingData: (input: Record<string, unknown>) =>
		mocks.loadAccountBillingData(input),
}))
vi.mock('#worker/billing/subscription-sync.ts', () => ({
	BillingLinkError: class BillingLinkError extends Error {
		readonly code: string
		constructor(code: string, message: string) {
			super(message)
			this.code = code
		}
	},
	linkStripeCustomerFromCheckoutSessionAttribution: (...args: Array<unknown>) =>
		mocks.linkStripeCustomerFromCheckoutSessionAttribution(...args),
}))
vi.mock('#worker/platform-feedback/service.ts', () => ({
	submitPlatformFeedback: (...args: Array<unknown>) =>
		mocks.submitPlatformFeedback(...args),
}))
vi.mock('#worker/platform-feedback/dispatch-queue-producer.ts', () => ({
	enqueuePlatformFeedbackDispatch: (...args: Array<unknown>) =>
		mocks.enqueuePlatformFeedbackDispatch(...args),
}))
vi.mock('#worker/billing/stripe-client.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof StripeClient>()
	return {
		...actual,
		createCheckoutSession: (...args: Array<unknown>) =>
			mocks.createCheckoutSession(...args),
		createBillingPortalSession: (...args: Array<unknown>) =>
			mocks.createBillingPortalSession(...args),
		listSubscriptions: (...args: Array<unknown>) =>
			mocks.listSubscriptions(...args),
		findActivePromotionCode: (...args: Array<unknown>) =>
			mocks.findActivePromotionCode(...args),
	}
})

const {
	submitWebsiteCancellationFeedback,
	loadOrgBillingPageData,
	resolveOrgBillingAccess,
	startWebsiteCheckout,
	openWebsiteBillingPortal,
} = await import('./org-billing.ts')

const retiredStandardPriceId = 'price_1U3sg6LAQpAnsYszGeL2nc8O'
const now = '2026-01-01T00:00:00.000Z'

/** Personal org per person, plus `acme` where Ada owns, Bob is a member, and Cara is billing. */
const people = {
	ada: { id: 9, personId: 'person-ada' },
	bob: { id: 10, personId: 'person-bob' },
	cara: { id: 11, personId: 'person-cara' },
	dan: { id: 12, personId: 'person-dan' },
} as const
type Person = keyof typeof people

let sqlite: DatabaseSync
let db: D1Database

async function seed() {
	sqlite = new DatabaseSync(':memory:')
	db = createD1FromSqlite(sqlite)
	await ensureUsersTestSchema({ db })
	for (const [username, person] of Object.entries(people)) {
		sqlite
			.prepare(
				`INSERT INTO users (id, username, email, password_hash, stable_user_id)
				 VALUES (?, ?, ?, 'x', ?)`,
			)
			.run(person.id, username, `${username}@example.com`, person.personId)
		sqlite
			.prepare(
				`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
				 VALUES (?, ?, NULL, ?, ?)`,
			)
			.run(person.personId, username, now, now)
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, 'owner', ?)`,
			)
			.run(person.personId, person.personId, now)
	}
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
			 VALUES ('org-acme', 'acme', 'Acme', ?, ?)`,
		)
		.run(now, now)
	for (const [person, role] of [
		['ada', 'owner'],
		['bob', 'member'],
		['cara', 'billing'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES ('org-acme', ?, ?, ?)`,
			)
			.run(people[person].personId, role, now)
	}
}

function linkCustomer(orgId: string, customerId: string) {
	sqlite
		.prepare(`UPDATE orgs SET stripe_customer_id = ? WHERE id = ?`)
		.run(customerId, orgId)
}

function createEnv(overrides: Record<string, unknown> = {}) {
	return {
		COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123456789',
		STRIPE_SECRET_KEY: 'sk_test_secret',
		STRIPE_PRO_PRICE_ID: 'price_pro',
		STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly',
		APP_DB: db,
		...overrides,
	} as unknown as Env
}

/**
 * Mirrors `readAuthenticatedAppUser`: the request context binds the org the
 * URL names (real resolution against the seeded tables), falling back to
 * the signup org.
 */
function signInAs(person: Person | null) {
	const sign = async (request: Request, env: Env) => {
		if (!person) return null
		const { id, personId } = people[person]
		const mcpUser = {
			userId: personIdFromStored(personId),
			email: `${person}@example.com`,
			displayName: person,
		}
		const resolution = await loadRequestOrgResolution(request, env, personId)
		const orgBinding =
			typeof resolution === 'string'
				? {
						org: { id: personId as never, slug: person },
						role: 'owner' as const,
					}
				: resolution
		return {
			sessionUserId: String(id),
			userId: id,
			username: person,
			email: mcpUser.email,
			emailVerified: true,
			emailVerificationDelivery: null,
			displayName: person,
			roles: ['user'],
			permissions: [],
			artifactOwnerIds: [String(id)],
			mcpUser,
			request: deriveRequestContext({
				user: mcpUser,
				source: { kind: 'session' },
				orgBinding,
			}),
		} satisfies AuthenticatedAppUser
	}
	mocks.readAuthenticatedAppUser.mockImplementation(sign)
	mocks.requireAuthenticatedPageUser.mockImplementation(
		async (request: Request, env: Env) =>
			(await sign(request, env)) ??
			Response.redirect('https://example.com/login', 302),
	)
}

async function readWebsiteBilling(input: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
	orgSlug: string
}) {
	const access = await resolveOrgBillingAccess({
		...input,
		permission: 'billing:read',
	})
	return access.ok
		? {
				status: 200,
				data: await loadOrgBillingPageData({
					...input,
					org: access.org,
					errorCode: new URL(input.request.url).searchParams.get('error'),
					noticeCode: new URL(input.request.url).searchParams.get('billing'),
				}),
			}
		: { status: access.status, data: { ok: false, error: access.error } }
}
async function call<T>(
	operation: (input: {
		env: Env
		request: Request
		user: AuthenticatedAppUser
		orgSlug: string
		body: unknown
	}) => Promise<T>,
	env: Env,
	path: string,
	init?: RequestInit,
) {
	const request = new Request(`https://example.com${path}`, init)
	const user = await mocks.readAuthenticatedAppUser(request, env)
	if (!user) throw new Error('Sign in required.')
	return operation({
		env,
		request,
		user,
		orgSlug: new URL(request.url).pathname.split('/')[1]!.slice(1),
		body: init?.body ? JSON.parse(String(init.body)) : undefined,
	})
}

function postCheckout(env: Env, orgSlug: string, body: unknown) {
	return call(startWebsiteCheckout, env, `/@${orgSlug}/-/billing`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
}

function subscription(input: { id: string; status: string; priceId: string }) {
	return {
		id: input.id,
		status: input.status,
		cancel_at: null,
		items: { data: [{ id: `si_${input.id}`, price: { id: input.priceId } }] },
	}
}

beforeEach(async () => {
	vi.clearAllMocks()
	await seed()
	mocks.createCheckoutSession.mockResolvedValue({
		id: 'cs_test',
		url: 'https://checkout.stripe.com/c/pay/cs_test',
	})
	mocks.createBillingPortalSession.mockResolvedValue({
		url: 'https://billing.stripe.com/p/session/test',
	})
	mocks.listSubscriptions.mockResolvedValue([])
	mocks.findActivePromotionCode.mockResolvedValue(null)
})

test('checkout sells only Pro and picks the monthly or annual price', async () => {
	signInAs(null)
	await expect(
		postCheckout(createEnv(), 'ada', { plan: 'pro' }),
	).rejects.toThrow('Sign in required.')
	expect(mocks.createCheckoutSession).not.toHaveBeenCalled()

	signInAs('ada')
	for (const body of [
		{},
		{ plan: 'standard' },
		{ plan: 'pro', interval: 'week' },
	]) {
		const response = await postCheckout(createEnv(), 'ada', body)
		expect([body, response.status]).toEqual([body, 400])
	}

	const env = createEnv()
	const monthly = await postCheckout(env, 'ada', { plan: 'pro' })
	expect(monthly.status).toBe(200)
	expect(monthly.data).toEqual({
		ok: true,
		url: 'https://checkout.stripe.com/c/pay/cs_test',
		mode: 'checkout',
	})
	expect(mocks.listSubscriptions).not.toHaveBeenCalled()
	expect(mocks.createCheckoutSession).toHaveBeenLastCalledWith(
		env,
		expect.objectContaining({
			priceId: 'price_pro',
			customerEmail: 'ada@example.com',
			quantity: 1,
			successUrl:
				'https://example.com/@ada/-/billing/success?session_id={CHECKOUT_SESSION_ID}',
			cancelUrl: 'https://example.com/@ada/-/billing',
		}),
	)

	await postCheckout(env, 'ada', { plan: 'pro', interval: 'year' })
	expect(mocks.createCheckoutSession).toHaveBeenLastCalledWith(
		env,
		expect.objectContaining({ priceId: 'price_pro_yearly' }),
	)

	const yearlyMissing = await postCheckout(
		createEnv({ STRIPE_PRO_YEARLY_PRICE_ID: '' }),
		'ada',
		{ plan: 'pro', interval: 'year' },
	)
	expect(yearlyMissing.status).toBe(409)
	expect(mocks.createCheckoutSession).toHaveBeenCalledTimes(2)
})

test('an owner subscribes the team org in the URL with one seat per owner and member', async () => {
	signInAs('ada')
	const env = createEnv()
	const response = await postCheckout(env, 'acme', { plan: 'pro' })
	expect(response.status).toBe(200)
	const checkoutArgs = mocks.createCheckoutSession.mock.calls.at(-1)?.[1] as {
		clientReferenceId: string
		metadata: Record<string, string>
		quantity: number
		customerEmail: string
		successUrl: string
		cancelUrl: string
	}
	expect(checkoutArgs).toEqual(
		expect.objectContaining({
			clientReferenceId: await createBillingLinkReference(env, 'org-acme'),
			// Ada (owner) and Bob (member); Cara's billing role is not a seat.
			quantity: 2,
			customerEmail: 'ada@example.com',
			successUrl:
				'https://example.com/@acme/-/billing/success?session_id={CHECKOUT_SESSION_ID}',
			cancelUrl: 'https://example.com/@acme/-/billing',
		}),
	)
	// Team org id everywhere — never the authorizing member's personal org /
	// stable user id (regression for misattributed team checkout).
	expect(checkoutArgs.metadata.kody_org_id).toBe('org-acme')
	expect(checkoutArgs.metadata.kody_stable_user_id).toBe('org-acme')
	expect(checkoutArgs.metadata.kody_org_id).not.toBe(people.ada.personId)
	expect(checkoutArgs.clientReferenceId).not.toBe(
		await createBillingLinkReference(env, people.ada.personId),
	)
})

test('only owners and billing admins can subscribe an organization', async () => {
	const env = createEnv()

	signInAs('cara')
	const billingAdmin = await postCheckout(env, 'acme', { plan: 'pro' })
	expect(billingAdmin.status).toBe(200)
	expect(mocks.createCheckoutSession).toHaveBeenCalledTimes(1)

	signInAs('bob')
	const member = await postCheckout(env, 'acme', { plan: 'pro' })
	expect(member.status).toBe(403)
	expect(member.data).toEqual({
		ok: false,
		error: 'Only owners and billing admins can manage billing for @acme.',
	})

	// Not a member and no grant: the org is unavailable. It must never fall
	// back to Dan's own signup organization.
	signInAs('dan')
	const outsider = await postCheckout(env, 'acme', { plan: 'pro' })
	expect(outsider.status).toBe(404)
	expect(mocks.createCheckoutSession).toHaveBeenCalledTimes(1)
	expect(mocks.listSubscriptions).not.toHaveBeenCalled()
})

test('promo codes apply to monthly checkouts only, as a Kody-validated discount', async () => {
	signInAs('ada')
	const env = createEnv()

	const annual = await postCheckout(env, 'acme', {
		plan: 'pro',
		interval: 'year',
		promoCode: 'AGENCY-1',
	})
	expect(annual.status).toBe(400)
	expect(annual.data).toEqual({
		ok: false,
		error: annualPromoRejection,
	})
	expect(mocks.findActivePromotionCode).not.toHaveBeenCalled()
	expect(mocks.createCheckoutSession).not.toHaveBeenCalled()

	mocks.findActivePromotionCode.mockResolvedValueOnce({
		id: 'promo_agency_1',
		code: 'AGENCY-1',
		active: true,
		expires_at: Math.floor(Date.now() / 1000) + 86_400,
		max_redemptions: 1,
		times_redeemed: 0,
	})
	const monthly = await postCheckout(env, 'acme', {
		plan: 'pro',
		interval: 'month',
		promoCode: ' AGENCY-1 ',
	})
	expect(monthly.status).toBe(200)
	expect(mocks.findActivePromotionCode).toHaveBeenCalledWith(env, 'AGENCY-1')
	expect(mocks.createCheckoutSession).toHaveBeenLastCalledWith(
		env,
		expect.objectContaining({
			priceId: 'price_pro',
			promotionCodeId: 'promo_agency_1',
			quantity: 2,
			metadata: expect.objectContaining({
				[promoClaimMetadataKeys.userId]: people.ada.personId,
				[promoClaimMetadataKeys.promotionCodeId]: 'promo_agency_1',
			}),
		}),
	)

	// An empty field is no code at all.
	await postCheckout(env, 'acme', {
		plan: 'pro',
		interval: 'year',
		promoCode: '  ',
	})
	expect(mocks.createCheckoutSession).toHaveBeenLastCalledWith(
		env,
		expect.not.objectContaining({ promotionCodeId: expect.anything() }),
	)
})

test('unusable promo codes get a specific message and never reach Checkout', async () => {
	signInAs('ada')
	const env = createEnv()
	const nowSeconds = Math.floor(Date.now() / 1000)
	const cases: Array<[unknown, string]> = [
		[null, "That promo code isn't valid."],
		[
			{
				id: 'promo_old',
				code: 'OLD',
				active: true,
				expires_at: nowSeconds - 60,
				max_redemptions: 1,
				times_redeemed: 0,
			},
			'That promo code has expired.',
		],
		[
			{
				id: 'promo_used',
				code: 'USED',
				active: true,
				expires_at: null,
				max_redemptions: 1,
				times_redeemed: 1,
			},
			'That promo code has already been used.',
		],
	]
	for (const [promotion, error] of cases) {
		mocks.findActivePromotionCode.mockResolvedValueOnce(promotion)
		const response = await postCheckout(env, 'acme', {
			plan: 'pro',
			promoCode: 'CODE',
		})
		expect([response.status, response.data]).toEqual([
			400,
			{ ok: false, error },
		])
	}
	const malformed = await postCheckout(env, 'acme', {
		plan: 'pro',
		promoCode: 'not a code!',
	})
	expect(malformed.status).toBe(400)
	expect(mocks.createCheckoutSession).not.toHaveBeenCalled()

	// Stripe's own coupon rules (product restriction) still apply.
	mocks.findActivePromotionCode.mockResolvedValueOnce({
		id: 'promo_other_product',
		code: 'OTHER',
		active: true,
	})
	mocks.createCheckoutSession.mockRejectedValueOnce(
		new StripeApiError('Stripe API request failed with HTTP 400.', {
			status: 400,
		}),
	)
	consoleError.mockImplementation(() => {})
	try {
		const rejected = await postCheckout(env, 'acme', {
			plan: 'pro',
			promoCode: 'OTHER',
		})
		expect([rejected.status, rejected.data]).toEqual([
			400,
			{ ok: false, error: promoRejectedByStripe },
		])
	} finally {
		consoleError.mockReset()
	}

	// An existing subscription changes plans in the portal, where Kody cannot
	// attach a code.
	linkCustomer('org-acme', 'cus_acme')
	mocks.listSubscriptions.mockResolvedValueOnce([
		subscription({ id: 'sub_pro', status: 'active', priceId: 'price_pro' }),
	])
	const subscribed = await postCheckout(env, 'acme', {
		plan: 'pro',
		interval: 'month',
		promoCode: 'AGENCY-2',
	})
	expect([subscribed.status, subscribed.data]).toEqual([
		409,
		{ ok: false, error: existingSubscriptionPromoRejection },
	])
	expect(mocks.createBillingPortalSession).not.toHaveBeenCalled()
})

test('existing subscribers switch plans through the portal update flow', async () => {
	signInAs('ada')
	linkCustomer('person-ada', 'cus_existing')
	const env = createEnv({ STRIPE_BILLING_PORTAL_CONFIGURATION_ID: 'bpc_kody' })

	// Linked customer whose subscriptions are all canceled: plain Checkout.
	mocks.listSubscriptions.mockResolvedValueOnce([
		subscription({
			id: 'sub_old',
			status: 'canceled',
			priceId: retiredStandardPriceId,
		}),
	])
	const resubscribe = await postCheckout(env, 'ada', { plan: 'pro' })
	expect(resubscribe.data).toMatchObject({ mode: 'checkout' })
	expect(mocks.createCheckoutSession).toHaveBeenLastCalledWith(
		env,
		expect.objectContaining({ customerId: 'cus_existing' }),
	)

	mocks.listSubscriptions.mockResolvedValueOnce([
		subscription({
			id: 'sub_standard',
			status: 'active',
			priceId: retiredStandardPriceId,
		}),
	])
	const upgrade = await postCheckout(env, 'ada', {
		plan: 'pro',
		interval: 'year',
	})
	expect(upgrade.data).toEqual({
		ok: true,
		url: 'https://billing.stripe.com/p/session/test',
		mode: 'portal_update',
	})
	expect(mocks.createBillingPortalSession).toHaveBeenLastCalledWith(env, {
		customerId: 'cus_existing',
		returnUrl: 'https://example.com/@ada/-/billing',
		configuration: 'bpc_kody',
		flowData: {
			type: 'subscription_update_confirm',
			subscriptionId: 'sub_standard',
			subscriptionItemId: 'si_sub_standard',
			priceId: 'price_pro_yearly',
			afterCompletionRedirectUrl:
				'https://example.com/@ada/-/billing?billing=updated',
			quantity: 1,
		},
	})

	mocks.listSubscriptions.mockResolvedValueOnce([
		subscription({ id: 'sub_pro', status: 'active', priceId: 'price_pro' }),
	])
	const samePlan = await postCheckout(env, 'ada', { plan: 'pro' })
	expect([samePlan.status, samePlan.data]).toEqual([
		409,
		{ ok: false, error: 'You are already on that plan.' },
	])

	// Legacy double Kody subscriptions: plain portal so the customer picks
	// which to keep. A shared-account product does not count.
	mocks.listSubscriptions.mockResolvedValueOnce([
		subscription({
			id: 'sub_standard',
			status: 'active',
			priceId: retiredStandardPriceId,
		}),
		subscription({ id: 'sub_pro', status: 'trialing', priceId: 'price_pro' }),
		subscription({
			id: 'sub_gratitext',
			status: 'active',
			priceId: 'price_gratitext_premium_15',
		}),
	])
	const doubled = await postCheckout(env, 'ada', { plan: 'pro' })
	expect(doubled.data).toMatchObject({ mode: 'portal' })

	consoleError.mockImplementation(() => {})
	try {
		mocks.listSubscriptions.mockRejectedValueOnce(
			new StripeApiError('Stripe API request failed with HTTP 503.', {
				status: 503,
			}),
		)
		const stripeDown = await postCheckout(env, 'ada', { plan: 'pro' })
		expect([stripeDown.status, stripeDown.data]).toEqual([
			502,
			{ ok: false, error: 'Unable to start checkout. Try again shortly.' },
		])
	} finally {
		consoleError.mockReset()
	}
})

test('billing data is readable by owners and billing admins of the org in the URL', async () => {
	const env = createEnv()
	const getBilling = (slug: string) =>
		call(readWebsiteBilling, env, `/@${slug}/-/billing`)

	signInAs('cara')
	const billingAdmin = await getBilling('acme')
	expect(billingAdmin.status).toBe(200)
	expect(billingAdmin.data).toEqual({
		ok: true,
		org: {
			id: 'org-acme',
			slug: 'acme',
			displayName: 'Acme',
			personal: false,
		},
		seats: 2,
	})

	signInAs('ada')
	expect((await getBilling('ada')).data).toMatchObject({
		org: { id: 'person-ada', slug: 'ada', personal: true },
		seats: 1,
	})

	signInAs('bob')
	expect((await getBilling('acme')).status).toBe(403)
	signInAs('dan')
	expect((await getBilling('acme')).status).toBe(404)
	signInAs(null)
	await expect(getBilling('acme')).rejects.toThrow('Sign in required.')
})

test('checkout return links the Stripe customer onto the org in the URL', async () => {
	mocks.linkStripeCustomerFromCheckoutSessionAttribution.mockResolvedValue({})
	const env = createEnv()
	const getSuccess = async (sessionId: string | null = null) => {
		const request = new Request('https://example.com/@acme/-/billing/success')
		const user = await mocks.readAuthenticatedAppUser(request, env)
		return completeOrgBillingCheckout({
			request,
			env,
			user,
			orgSlug: 'acme',
			sessionId,
		})
	}

	signInAs('ada')
	const missing = await getSuccess()
	if (!(missing instanceof Response))
		throw new Error('Expected checkout redirect')
	expect(missing.status).toBe(302)
	expect(missing.headers.get('location')).toBe(
		'https://example.com/@acme/-/billing?error=missing_session',
	)

	const linked = await getSuccess('cs_test')
	expect(linked).toMatchObject({ ok: true, needsOnboarding: true })
	expect(
		mocks.linkStripeCustomerFromCheckoutSessionAttribution,
	).toHaveBeenCalledWith(
		expect.objectContaining({
			sessionId: 'cs_test',
			orgId: ownerIdFromStored('org-acme'),
		}),
	)

	signInAs('bob')
	const member = await getSuccess('cs_test')
	expect(member).toMatchObject({ ok: false, status: 403 })
	expect(
		mocks.linkStripeCustomerFromCheckoutSessionAttribution,
	).toHaveBeenCalledTimes(1)
})

test('checkout return checks onboarding against the stamped personal organization', async () => {
	const env = createEnv()
	signInAs('ada')
	mocks.linkStripeCustomerFromCheckoutSessionAttribution.mockResolvedValue({})
	mocks.userHasMcpOAuthGrants.mockResolvedValue(true)
	const request = new Request('https://example.com/@acme/-/billing/success')
	const user: AuthenticatedAppUser = await mocks.readAuthenticatedAppUser(
		request,
		env,
	)
	user.mcpUser = {
		...user.mcpUser,
		personalOrgId: ownerIdFromStored('personal-org-distinct'),
	}
	const result = await completeOrgBillingCheckout({
		request,
		env,
		user,
		orgSlug: 'acme',
		sessionId: 'cs_test',
	})
	expect(result).toEqual({ ok: true, needsOnboarding: false })
	expect(mocks.userHasMcpOAuthGrants).toHaveBeenCalledWith(
		env,
		ownerIdFromStored('personal-org-distinct'),
	)
	expect(
		mocks.linkStripeCustomerFromCheckoutSessionAttribution,
	).toHaveBeenCalledWith(
		expect.objectContaining({ orgId: ownerIdFromStored('org-acme') }),
	)
})

test('the Stripe portal opens for the org in the URL and only for managers', async () => {
	linkCustomer('org-acme', 'cus_acme')
	const env = createEnv()
	const getPortal = () =>
		call(openWebsiteBillingPortal, env, '/@acme/-/billing')

	signInAs('cara')
	const opened = await getPortal()
	expect(opened.status).toBe(200)
	expect('url' in opened.data ? opened.data.url : null).toBe(
		'https://billing.stripe.com/p/session/test',
	)
	expect(mocks.createBillingPortalSession).toHaveBeenCalledWith(
		env,
		expect.objectContaining({
			customerId: 'cus_acme',
			returnUrl: 'https://example.com/@acme/-/billing',
		}),
	)

	signInAs('bob')
	expect((await getPortal()).status).toBe(403)
	signInAs('dan')
	expect((await getPortal()).status).toBe(404)
	expect(mocks.createBillingPortalSession).toHaveBeenCalledTimes(1)
})

test('billing cancellation feedback records platform feedback', async () => {
	mocks.submitPlatformFeedback.mockResolvedValue({ id: 'fb_1' })
	mocks.enqueuePlatformFeedbackDispatch.mockResolvedValue(undefined)
	const env = createEnv()
	const post = (body: unknown) =>
		call(submitWebsiteCancellationFeedback, env, '/account/billing', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})

	signInAs(null)
	await expect(post({ details: 'Too expensive.' })).rejects.toThrow(
		'Sign in required.',
	)
	expect(mocks.submitPlatformFeedback).not.toHaveBeenCalled()

	signInAs('ada')
	expect((await post({ details: '   ' })).status).toBe(400)
	const success = await post({ details: 'Too expensive for my usage.' })
	expect([success.status, success.data]).toEqual([200, { ok: true }])
	expect(mocks.submitPlatformFeedback).toHaveBeenCalledWith(
		expect.objectContaining({
			submitterUserId: 'person-ada',
			submitterUsername: 'ada',
			category: 'cancellation',
			details: 'Too expensive for my usage.',
		}),
	)
	expect(mocks.enqueuePlatformFeedbackDispatch).toHaveBeenCalledWith(
		expect.objectContaining({ feedbackId: 'fb_1' }),
	)
})

test('a person who already claimed a promo code cannot claim one for another org', async () => {
	signInAs('ada')
	const env = createEnv()
	await db
		.prepare(
			`INSERT INTO billing_promo_claims
			 (user_id, promotion_code_id, org_id, status, checkout_session_id, reserved_at, claimed_at)
			 VALUES (?, 'promo_agency_1', 'some-other-org', 'claimed', 'cs_earlier', ?, ?)`,
		)
		.bind(
			people.ada.personId,
			new Date().toISOString(),
			new Date().toISOString(),
		)
		.run()

	const response = await postCheckout(env, 'acme', {
		plan: 'pro',
		interval: 'month',
		promoCode: 'AGENCY-1',
	})
	expect(response.status).toBe(409)
	expect(response.data).toEqual({
		ok: false,
		error: promoAlreadyClaimedRejection,
	})
	expect(mocks.findActivePromotionCode).not.toHaveBeenCalled()
	expect(mocks.createCheckoutSession).not.toHaveBeenCalled()

	// Without a code, checkout for the org still works.
	const plain = await postCheckout(env, 'acme', {
		plan: 'pro',
		interval: 'month',
	})
	expect(plain.status).toBe(200)
})

function activePromo(id: string) {
	return {
		id,
		code: 'AGENCY-1',
		active: true,
		expires_at: Math.floor(Date.now() / 1000) + 86_400,
		max_redemptions: 1,
		times_redeemed: 0,
	}
}

async function readPromoClaim(userId: string) {
	return db
		.prepare(
			`SELECT status, checkout_session_id, org_id FROM billing_promo_claims WHERE user_id = ?`,
		)
		.bind(userId)
		.first<{
			status: string
			checkout_session_id: string | null
			org_id: string
		}>()
}

test('a promo checkout reserves the claim before Stripe is called, so a parallel checkout gets 409', async () => {
	signInAs('ada')
	const env = createEnv()
	mocks.findActivePromotionCode.mockResolvedValue(activePromo('promo_agency_1'))
	let release: () => void = () => {}
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})
	mocks.createCheckoutSession.mockImplementation(async () => {
		await gate
		return {
			id: 'cs_reserved',
			url: 'https://checkout.stripe.test/cs_reserved',
		}
	})
	const body = { plan: 'pro', interval: 'month', promoCode: 'AGENCY-1' }
	const first = postCheckout(env, 'acme', body)
	await vi.waitFor(async () => {
		expect((await readPromoClaim(people.ada.personId))?.status).toBe('reserved')
	})
	const second = await postCheckout(env, 'acme', body)
	expect(second.status).toBe(409)
	expect(second.data).toEqual({
		ok: false,
		error: promoAlreadyClaimedRejection,
	})
	release()
	expect((await first).status).toBe(200)
	expect(mocks.createCheckoutSession).toHaveBeenCalledTimes(1)
	expect(await readPromoClaim(people.ada.personId)).toEqual({
		status: 'reserved',
		checkout_session_id: 'cs_reserved',
		org_id: expect.any(String),
	})
})

test('a promo reservation is released when Stripe refuses the checkout', async () => {
	signInAs('ada')
	const env = createEnv()
	mocks.findActivePromotionCode.mockResolvedValue(activePromo('promo_agency_1'))
	mocks.createCheckoutSession.mockRejectedValueOnce(
		new StripeApiError('coupon does not apply', {
			status: 400,
			code: 'resource_missing',
		}),
	)
	consoleError.mockImplementation(() => {})
	const body = { plan: 'pro', interval: 'month', promoCode: 'AGENCY-1' }
	const refused = await postCheckout(env, 'acme', body)
	expect(refused.status).toBe(400)
	expect(await readPromoClaim(people.ada.personId)).toBeNull()

	// With the reservation gone, the person can try again.
	const retry = await postCheckout(env, 'acme', body)
	expect(retry.status).toBe(200)
	expect((await readPromoClaim(people.ada.personId))?.status).toBe('reserved')
})

test('a missing billing plan becomes unavailable without hiding unrelated read failures', async () => {
	const env = createEnv()
	const getBilling = (slug: string) =>
		call(readWebsiteBilling, env, `/@${slug}/-/billing`)
	signInAs('ada')
	mocks.loadAccountBillingData.mockRejectedValueOnce(
		new BillingPlanUnavailableError('Plan unavailable'),
	)
	expect((await getBilling('acme')).data).toBeNull()
	mocks.loadAccountBillingData.mockRejectedValueOnce(
		new Error('Database unavailable'),
	)
	await expect(getBilling('acme')).rejects.toThrow('Database unavailable')
})
