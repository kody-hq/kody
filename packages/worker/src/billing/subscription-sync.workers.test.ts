import { env, runInDurableObject } from 'cloudflare:test'
import { expect, test, vi } from 'vitest'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import { createBillingLinkReference } from './billing-config.ts'
import { StripeApiError } from './stripe-client.ts'
import {
	BillingLinkError,
	linkStripeCustomerFromCheckoutSession,
	linkStripeCustomerFromCheckoutSessionForOrg,
	refreshStripePlanForOrg,
	refreshStripePlanForUser,
} from './subscription-sync.ts'
import { ensureCreditWalletTestSchema } from './test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
const legacyStandardPrice = 'price_1U3sg6LAQpAnsYszGeL2nc8O'
const standardYearlyPrice = 'price_1U3sg6LAQpAnsYszqq9abwIY'

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function createBillingEnv(overrides: Partial<Env> = {}): Env {
	const testProPriceId: string = 'price_pro'
	return {
		...env,
		STRIPE_SECRET_KEY: 'sk_test_secret',
		STRIPE_PRO_PRICE_ID: testProPriceId,
		STRIPE_API_BASE_URL: 'https://stripe.mock',
		...overrides,
	} as Env
}

type SeedInput = {
	plan?: 'free' | 'pro' | 'max'
	stripeCustomerId?: string | null
	stripePlan?: string | null
	stripePriceId?: string | null
	entitlementLadder?: 'public' | 'legacy'
}

async function seedUser(label: string, input: SeedInput = {}) {
	await ensureCreditWalletTestSchema(env.APP_DB)
	const email = `${label}-${crypto.randomUUID()}@example.com`
	const stableUserId = testStableUserIdFromEmail(email)
	const username = `billing-${crypto.randomUUID().slice(0, 8)}`
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id
		) VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(
			username,
			email,
			'test-password-hash',
			new Date().toISOString(),
			stableUserId,
		)
		.run()
	await provisionPersonalOrg(env.APP_DB, {
		stableUserId,
		username,
		plan: input.plan ?? 'max',
		stripeCustomerId: input.stripeCustomerId ?? null,
		stripePlan: input.stripePlan ?? null,
		stripePriceId: input.stripePriceId ?? null,
		entitlementLadder: input.entitlementLadder ?? 'public',
	})
	const row = await env.APP_DB.prepare(`SELECT id FROM users WHERE email = ?`)
		.bind(email)
		.first<{ id: number }>()
	if (!row) throw new Error(`Failed to seed user ${email}`)
	const ownerId = ownerIdFromStored(stableUserId)
	return {
		id: row.id,
		email,
		stableUserId: ownerId,
		personalOrgId: ownerId,
		linkReference: await createBillingLinkReference(env, ownerId),
	}
}

function readUser(userId: number, columns: string) {
	return env.APP_DB.prepare(
		`SELECT ${columns}
		 FROM orgs o
		 INNER JOIN users u ON u.stable_user_id = o.id
		 WHERE u.id = ?`,
	)
		.bind(userId)
		.first()
}

function subscriptionList(id: string, status: string, priceId = 'price_pro') {
	return {
		data: [
			{
				id,
				status,
				cancel_at: null,
				items: { data: [{ price: { id: priceId } }] },
			},
		],
	}
}

function stubFetch(
	handler: (
		url: string,
		init?: RequestInit,
		request?: RequestInfo | URL,
	) => Response,
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
	subscriptions?: unknown
	subscriptionsStatus?: number
}) {
	return stubFetch((url, init) => {
		if (url.includes('/v1/checkout/sessions/')) {
			return jsonResponse(input.checkout)
		}
		// Checkout link stamps customer metadata in waitUntil after D1 link.
		if (
			url.includes('/v1/customers/') &&
			(init?.method ?? 'GET').toUpperCase() === 'POST'
		) {
			return jsonResponse({ id: 'cus_metadata' })
		}
		if (url.includes('/v1/subscriptions')) {
			return jsonResponse(
				input.subscriptions ?? subscriptionList('sub_1', 'active'),
				input.subscriptionsStatus ?? 200,
			)
		}
		return jsonResponse({ error: 'unexpected stripe path' }, 500)
	})
}

async function billingLinkErrorCode(promise: Promise<unknown>) {
	const error = await promise.then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(error instanceof BillingLinkError)) {
		throw new Error('Expected BillingLinkError')
	}
	return error.code
}

