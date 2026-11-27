import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import type * as StripeClient from '#worker/billing/stripe-client.ts'
import { loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

const mocks = vi.hoisted(() => ({
	createCheckoutSession:
		vi.fn<(...args: Array<unknown>) => Promise<{ id: string; url: string }>>(),
	listSubscriptions:
		vi.fn<(...args: Array<unknown>) => Promise<Array<unknown>>>(),
	findActivePromotionCode:
		vi.fn<(env: unknown, code: string) => Promise<unknown>>(),
}))

vi.mock('#worker/billing/stripe-client.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof StripeClient>()
	return {
		...actual,
		createCheckoutSession: (...args: Array<unknown>) =>
			mocks.createCheckoutSession(...args),
		listSubscriptions: (...args: Array<unknown>) =>
			mocks.listSubscriptions(...args),
		findActivePromotionCode: (env: unknown, code: string) =>
			mocks.findActivePromotionCode(env, code),
	}
})

const { startWebsiteCheckout } = await import('#app/handlers/org-billing.ts')
const { billingCheckoutLinkCapability } =
	await import('#mcp/capabilities/account/billing-checkout-link.ts')
const { billingManageLinkCapability } =
	await import('#mcp/capabilities/account/billing-manage-link.ts')
const { evaluateCheckoutLinkForSession } = await import('./checkout-link.ts')

const duringSale = new Date('2026-12-01T09:00:00-08:00')
const afterSale = new Date('2026-12-05T00:00:00-08:00')
const seededAt = '2026-01-01T00:00:00.000Z'

/** Ada owns her personal org and `acme`; Bob is a plain member of `acme`. */
const people = {
	ada: { id: 9, personId: 'person-ada' },
	bob: { id: 10, personId: 'person-bob' },
} as const
type Person = keyof typeof people

let sqlite: DatabaseSync
let env: Env

