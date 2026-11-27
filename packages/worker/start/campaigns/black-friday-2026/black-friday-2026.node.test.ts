import { DatabaseSync } from 'node:sqlite'
import { runInNewContext } from 'node:vm'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AuthenticatedAppUser } from '#app/authenticated-user.ts'
import type * as StripeClient from '#worker/billing/stripe-client.ts'
import { StripeApiError } from '#worker/billing/stripe-client.ts'
import { loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import {
	blackFridayCopy,
	blackFridayCountdownAttribute,
	blackFridayDismissStorageKey,
	blackFridayEndsAtMs,
	blackFridayHiddenAttribute,
	blackFridayPrePaintScript,
	formatBlackFridayCountdown,
} from './offer.ts'

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
const { loadBlackFridayBanner } = await import('./server.ts')

const duringSale = new Date('2026-11-27T09:00:00-07:00')
const saleEnd = new Date(blackFridayEndsAtMs)
const seededAt = '2026-01-01T00:00:00.000Z'
const stripeExpiresAt = 1_796_108_399

/** Ada owns her personal org and `acme`; Bob is a plain member of `acme`. */
const people = {
	ada: { id: 9, personId: 'person-ada' },
	bob: { id: 10, personId: 'person-bob' },
} as const
type Person = keyof typeof people

let sqlite: DatabaseSync
let env: Env

/** The two live Stripe promotion codes, as Stripe returns them. */
function stripeCodes(overrides: Record<string, unknown> = {}) {
	const code = (id: string, interval: 'month' | 'year') => ({
		id,
		active: true,
		expires_at: stripeExpiresAt,
		max_redemptions: null,
		times_redeemed: 0,
		metadata: {
			kody_interval: interval,
			kody_claim_scope: 'campaign',
			kody_campaign: 'blackfriday-2026',
		},
		...overrides,
	})
	mocks.findActivePromotionCode.mockImplementation(async (_env, name) =>
		name === 'BLACKFRIDAY-YEARLY'
			? code('promo_yearly', 'year')
			: name === 'BLACKFRIDAY-MONTHLY'
				? code('promo_monthly', 'month')
				: null,
	)
}

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
	stripeCodes()
})

afterEach(() => {
	vi.useRealTimers()
})