async function refreshWith(
	user: { id: number },
	customerId: string,
	subscriptions: unknown,
) {
	using _fetch = stubStripeFetch({ subscriptions })
	await refreshStripePlanForUser({
		env: createBillingEnv(),
		userId: user.id,
		customerId,
	})
	return readUser(user.id, 'stripe_plan, stripe_price_id, entitlement_ladder')
}

test('linkStripeCustomerFromCheckoutSession links customer and refreshes stripe_plan', async () => {
	const user = await seedUser('link-happy', { plan: 'pro' })
	const now = new Date('2026-07-19T12:00:00.000Z')
	using _fetch = stubStripeFetch({
		checkout: {
			id: 'cs_happy',
			customer: 'cus_happy',
			client_reference_id: user.linkReference,
		},
		subscriptions: subscriptionList('sub_happy', 'active'),
	})

	const result = await linkStripeCustomerFromCheckoutSession({
		env: createBillingEnv(),
		user,
		sessionId: 'cs_happy',
		now,
	})
	expect(result).toEqual({
		stripePlan: 'pro',
		creditsEligible: true,
		stripeInterval: 'month',
		stripePriceId: 'price_pro',
		cancelAt: null,
		subscriptionStatus: 'active',
	})
	expect(
		await readUser(
			user.id,
			'stripe_customer_id, stripe_plan, stripe_price_id, stripe_plan_refreshed_at, stripe_credits_eligible',
		),
	).toEqual({
		stripe_customer_id: 'cus_happy',
		stripe_plan: 'pro',
		stripe_price_id: 'price_pro',
		stripe_plan_refreshed_at: now.toISOString(),
		stripe_credits_eligible: 1,
	})
	const refreshAlarm = env.STRIPE_PLAN_REFRESH.get(
		env.STRIPE_PLAN_REFRESH.idFromName(user.stableUserId),
	)
	expect(
		await runInDurableObject(refreshAlarm, async (_instance, state) =>
			state.storage.getAlarm(),
		),
	).toBeTypeOf('number')
})

test('checkout linking surfaces Stripe failure when its retry alarm cannot be armed', async () => {
	const user = await seedUser('link-no-backstop', { plan: 'pro' })
	using _fetch = stubStripeFetch({
		checkout: {
			id: 'cs_no_backstop',
			customer: 'cus_no_backstop',
			client_reference_id: user.linkReference,
		},
		subscriptions: { error: 'stripe down' },
		subscriptionsStatus: 500,
	})
	consoleError.mockImplementation(() => {})
	const schedule = vi.fn(async () => {
		throw new Error('alarm unavailable')
	})
	const billingEnv = createBillingEnv({
		STRIPE_PLAN_REFRESH: {
			idFromName: env.STRIPE_PLAN_REFRESH.idFromName.bind(
				env.STRIPE_PLAN_REFRESH,
			),
			get: () => ({ schedule }),
		} as unknown as Env['STRIPE_PLAN_REFRESH'],
	})

	await expect(
		linkStripeCustomerFromCheckoutSession({
			env: billingEnv,
			user,
			sessionId: 'cs_no_backstop',
		}),
	).rejects.toBeInstanceOf(StripeApiError)
	expect(schedule).toHaveBeenCalledTimes(1)
	expect(consoleError).toHaveBeenCalledWith(
		'stripe_plan_refresh_schedule_failed',
		expect.objectContaining({ userId: user.stableUserId }),
	)
})

test('linkStripeCustomerFromCheckoutSession rejects unsafe checkout links without mutating users', async () => {
	await seedUser('link-claimed', { stripeCustomerId: 'cus_already' })
	const cases: Array<{
		label: string
		seed?: SeedInput
		customer: string | null
		clientReference?: string
		code: BillingLinkError['code']
		unchanged: Record<string, unknown>
	}> = [
		{
			label: 'link-mismatch',
			customer: 'cus_mismatch',
			clientReference: 'someone-else',
			code: 'client_reference_mismatch',
			unchanged: { stripe_customer_id: null, stripe_plan: null },
		},
		{
			label: 'link-missing-cus',
			customer: null,
			code: 'missing_customer',
			unchanged: { stripe_customer_id: null, stripe_plan: null },
		},
		{
			label: 'link-claimant',
			customer: 'cus_already',
			code: 'customer_already_linked',
			unchanged: { stripe_customer_id: null, stripe_plan: null },
		},
		{
			label: 'link-replace',
			seed: { stripeCustomerId: 'cus_original', stripePlan: 'pro' },
			customer: 'cus_other',
			code: 'account_already_linked',
			unchanged: { stripe_customer_id: 'cus_original', stripe_plan: 'pro' },
		},
	]
	for (const {
		label,
		seed,
		customer,
		clientReference,
		code,
		unchanged,
	} of cases) {
		const user = await seedUser(label, seed)
		const sessionId = `cs_${label}`
		using _fetch = stubStripeFetch({
			checkout: {
				id: sessionId,
				customer,
				client_reference_id: clientReference ?? user.linkReference,
			},
		})
		expect(
			await billingLinkErrorCode(
				linkStripeCustomerFromCheckoutSession({
					env: createBillingEnv(),
					user,
					sessionId,
				}),
			),
		).toBe(code)
		expect(await readUser(user.id, 'stripe_customer_id, stripe_plan')).toEqual(
			unchanged,
		)
	}
})