beforeEach(async () => {
	vi.useFakeTimers({ now: duringSale, toFake: ['Date'] })
	vi.clearAllMocks()
	sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
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
			.run(person.personId, username, seededAt, seededAt)
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, 'owner', ?)`,
			)
			.run(person.personId, person.personId, seededAt)
	}
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
			 VALUES ('org-acme', 'acme', 'Acme', ?, ?)`,
		)
		.run(seededAt, seededAt)
	for (const [person, role] of [
		['ada', 'owner'],
		['bob', 'member'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES ('org-acme', ?, ?, ?)`,
			)
			.run(people[person].personId, role, seededAt)
	}
	env = {
		COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123456789',
		STRIPE_SECRET_KEY: 'sk_test_secret',
		STRIPE_PRO_PRICE_ID: 'price_pro',
		STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly',
		APP_DB: db,
	} as unknown as Env
	mocks.createCheckoutSession.mockResolvedValue({
		id: 'cs_test',
		url: 'https://checkout.stripe.com/c/pay/cs_test',
	})
	mocks.listSubscriptions.mockResolvedValue([])
	// The two live Stripe promotion codes, as Stripe returns them.
	mocks.findActivePromotionCode.mockImplementation(async (_env, name) => {
		const interval =
			name === 'BLACKFRIDAY-YEARLY'
				? 'year'
				: name === 'BLACKFRIDAY-MONTHLY'
					? 'month'
					: null
		return interval
			? {
					id: `promo_${interval}`,
					active: true,
					expires_at: 1_796_457_599,
					max_redemptions: null,
					times_redeemed: 0,
					metadata: {
						kody_interval: interval,
						kody_claim_scope: 'campaign',
						kody_campaign: 'blackfriday-2026',
					},
				}
			: null
	})
})

afterEach(() => {
	vi.useRealTimers()
})

function mcpUserFor(person: Person) {
	return {
		userId: personIdFromStored(people[person].personId),
		email: `${person}@example.com`,
		displayName: person,
	}
}

type Caller = {
	executionOrigin?: 'interactive' | 'background'
	scopes?: Array<'billing:read'>
}
type BoundOrg = { id: string; slug: string; role: 'owner' | 'member' }

function callerContextFor(person: Person, boundTo: BoundOrg, caller: Caller) {
	return createMcpCallerContext({
		source: caller.scopes
			? { kind: 'api-token', tokenId: 'token-1' }
			: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.codes',
		executionOrigin: caller.executionOrigin ?? 'interactive',
		user: mcpUserFor(person),
		orgBinding: {
			org: { id: ownerIdFromStored(boundTo.id), slug: boundTo.slug },
			role: boundTo.role,
		},
		...(caller.scopes ? { scopes: caller.scopes } : {}),
	})
}

/** What an agent connected to `boundTo` gets from `billingManageLink`. */
async function manageLink(
	person: Person,
	boundTo: BoundOrg,
	args: { org?: string } = {},
	caller: Caller = {},
) {
	const result = await billingManageLinkCapability.handler(args, {
		env,
		callerContext: callerContextFor(person, boundTo, caller),
	})
	expect(mocks.createCheckoutSession).not.toHaveBeenCalled()
	expect(mocks.listSubscriptions).not.toHaveBeenCalled()
	expect(mocks.findActivePromotionCode).not.toHaveBeenCalled()
	return result
}

/** What an agent connected to `boundTo` gets from `billingCheckoutLink`. */
async function link(
	person: Person,
	boundTo: BoundOrg,
	args: {
		org?: string
		plan?: string
		interval?: string
		promoCode?: string
	} = {},
	caller: Caller = {},
) {
	const result = await billingCheckoutLinkCapability.handler(args, {
		env,
		callerContext: callerContextFor(person, boundTo, caller),
	})
	// No call to the capability ever reaches Stripe Checkout.
	expect(mocks.createCheckoutSession).not.toHaveBeenCalled()
	return result
}

const acmeAsOwner = { id: 'org-acme', slug: 'acme', role: 'owner' } as const
const acmeAsMember = { id: 'org-acme', slug: 'acme', role: 'member' } as const

/** The person opens the link page (the same check the confirm button runs). */
function openLink(
	person: Person,
	orgSlug: string,
	query: { plan?: string; interval?: string } = {},
	now = new Date(),
) {
	return evaluateCheckoutLinkForSession({
		env,
		person: mcpUserFor(person),
		org: orgSlug,
		plan: query.plan ?? 'pro',
		interval: query.interval ?? 'month',
		baseUrl: 'https://kody.codes',
		now,
	})
}

/** The person presses "Continue to Stripe" on the link page. */
async function confirm(
	person: Person,
	orgSlug: string,
	interval: 'month' | 'year',
) {
	const { id, personId } = people[person]
	const mcpUser = mcpUserFor(person)
	const orgBinding = await loadOrgBindingForSlug(env.APP_DB, personId, orgSlug)
	if (!orgBinding) throw new Error(`${person} cannot reach ${orgSlug}`)
	const user = {
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
	const response = await startWebsiteCheckout({
		env,
		request: new Request(
			`https://kody.codes/@${orgSlug}/-/billing/checkout?plan=pro&interval=${interval}`,
			{ method: 'POST' },
		),
		user,
		orgSlug,
		body: { plan: 'pro', interval },
		newSubscriptionOnly: true,
	})
	const session = mocks.createCheckoutSession.mock.lastCall?.[1] as
		| { priceId: string; promotionCodeId?: string }
		| undefined
	return {
		status: response.status,
		data: response.data,
		sessions: mocks.createCheckoutSession.mock.calls.length,
		priceId: session?.priceId,
		promotionCodeId: session?.promotionCodeId,
	}
}