async function userFor(person: Person, orgSlug: string) {
	const { id, personId } = people[person]
	const mcpUser = {
		userId: personIdFromStored(personId),
		email: `${person}@example.com`,
		displayName: person,
	}
	const orgBinding = await loadOrgBindingForSlug(env.APP_DB, personId, orgSlug)
	if (!orgBinding) throw new Error(`${person} cannot reach ${orgSlug}`)
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

async function banner(
	person: Person | null,
	pathname = '/',
	now: Date = duringSale,
) {
	return loadBlackFridayBanner({
		env,
		user: person ? await userFor(person, person) : null,
		organizations: person
			? [
					{ slug: person, personal: true },
					{ slug: 'acme', personal: false },
				]
			: null,
		pathname,
		now,
	})
}

async function checkout(
	person: Person,
	orgSlug: string,
	body: { interval: 'month' | 'year'; promoCode?: string },
) {
	const response = await startWebsiteCheckout({
		env,
		request: new Request(`https://example.com/@${orgSlug}/-/billing`, {
			method: 'POST',
		}),
		user: await userFor(person, orgSlug),
		orgSlug,
		body: { plan: 'pro', ...body },
	})
	const session = mocks.createCheckoutSession.mock.lastCall?.[1] as
		| { priceId: string; promotionCodeId?: string }
		| undefined
	return {
		status: response.status,
		data: response.data,
		priceId: session?.priceId,
		promotionCodeId: session?.promotionCodeId,
	}
}

function claimRows() {
	return sqlite
		.prepare(
			`SELECT user_id, claim_key, promotion_code_id, org_id, status
			 FROM billing_promo_claims ORDER BY reserved_at`,
		)
		.all()
}

test('the banner copy states the prices the two Stripe coupons produce', () => {
	expect(blackFridayCopy['signed-out']).toEqual({
		body: 'Annual Pro is $90 for the first year, normally $120. Or start monthly at $6 for two months, then $12.',
		meta: 'Ends Nov 30, 11:59 PM MT.',
		cta: 'Create an account',
	})
	expect(blackFridayCopy.free).toEqual({
		body: 'Upgrade to annual Pro for $90 the first year, normally $120. Or start monthly at $6 for two months, then $12.',
		meta: "We'll apply the code at checkout. Ends Nov 30, 11:59 PM MT.",
		cta: 'Upgrade to Pro',
	})
	// The sale ends the second the Stripe promotion codes expire.
	expect(blackFridayEndsAtMs).toBe(stripeExpiresAt * 1000)
})

test('the countdown shows days, hours and minutes without leading zero units', () => {
	const minute = 60_000
	const hour = 60 * minute
	const day = 24 * hour
	expect(
		[
			4 * day + 4 * hour + 37 * minute + 59_999,
			4 * day + 37 * minute,
			day,
			23 * hour + 5 * minute,
			hour,
			42 * minute,
			minute,
			minute - 1,
			0,
		].map(formatBlackFridayCountdown),
	).toEqual([
		'4d 4h 37m',
		'4d 0h 37m',
		'1d 0h 0m',
		'23h 5m',
		'1h 0m',
		'42m',
		'1m',
		'less than a minute',
		'less than a minute',
	])
})

test('the pre-paint script fills the countdown, and hides the banner once dismissed or over', () => {
	function run(input: { now: number; dismissed?: boolean }) {
		const slot = { textContent: '' }
		const hidden = new Set<string>()
		runInNewContext(blackFridayPrePaintScript(), {
			Date: { now: () => input.now },
			localStorage: {
				getItem: (key: string) =>
					input.dismissed && key === blackFridayDismissStorageKey ? '1' : null,
			},
			document: {
				documentElement: {
					setAttribute: (name: string) => hidden.add(name),
				},
				querySelectorAll: (selector: string) =>
					selector === `[${blackFridayCountdownAttribute}]` ? [slot] : [],
			},
		})
		return { text: slot.textContent, hidden: [...hidden] }
	}
	const fourDaysOut = blackFridayEndsAtMs - (4 * 24 * 60 + 4 * 60 + 37) * 60_000
	expect(run({ now: fourDaysOut })).toEqual({
		text: '4d 4h 37m left.',
		hidden: [],
	})
	expect(run({ now: fourDaysOut, dismissed: true })).toEqual({
		text: '',
		hidden: [blackFridayHiddenAttribute],
	})
	expect(run({ now: blackFridayEndsAtMs })).toEqual({
		text: '',
		hidden: [blackFridayHiddenAttribute],
	})
})

test('signed-out visitors get the bar until the sale ends', async () => {
	expect(await banner(null)).toEqual({ audience: 'signed-out' })
	expect(await banner(null, '/', new Date(saleEnd.getTime() - 1))).toEqual({
		audience: 'signed-out',
	})
	expect(await banner(null, '/', saleEnd)).toBeNull()
})

test('the card shows only for a Free org the viewer can bill, with no subscription and no claim', async () => {
	expect(await banner('ada')).toEqual({ audience: 'free', orgSlug: 'ada' })
	expect(await banner('ada', '/@acme')).toEqual({
		audience: 'free',
		orgSlug: 'acme',
	})
	// Bob is a member of acme without billing:write, and not in Ada's org.
	expect(await banner('bob', '/@acme')).toBeNull()
	expect(await banner('bob', '/@ada')).toBeNull()
	expect(await banner('ada', '/', saleEnd)).toBeNull()

	// Any plan-retaining Stripe subscription, whatever its plan or interval.
	sqlite
		.prepare(`UPDATE orgs SET stripe_plan = 'pro' WHERE id = 'org-acme'`)
		.run()
	expect(await banner('ada', '/@acme')).toBeNull()
	sqlite
		.prepare(`UPDATE orgs SET stripe_plan = 'standard' WHERE id = 'org-acme'`)
		.run()
	expect(await banner('ada', '/@acme')).toBeNull()
	// A manual Max grant has no subscription but is not Free.
	sqlite
		.prepare(
			`UPDATE orgs SET stripe_plan = NULL, plan = 'max' WHERE id = 'org-acme'`,
		)
		.run()
	expect(await banner('ada', '/@acme')).toBeNull()
	expect(await banner('ada')).toEqual({ audience: 'free', orgSlug: 'ada' })
})

test('checkout applies the campaign code for the chosen interval and the claim hides the banner everywhere', async () => {
	const yearly = await checkout('ada', 'acme', { interval: 'year' })
	expect(yearly).toMatchObject({
		status: 200,
		priceId: 'price_pro_yearly',
		promotionCodeId: 'promo_yearly',
	})
	expect(claimRows()).toEqual([
		{
			user_id: 'person-ada',
			claim_key: 'campaign:blackfriday-2026',
			promotion_code_id: 'promo_yearly',
			org_id: 'org-acme',
			status: 'reserved',
		},
	])
	// One claim per person: no banner for any of Ada's orgs, and a second
	// checkout goes through at full price instead of failing.
	expect(await banner('ada')).toBeNull()
	expect(await banner('ada', '/@acme')).toBeNull()
	expect(await checkout('ada', 'ada', { interval: 'month' })).toMatchObject({
		status: 200,
		priceId: 'price_pro',
		promotionCodeId: undefined,
	})
	expect(claimRows()).toHaveLength(1)

	// Bob has his own claim, and monthly maps to the monthly code.
	expect(await checkout('bob', 'bob', { interval: 'month' })).toMatchObject({
		status: 200,
		priceId: 'price_pro',
		promotionCodeId: 'promo_monthly',
	})
})

test('a typed code wins over the campaign code and keeps its own validation', async () => {
	const typed = await checkout('ada', 'ada', {
		interval: 'month',
		promoCode: 'NOPE',
	})
	expect(typed).toMatchObject({
		status: 400,
		data: { ok: false, error: "That promo code isn't valid." },
	})
	expect(
		mocks.findActivePromotionCode.mock.calls.map((call) => call[1]),
	).toEqual(['NOPE'])
	expect(mocks.createCheckoutSession).not.toHaveBeenCalled()
})

test('checkout goes ahead at full price whenever the campaign code cannot be applied', async () => {
	const fullPrice = { status: 200, priceId: 'price_pro_yearly' }

	stripeCodes({ active: false })
	const inactive = await checkout('ada', 'ada', { interval: 'year' })
	expect(inactive).toMatchObject(fullPrice)
	expect(inactive.promotionCodeId).toBeUndefined()

	// A code tagged for another campaign is a setup mistake, not a discount.
	stripeCodes({ metadata: { kody_interval: 'year' } })
	const mistagged = await checkout('ada', 'ada', { interval: 'year' })
	expect(mistagged).toMatchObject(fullPrice)
	expect(mistagged.promotionCodeId).toBeUndefined()

	mocks.findActivePromotionCode.mockRejectedValue(
		new StripeApiError('Stripe is down', { status: 503 }),
	)
	const stripeDown = await checkout('ada', 'ada', { interval: 'year' })
	expect(stripeDown).toMatchObject(fullPrice)
	expect(stripeDown.promotionCodeId).toBeUndefined()

	// Stripe's own coupon rule refuses the session: retry without the code
	// and release the reservation so the person keeps their one claim.
	stripeCodes()
	consoleError.mockImplementation(() => {})
	mocks.createCheckoutSession.mockRejectedValueOnce(
		new StripeApiError('This coupon cannot be applied', { status: 400 }),
	)
	const refused = await checkout('ada', 'ada', { interval: 'year' })
	expect(refused).toMatchObject(fullPrice)
	expect(refused.promotionCodeId).toBeUndefined()
	expect(mocks.createCheckoutSession.mock.calls.at(-2)?.[1]).toMatchObject({
		promotionCodeId: 'promo_yearly',
	})
	expect(claimRows()).toEqual([])
	for (const result of [inactive, mistagged, stripeDown, refused]) {
		expect(JSON.stringify(result.data)).not.toMatch(/BLACKFRIDAY|promo/i)
	}

	// After the sale the code is not even looked up.
	vi.setSystemTime(saleEnd)
	mocks.findActivePromotionCode.mockClear()
	const after = await checkout('ada', 'ada', { interval: 'year' })
	expect(after).toMatchObject(fullPrice)
	expect(after.promotionCodeId).toBeUndefined()
	expect(mocks.findActivePromotionCode).not.toHaveBeenCalled()
})