test('checkout linking assigns the Discord Pro role when Discord is connected', async () => {
	const user = await seedUser('link-discord-pro', { plan: 'free' })
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

	const discordCalls: Array<{ url: string; method: string }> = []
	using _fetch = stubFetch((url, init, request) => {
		if (url.includes('discord.com/api/v10/guilds/')) {
			discordCalls.push({
				url,
				method:
					init?.method ?? (request instanceof Request ? request.method : 'GET'),
			})
			return new Response(null, { status: 204 })
		}
		if (url.includes('/v1/checkout/sessions/')) {
			return jsonResponse({
				id: 'cs_discord_pro',
				customer: 'cus_discord_pro',
				client_reference_id: user.linkReference,
			})
		}
		if (
			url.includes('/v1/customers/') &&
			(init?.method ?? 'GET').toUpperCase() === 'POST'
		) {
			return jsonResponse({ id: 'cus_discord_pro' })
		}
		if (url.includes('/v1/subscriptions')) {
			return jsonResponse(subscriptionList('sub_discord_pro', 'active'))
		}
		return jsonResponse({ error: 'unexpected path' }, 500)
	})

	const result = await linkStripeCustomerFromCheckoutSession({
		env: createBillingEnv({
			DISCORD_BOT_TOKEN: 'bot-token-test',
			DISCORD_GUILD_ID: '111111111111111111',
			DISCORD_MEMBER_ROLE_ID: '222222222222222222',
			DISCORD_STANDARD_ROLE_ID: '444444444444444444',
			DISCORD_PRO_ROLE_ID: '555555555555555555',
		}),
		user,
		sessionId: 'cs_discord_pro',
	})
	expect(result.stripePlan).toBe('pro')
	await vi.waitFor(() => {
		expect(discordCalls).toHaveLength(3)
	})
	const roleUrl = (roleId: string) =>
		`https://discord.com/api/v10/guilds/111111111111111111/members/333333333333333333/roles/${roleId}`
	expect(discordCalls).toEqual(
		expect.arrayContaining([
			{ url: roleUrl('222222222222222222'), method: 'PUT' },
			{ url: roleUrl('444444444444444444'), method: 'DELETE' },
			{ url: roleUrl('555555555555555555'), method: 'PUT' },
		]),
	)
})

const legacyStandard: SeedInput = {
	plan: 'free',
	stripePlan: 'standard',
	stripePriceId: legacyStandardPrice,
	entitlementLadder: 'legacy',
}

test('refreshStripePlanForUser keeps legacy on same-plan renew and drops it after cancel', async () => {
	const user = await seedUser('legacy-refresh', {
		...legacyStandard,
		stripeCustomerId: 'cus_legacy_refresh',
	})

	expect(
		await refreshWith(
			user,
			'cus_legacy_refresh',
			subscriptionList('sub_still_active', 'active', legacyStandardPrice),
		),
	).toEqual({
		stripe_plan: 'standard',
		stripe_price_id: legacyStandardPrice,
		entitlement_ladder: 'legacy',
	})
	expect(await readUser(user.id, 'stripe_credits_eligible')).toEqual({
		stripe_credits_eligible: 0,
	})

	expect(
		await refreshWith(
			user,
			'cus_legacy_refresh',
			subscriptionList('sub_canceled', 'canceled', legacyStandardPrice),
		),
	).toEqual({
		stripe_plan: null,
		stripe_price_id: null,
		entitlement_ladder: 'public',
	})
})