test('an eligible org gets a kody.codes link that names no Stripe session and no code', async () => {
	const yearly = await link('ada', acmeAsOwner, {
		org: '@Acme',
		interval: 'year',
	})
	expect(yearly).toEqual({
		ok: true,
		url: 'https://kody.codes/@acme/-/billing/checkout?plan=pro&interval=year',
		org: 'acme',
		plan: 'pro',
		interval: 'year',
		offer: {
			applies: true,
			message:
				'Black Friday price: annual Pro is $90 for the first year, normally $120.',
		},
		message:
			'Open this link to check out Pro for @acme. You sign in, confirm, and pay on Stripe. Black Friday price: annual Pro is $90 for the first year, normally $120.',
	})
	// The org defaults to the connection's, the interval to monthly.
	const monthly = await link('ada', acmeAsOwner)
	expect(monthly).toMatchObject({
		ok: true,
		url: 'https://kody.codes/@acme/-/billing/checkout?plan=pro&interval=month',
		offer: {
			applies: true,
			message:
				'Black Friday price: monthly Pro is $6 for two months, then $12.',
		},
	})
	for (const result of [yearly, monthly]) {
		const text = JSON.stringify(result)
		expect(text).not.toMatch(/stripe\.com|cs_|promo_|BLACKFRIDAY/i)
		expect(new URL((result as { url: string }).url).host).toBe('kody.codes')
	}
	// Issuing a link looks nothing up in Stripe either.
	expect(mocks.findActivePromotionCode).not.toHaveBeenCalled()
	expect(mocks.listSubscriptions).not.toHaveBeenCalled()
})

test('each refusal is a plain reason, not a link', async () => {
	expect(await link('ada', acmeAsOwner, { plan: 'max' })).toEqual({
		ok: false,
		reason: 'Pro is the only plan sold at checkout. Ask for plan "pro".',
	})
	expect(await link('ada', acmeAsOwner, { interval: 'weekly' })).toEqual({
		ok: false,
		reason: 'Choose monthly or annual billing: interval "month" or "year".',
	})
	expect(await link('ada', acmeAsOwner, { org: 'nope' })).toEqual({
		ok: false,
		reason:
			'There is no organization @nope that you belong to. Check the handle.',
	})
	// Bob's own org exists, but Ada is not in it: the same answer.
	expect(await link('ada', acmeAsOwner, { org: 'bob' })).toEqual({
		ok: false,
		reason:
			'There is no organization @bob that you belong to. Check the handle.',
	})
	// A connection acts for one organization.
	expect(await link('ada', acmeAsOwner, { org: 'ada' })).toEqual({
		ok: false,
		reason:
			'This connection works for a different organization than @ada. Connect to @ada to start its checkout, or open its billing page.',
	})
	expect(await link('bob', acmeAsMember)).toEqual({
		ok: false,
		reason:
			'Only owners and billing admins can manage billing for @acme. Ask one of them to open this link.',
	})
	// An owner's token that was not given billing:write.
	expect(
		await link('ada', acmeAsOwner, {}, { scopes: ['billing:read'] }),
	).toEqual({
		ok: false,
		reason:
			'This connection is not allowed to manage billing for @acme. An owner or billing admin can start checkout on the billing page instead.',
	})
	sqlite
		.prepare(`UPDATE orgs SET stripe_plan = 'pro' WHERE id = 'org-acme'`)
		.run()
	expect(await link('ada', acmeAsOwner)).toEqual({
		ok: false,
		reason:
			'@acme already has a paid plan, so there is nothing to check out. Change or cancel it at https://kody.codes/@acme/-/billing Use billingManageLink when the person needs that page.',
	})
	// A code does not get a paid org past the refusal, and is never looked up.
	expect(
		await link('ada', acmeAsOwner, { promoCode: 'BLACKFRIDAY-YEARLY' }),
	).toMatchObject({
		ok: false,
		reason: expect.stringContaining('https://kody.codes/@acme/-/billing'),
	})
	expect(mocks.findActivePromotionCode).not.toHaveBeenCalled()
	// A manual Max grant has no subscription but is not Free.
	sqlite
		.prepare(
			`UPDATE orgs SET stripe_plan = NULL, plan = 'max' WHERE id = 'org-acme'`,
		)
		.run()
	expect(await link('ada', acmeAsOwner)).toMatchObject({ ok: false })
})

test('package and job code cannot ask for a checkout link', async () => {
	await expect(
		link('ada', acmeAsOwner, {}, { executionOrigin: 'background' }),
	).rejects.toThrow(
		'billingCheckoutLink runs for a person or their agent. Call it from an interactive MCP session, execute, the Open API, or the kody CLI. Package app and job code cannot call it.',
	)
})

test('confirming applies the campaign code for the chosen interval', async () => {
	expect(await confirm('ada', 'acme', 'year')).toMatchObject({
		status: 200,
		data: { ok: true, url: 'https://checkout.stripe.com/c/pay/cs_test' },
		priceId: 'price_pro_yearly',
		promotionCodeId: 'promo_year',
	})
	expect(mocks.findActivePromotionCode.mock.lastCall?.[1]).toBe(
		'BLACKFRIDAY-YEARLY',
	)
})

test('confirming monthly applies the monthly campaign code', async () => {
	expect(await confirm('ada', 'ada', 'month')).toMatchObject({
		status: 200,
		priceId: 'price_pro',
		promotionCodeId: 'promo_month',
	})
	expect(mocks.findActivePromotionCode.mock.lastCall?.[1]).toBe(
		'BLACKFRIDAY-MONTHLY',
	)
})

test('a link issued while eligible is refused once the org has a subscription', async () => {
	expect(await link('ada', acmeAsOwner)).toMatchObject({ ok: true })
	const reason =
		'@acme already has a paid plan, so there is nothing to check out. Change or cancel it at https://kody.codes/@acme/-/billing'

	// Stripe has a subscription the stored plan does not show yet: the page
	// still loads, and the confirm is refused without a Checkout Session.
	sqlite
		.prepare(
			`UPDATE orgs SET stripe_customer_id = 'cus_acme' WHERE id = 'org-acme'`,
		)
		.run()
	mocks.listSubscriptions.mockResolvedValue([
		{
			id: 'sub_1',
			status: 'active',
			items: { data: [{ id: 'si_1', price: { id: 'price_pro' } }] },
		},
	])
	expect(await openLink('ada', 'acme')).toMatchObject({ ok: true })
	expect(await confirm('ada', 'acme', 'month')).toEqual({
		status: 409,
		data: { ok: false, error: reason },
		sessions: 0,
		priceId: undefined,
		promotionCodeId: undefined,
	})

	// Once the webhook has stored the plan, the page says so up front.
	sqlite
		.prepare(`UPDATE orgs SET stripe_plan = 'pro' WHERE id = 'org-acme'`)
		.run()
	expect(await openLink('ada', 'acme')).toEqual({
		ok: false,
		reason,
		paidPlan: true,
	})
})

test('a forwarded link is checked against whoever opens it', async () => {
	expect(await link('ada', acmeAsOwner, { interval: 'year' })).toMatchObject({
		ok: true,
	})
	expect(await openLink('bob', 'acme', { interval: 'year' })).toEqual({
		ok: false,
		reason:
			'Only owners and billing admins can manage billing for @acme. Ask one of them to open this link.',
	})
	expect(await openLink('bob', 'ada')).toEqual({
		ok: false,
		reason:
			'There is no organization @ada that you belong to. Check the handle.',
	})
	// A hand-edited link is refused the same way.
	expect(await openLink('ada', 'acme', { plan: 'max' })).toMatchObject({
		ok: false,
	})
	expect(await openLink('ada', 'acme', { interval: 'decade' })).toMatchObject({
		ok: false,
	})
	expect((await confirm('bob', 'acme', 'year')).status).toBe(403)
	expect(mocks.createCheckoutSession).not.toHaveBeenCalled()
})

test('once the campaign is claimed, the link still checks out at the regular price', async () => {
	expect(
		await link('ada', { id: 'person-ada', slug: 'ada', role: 'owner' }),
	).toMatchObject({
		ok: true,
		offer: { applies: true },
	})
	// Ada claims the campaign for acme; her link for @ada was issued earlier.
	expect(await confirm('ada', 'acme', 'year')).toMatchObject({
		promotionCodeId: 'promo_year',
	})
	const offer = {
		applies: false,
		reason:
			'You have already claimed this promotion. It can be claimed once per person, across all of your organizations.',
	}
	expect(await openLink('ada', 'ada')).toMatchObject({ ok: true, offer })
	expect(await confirm('ada', 'ada', 'month')).toMatchObject({
		status: 200,
		sessions: 2,
		priceId: 'price_pro',
		promotionCodeId: undefined,
	})
	mocks.createCheckoutSession.mockClear()
	expect(
		await link('ada', { id: 'person-ada', slug: 'ada', role: 'owner' }),
	).toMatchObject({
		ok: true,
		url: 'https://kody.codes/@ada/-/billing/checkout?plan=pro&interval=month',
		offer: { applies: false, message: offer.reason },
		message: `Open this link to check out Pro for @ada. You sign in, confirm, and pay on Stripe. ${offer.reason} Checkout is at the regular price.`,
	})
})