test('refreshStripePlanForUser drops legacy when the Stripe plan or price changes', async () => {
	const cases: Array<[string, string, Record<string, unknown>]> = [
		[
			'legacy-plan-change',
			'price_pro',
			{
				stripe_plan: 'pro',
				stripe_price_id: 'price_pro',
				entitlement_ladder: 'public',
			},
		],
		[
			'legacy-interval-change',
			standardYearlyPrice,
			{
				stripe_plan: 'standard',
				stripe_price_id: standardYearlyPrice,
				entitlement_ladder: 'public',
			},
		],
	]
	for (const [label, priceId, expected] of cases) {
		const customerId = `cus_${label}`
		const user = await seedUser(label, {
			...legacyStandard,
			stripeCustomerId: customerId,
		})
		expect(
			await refreshWith(
				user,
				customerId,
				subscriptionList(`sub_${label}`, 'active', priceId),
			),
		).toEqual(expected)
	}
})

test('refreshStripePlanForUser keeps legacy on the first price observation after deploy', async () => {
	const user = await seedUser('legacy-first-price', {
		...legacyStandard,
		stripeCustomerId: 'cus_legacy_first_price',
		stripePriceId: null,
	})
	expect(
		await refreshWith(
			user,
			'cus_legacy_first_price',
			subscriptionList('sub_first_price', 'active', legacyStandardPrice),
		),
	).toEqual({
		stripe_plan: 'standard',
		stripe_price_id: legacyStandardPrice,
		entitlement_ladder: 'legacy',
	})
})

test('refreshStripePlanForUser does not re-flag a public account that resubscribes', async () => {
	const user = await seedUser('resub', {
		plan: 'free',
		stripeCustomerId: 'cus_resub',
		stripePlan: null,
		entitlementLadder: 'public',
	})
	expect(
		await refreshWith(
			user,
			'cus_resub',
			subscriptionList('sub_resub', 'active'),
		),
	).toMatchObject({ stripe_plan: 'pro', entitlement_ladder: 'public' })
})

test('team checkout links Stripe customer onto the team org, not the member personal org', async () => {
	await ensureOrgsTestSchema(env.APP_DB)
	const member = await seedUser('team-member', { plan: 'free' })
	const teamOrgId = testStableUserIdFromEmail(
		`team-org-${crypto.randomUUID()}@example.com`,
	)
	const now = new Date('2026-07-19T12:00:00.000Z')
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
	await env.APP_DB.prepare(
		`INSERT INTO org_memberships (org_id, user_id, role, created_at)
		 VALUES (?, ?, 'owner', ?)`,
	)
		.bind(teamOrgId, member.stableUserId, now.toISOString())
		.run()

	const orgLinkReference = await createBillingLinkReference(env, teamOrgId)
	using _fetch = stubStripeFetch({
		checkout: {
			id: 'cs_team_org',
			customer: 'cus_team_org',
			client_reference_id: orgLinkReference,
		},
		subscriptions: subscriptionList('sub_team_org', 'active'),
	})

	const result = await linkStripeCustomerFromCheckoutSessionForOrg({
		env: createBillingEnv(),
		orgId: ownerIdFromStored(teamOrgId),
		sessionId: 'cs_team_org',
		now,
	})
	expect(result.stripePlan).toBe('pro')

	const org = await env.APP_DB.prepare(
		`SELECT stripe_customer_id, stripe_plan FROM orgs WHERE id = ?`,
	)
		.bind(teamOrgId)
		.first<{ stripe_customer_id: string | null; stripe_plan: string | null }>()
	expect(org).toEqual({
		stripe_customer_id: 'cus_team_org',
		stripe_plan: 'pro',
	})
	expect(await readUser(member.id, 'stripe_customer_id, stripe_plan')).toEqual({
		stripe_customer_id: null,
		stripe_plan: null,
	})
})