test('after the sale the link is a plain checkout link', async () => {
	vi.setSystemTime(afterSale)
	expect(await link('ada', acmeAsOwner, { interval: 'year' })).toEqual({
		ok: true,
		url: 'https://kody.codes/@acme/-/billing/checkout?plan=pro&interval=year',
		org: 'acme',
		plan: 'pro',
		interval: 'year',
		offer: null,
		message:
			'Open this link to check out Pro for @acme. You sign in, confirm, and pay on Stripe.',
	})
	expect(await openLink('ada', 'acme', { interval: 'year' })).toMatchObject({
		ok: true,
		offer: null,
	})
	expect(await confirm('ada', 'acme', 'year')).toMatchObject({
		status: 200,
		priceId: 'price_pro_yearly',
		promotionCodeId: undefined,
	})
	expect(mocks.findActivePromotionCode).not.toHaveBeenCalled()
})

test('a campaign code Stripe no longer has falls back to the regular price', async () => {
	mocks.findActivePromotionCode.mockResolvedValue(null)
	const result = await confirm('ada', 'acme', 'year')
	expect(result).toMatchObject({
		status: 200,
		priceId: 'price_pro_yearly',
		promotionCodeId: undefined,
	})
	expect(JSON.stringify(result.data)).not.toMatch(/BLACKFRIDAY/i)
})

const yearLink =
	'https://kody.codes/@acme/-/billing/checkout?plan=pro&interval=year'
const monthLink =
	'https://kody.codes/@acme/-/billing/checkout?plan=pro&interval=month'

test('a campaign code picks its billing interval, as promoCode or as interval', async () => {
	const results = [
		await link('ada', acmeAsOwner, { interval: 'BLACKFRIDAY-YEARLY' }),
		await link('ada', acmeAsOwner, { promoCode: 'BLACKFRIDAY-YEARLY' }),
		// The code's interval wins over a valid interval.
		await link('ada', acmeAsOwner, {
			interval: 'month',
			promoCode: 'blackfriday-yearly',
		}),
		await link('ada', acmeAsOwner, { interval: 'BLACKFRIDAY-MONTHLY' }),
		await link('ada', acmeAsOwner, {
			interval: 'year',
			promoCode: 'BLACKFRIDAY-MONTHLY',
		}),
	]
	expect(results.map((result) => (result.ok ? result.url : result))).toEqual([
		yearLink,
		yearLink,
		yearLink,
		monthLink,
		monthLink,
	])
	for (const result of results) {
		expect(result).toMatchObject({ ok: true, offer: { applies: true } })
		expect(result).not.toHaveProperty('note')
		expect(JSON.stringify(result)).not.toMatch(/stripe\.com|cs_|BLACKFRIDAY/i)
	}
	// The link carries only the interval: confirming applies the code the
	// same way as a link asked for by interval.
	expect(await confirm('ada', 'acme', 'year')).toMatchObject({
		priceId: 'price_pro_yearly',
		promotionCodeId: 'promo_year',
	})
})

test('a code that cannot be used still gets a regular checkout link and a note', async () => {
	const note =
		'That promo code could not be applied, so it is left out of this checkout.'
	// Unknown code where the interval goes: monthly.
	expect(await link('ada', acmeAsOwner, { interval: 'SPRING-SALE' })).toEqual({
		ok: true,
		url: monthLink,
		org: 'acme',
		plan: 'pro',
		interval: 'month',
		offer: { applies: true, message: expect.any(String) },
		note,
		message: expect.stringContaining(note),
	})
	// Unknown code beside a valid interval: that interval is kept.
	expect(
		await link('ada', acmeAsOwner, { interval: 'year', promoCode: 'NOPE2026' }),
	).toMatchObject({ ok: true, url: yearLink, note })
	// Stripe no longer has the campaign code active.
	mocks.findActivePromotionCode.mockResolvedValue(null)
	expect(
		await link('ada', acmeAsOwner, { interval: 'BLACKFRIDAY-YEARLY' }),
	).toMatchObject({ ok: true, url: monthLink, note })
	// Stripe has it, but it expired.
	mocks.findActivePromotionCode.mockResolvedValue({
		id: 'promo_year',
		active: true,
		expires_at: Math.floor(duringSale.getTime() / 1000) - 60,
		metadata: {
			kody_interval: 'year',
			kody_claim_scope: 'campaign',
			kody_campaign: 'blackfriday-2026',
		},
	})
	expect(
		await link('ada', acmeAsOwner, {
			interval: 'year',
			promoCode: 'BLACKFRIDAY-MONTHLY',
		}),
	).toMatchObject({ ok: true, url: yearLink, note })
	// After the sale the campaign code is one more unknown code.
	vi.setSystemTime(afterSale)
	expect(
		await link('ada', acmeAsOwner, { promoCode: 'BLACKFRIDAY-YEARLY' }),
	).toMatchObject({ ok: true, url: monthLink, offer: null, note })
	// A mistyped interval is still refused, with or without a code.
	expect(
		await link('ada', acmeAsOwner, {
			interval: 'weekly',
			promoCode: 'BLACKFRIDAY-YEARLY',
		}),
	).toEqual({
		ok: false,
		reason: 'Choose monthly or annual billing: interval "month" or "year".',
	})
})

test('a code does not bring the sale price back once the campaign is claimed', async () => {
	expect(await confirm('ada', 'acme', 'year')).toMatchObject({
		promotionCodeId: 'promo_year',
	})
	mocks.createCheckoutSession.mockClear()
	const personal = { id: 'person-ada', slug: 'ada', role: 'owner' } as const
	const result = await link('ada', personal, {
		promoCode: 'BLACKFRIDAY-YEARLY',
	})
	expect(result).toMatchObject({
		ok: true,
		url: 'https://kody.codes/@ada/-/billing/checkout?plan=pro&interval=year',
		offer: {
			applies: false,
			message:
				'You have already claimed this promotion. It can be claimed once per person, across all of your organizations.',
		},
	})
	expect(await confirm('ada', 'ada', 'year')).toMatchObject({
		status: 200,
		priceId: 'price_pro_yearly',
		promotionCodeId: undefined,
	})
})

test('billingManageLink returns the billing page, or the same plain reasons', async () => {
	sqlite
		.prepare(`UPDATE orgs SET stripe_plan = 'standard' WHERE id = 'org-acme'`)
		.run()
	expect(await manageLink('ada', acmeAsOwner)).toEqual({
		ok: true,
		url: 'https://kody.codes/@acme/-/billing',
		org: 'acme',
		message:
			'Open this link to manage billing for @acme. To move from an older plan, switch to current Pro there.',
	})
	expect(await manageLink('ada', acmeAsOwner, { org: '@nope' })).toEqual({
		ok: false,
		reason:
			'There is no organization @nope that you belong to. Check the handle.',
	})
	expect(await manageLink('ada', acmeAsOwner, { org: 'ada' })).toEqual({
		ok: false,
		reason:
			'This connection works for a different organization than @ada. Connect to @ada to start its checkout, or open its billing page.',
	})
	expect(await manageLink('bob', acmeAsMember)).toEqual({
		ok: false,
		reason:
			'Only owners and billing admins can manage billing for @acme. Ask one of them to open this link.',
	})
	expect(
		await manageLink('ada', acmeAsOwner, {}, { scopes: ['billing:read'] }),
	).toEqual({
		ok: false,
		reason:
			'This connection is not allowed to manage billing for @acme. An owner or billing admin can start checkout on the billing page instead.',
	})
	await expect(
		manageLink('ada', acmeAsOwner, {}, { executionOrigin: 'background' }),
	).rejects.toThrow(
		'billingManageLink runs for a person or their agent. Call it from an interactive MCP session, execute, the Open API, or the kody CLI. Package app and job code cannot call it.',
	)
})