test('refreshStripePlanForOrg rejects a different Stripe customer before forgive', async () => {
	await ensureOrgsTestSchema(env.APP_DB)
	const teamOrgId = testStableUserIdFromEmail(
		`team-mismatch-${crypto.randomUUID()}@example.com`,
	)
	const now = new Date('2026-07-19T12:00:00.000Z')
	await env.APP_DB.prepare(
		`INSERT INTO orgs (
			id, slug, plan, stripe_customer_id, stripe_plan,
			created_at, updated_at
		) VALUES (?, ?, 'pro', ?, 'pro', ?, ?)`,
	)
		.bind(
			teamOrgId,
			`team-${teamOrgId.slice(0, 8)}`,
			'cus_original',
			now.toISOString(),
			now.toISOString(),
		)
		.run()

	using _fetch = stubStripeFetch({
		subscriptions: subscriptionList('sub_other', 'active'),
	})
	await expect(
		refreshStripePlanForOrg({
			env: createBillingEnv(),
			orgId: ownerIdFromStored(teamOrgId),
			customerId: 'cus_other',
			now,
		}),
	).rejects.toThrow(/Stripe customer mismatch/)
	const org = await env.APP_DB.prepare(
		`SELECT stripe_customer_id, stripe_plan FROM orgs WHERE id = ?`,
	)
		.bind(teamOrgId)
		.first<{ stripe_customer_id: string | null; stripe_plan: string | null }>()
	expect(org).toEqual({
		stripe_customer_id: 'cus_original',
		stripe_plan: 'pro',
	})
})

test('refreshStripePlanForOrg defers until the org has a linked Stripe customer', async () => {
	await ensureOrgsTestSchema(env.APP_DB)
	const teamOrgId = testStableUserIdFromEmail(
		`team-unlinked-${crypto.randomUUID()}@example.com`,
	)
	const now = new Date('2026-07-19T12:00:00.000Z')
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

	using _fetch = stubStripeFetch({
		subscriptions: subscriptionList('sub_unlinked', 'active'),
	})
	await expect(
		refreshStripePlanForOrg({
			env: createBillingEnv(),
			orgId: ownerIdFromStored(teamOrgId),
			customerId: 'cus_unlinked',
			now,
		}),
	).rejects.toThrow(/no Stripe customer linked yet/)
	const org = await env.APP_DB.prepare(
		`SELECT stripe_customer_id, stripe_plan FROM orgs WHERE id = ?`,
	)
		.bind(teamOrgId)
		.first<{ stripe_customer_id: string | null; stripe_plan: string | null }>()
	expect(org).toEqual({
		stripe_customer_id: null,
		stripe_plan: null,
	})
})

test('checkout link replay skips Stripe subscription refresh when already linked', async () => {
	await ensureOrgsTestSchema(env.APP_DB)
	const member = await seedUser('link-replay', { plan: 'free' })
	const teamOrgId = testStableUserIdFromEmail(
		`team-replay-${crypto.randomUUID()}@example.com`,
	)
	const now = new Date('2026-07-19T12:00:00.000Z')
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
	await env.APP_DB.prepare(
		`INSERT INTO org_memberships (org_id, user_id, role, created_at)
		 VALUES (?, ?, 'owner', ?)`,
	)
		.bind(teamOrgId, member.stableUserId, now.toISOString())
		.run()
	const orgLinkReference = await createBillingLinkReference(env, teamOrgId)
	let subscriptionListCalls = 0
	using _fetch = stubFetch((url, init) => {
		if (url.includes('/v1/checkout/sessions/')) {
			return jsonResponse({
				id: 'cs_replay',
				customer: 'cus_replay',
				client_reference_id: orgLinkReference,
				metadata: { kody_plan: 'pro' },
			})
		}
		if (
			url.includes('/v1/customers/') &&
			(init?.method ?? 'GET').toUpperCase() === 'POST'
		) {
			return jsonResponse({ id: 'cus_replay' })
		}
		if (url.includes('/v1/subscriptions')) {
			subscriptionListCalls += 1
			return jsonResponse(subscriptionList('sub_replay', 'active'))
		}
		return jsonResponse({ error: 'unexpected stripe path' }, 500)
	})

	const first = await linkStripeCustomerFromCheckoutSessionForOrg({
		env: createBillingEnv(),
		orgId: ownerIdFromStored(teamOrgId),
		sessionId: 'cs_replay',
		now,
	})
	expect(first.stripePlan).toBe('pro')
	expect(subscriptionListCalls).toBe(1)

	const second = await linkStripeCustomerFromCheckoutSessionForOrg({
		env: createBillingEnv(),
		orgId: ownerIdFromStored(teamOrgId),
		sessionId: 'cs_replay',
		now: new Date(now.getTime() + 1000),
	})
	expect(second.stripePlan).toBe('pro')
	expect(second.creditsEligible).toBe(true)
	// Webhook-then-success: second pass must not list subscriptions again.
	expect(subscriptionListCalls).toBe(1)

	// Stale stripe_plan_refreshed_at (canceled-then-resubscribe) must refresh.
	await env.APP_DB.prepare(
		`UPDATE orgs SET stripe_plan = 'standard',
		 stripe_plan_refreshed_at = ? WHERE id = ?`,
	)
		.bind(new Date(now.getTime() - 60 * 60 * 1000).toISOString(), teamOrgId)
		.run()
	const third = await linkStripeCustomerFromCheckoutSessionForOrg({
		env: createBillingEnv(),
		orgId: ownerIdFromStored(teamOrgId),
		sessionId: 'cs_replay',
		now: new Date(now.getTime() + 2000),
	})
	expect(third.stripePlan).toBe('pro')
	expect(subscriptionListCalls).toBe(2)
})

test('a completed checkout with promo metadata records the claim for that person once, under its claim key', async () => {
	await ensureOrgsTestSchema(env.APP_DB)
	const member = await seedUser('promo-member', { plan: 'free' })
	const teamOrgId = testStableUserIdFromEmail(
		`promo-org-${crypto.randomUUID()}@example.com`,
	)
	const now = new Date('2026-07-19T12:00:00.000Z')
	await env.APP_DB.prepare(
		`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
		 VALUES (?, ?, 'free', ?, ?)`,
	)
		.bind(
			teamOrgId,
			`promo-${teamOrgId.slice(0, 8)}`,
			now.toISOString(),
			now.toISOString(),
		)
		.run()
	// An earlier lifetime claim does not block a campaign claim.
	await env.APP_DB.prepare(
		`INSERT INTO billing_promo_claims
		 (user_id, promotion_code_id, org_id, status, checkout_session_id, reserved_at, claimed_at)
		 VALUES (?, 'promo_earlier', 'org-earlier', 'claimed', 'cs_earlier', ?, ?)`,
	)
		.bind(member.stableUserId, now.toISOString(), now.toISOString())
		.run()
	const orgLinkReference = await createBillingLinkReference(env, teamOrgId)
	// The org has no members, so the background plan-upgrade email finds no
	// billing recipients and warns.
	consoleWarn.mockImplementation(() => {})
	using _fetch = stubStripeFetch({
		checkout: {
			id: 'cs_promo_org',
			customer: 'cus_promo_org',
			client_reference_id: orgLinkReference,
			metadata: {
				kody_promo_user_id: member.stableUserId,
				kody_promo_code_id: 'promo_agency_1',
				kody_promo_claim_key: 'campaign:fall',
			},
		},
		subscriptions: subscriptionList('sub_promo_org', 'active'),
	})

	await linkStripeCustomerFromCheckoutSessionForOrg({
		env: createBillingEnv(),
		orgId: ownerIdFromStored(teamOrgId),
		sessionId: 'cs_promo_org',
		now,
	})
	// A replay of the same link (success URL + webhook) keeps the first claim.
	await linkStripeCustomerFromCheckoutSessionForOrg({
		env: createBillingEnv(),
		orgId: ownerIdFromStored(teamOrgId),
		sessionId: 'cs_promo_org',
		now: new Date(now.getTime() + 1000),
	})

	const claims = await env.APP_DB.prepare(
		`SELECT user_id, claim_key, promotion_code_id, org_id, status, checkout_session_id, claimed_at
		 FROM billing_promo_claims WHERE user_id = ? ORDER BY claim_key`,
	)
		.bind(member.stableUserId)
		.all<Record<string, string>>()
	expect(claims.results).toEqual([
		{
			user_id: member.stableUserId,
			claim_key: 'campaign:fall',
			promotion_code_id: 'promo_agency_1',
			org_id: teamOrgId,
			status: 'claimed',
			checkout_session_id: 'cs_promo_org',
			claimed_at: now.toISOString(),
		},
		{
			user_id: member.stableUserId,
			claim_key: 'lifetime',
			promotion_code_id: 'promo_earlier',
			org_id: 'org-earlier',
			status: 'claimed',
			checkout_session_id: 'cs_earlier',
			claimed_at: now.toISOString(),
		},
	])
	await vi.waitFor(() =>
		expect(consoleWarn).toHaveBeenCalledWith(
			'billing-success-email-failed',
			expect.objectContaining({
				message: expect.stringContaining('No billing recipients with email'),
			}),
		),
	)
	expect(consoleWarn).toHaveBeenCalledTimes(1)
})
