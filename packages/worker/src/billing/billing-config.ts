import { toHex } from '@kody-internal/shared/hex.ts'
import {
	getPlanRank,
	parseStripePlanName,
	type PlanName,
} from '#universal/plans.ts'
import type { StripeSubscription } from './stripe-client.ts'

export type BillingEnv = {
	STRIPE_SECRET_KEY?: string
	STRIPE_PRO_PRICE_ID?: string
	STRIPE_PRO_YEARLY_PRICE_ID?: string
	STRIPE_BILLING_PORTAL_CONFIGURATION_ID?: string
}

export type BillingInterval = 'month' | 'year'
/** The only self-serve paid plan: Pro ($12) with the prepaid credit wallet. */
export type PurchasablePlan = 'pro'
/** Plans a Stripe price can grant (purchasable Pro plus retired prices). */
export type StripeGrantedPlan = 'standard' | 'pro'

/**
 * Statuses whose subscriptions keep paid entitlements. `past_due` is
 * included so a failed charge does not drop the account to free while
 * Stripe's dunning retries are still running; entitlements drop once
 * Stripe moves the subscription to `unpaid` or `canceled`.
 */
const planRetainingSubscriptionStatuses = new Set([
	'active',
	'trialing',
	'past_due',
])

/**
 * Subscriptions that currently grant a paid plan. Checkout must not create a
 * second subscription for a customer who already has one of these; plan
 * changes go through the Stripe portal's subscription-update flow instead.
 *
 * Prefer {@link selectKodyPlanRetainingSubscriptions} for any path that
 * mutates Stripe or treats "the" subscription as Kody's. This status-only
 * filter can include non-Kody products that share the Stripe account
 * (for example GratiText Premium).
 */
export function selectPlanRetainingSubscriptions(
	subscriptions: ReadonlyArray<StripeSubscription>,
): Array<StripeSubscription> {
	return subscriptions.filter((subscription) =>
		planRetainingSubscriptionStatuses.has(subscription.status),
	)
}

export function subscriptionHasPrice(
	subscription: StripeSubscription,
	priceId: string,
): boolean {
	return subscription.items.data.some((item) => item.price.id === priceId)
}

/** Stripe metadata that marks a subscription as Kody-owned. */
export const kodySubscriptionMetadataKeys = [
	'kody_org_id',
	'kody_plan',
] as const

/**
 * Every configured or retired Kody price id. Unmapped prices on the shared
 * Stripe account (other products) are never in this set.
 */
export function getAllKodyPriceIds(env: BillingEnv): Array<string> {
	return collectPriceIds([
		getProPriceId(env),
		getProYearlyPriceId(env),
		...retiredStandardPriceIds,
		...retiredProPriceIds,
	])
}

export function subscriptionHasKodyPrice(
	env: BillingEnv,
	subscription: StripeSubscription,
): boolean {
	const kodyPrices = new Set(getAllKodyPriceIds(env))
	return subscription.items.data.some((item) => kodyPrices.has(item.price.id))
}

export function subscriptionHasKodyMetadata(
	subscription: StripeSubscription,
): boolean {
	const metadata = subscription.metadata
	if (!metadata) return false
	for (const key of kodySubscriptionMetadataKeys) {
		const value = metadata[key]?.trim()
		if (value) return true
	}
	return false
}

/**
 * True when the subscription is Kody's: a known Kody price, or Kody
 * metadata. Billing code must not read-modify subscriptions that fail this
 * check (shared-account products such as GratiText Premium).
 */
export function isKodySubscription(
	env: BillingEnv,
	subscription: StripeSubscription,
): boolean {
	return (
		subscriptionHasKodyPrice(env, subscription) ||
		subscriptionHasKodyMetadata(subscription)
	)
}

/**
 * Plan-retaining subscriptions that are Kody's. Use this for seat sync,
 * checkout plan-change guards, account-deletion cancels, and any other
 * write path. Read-only plan resolution also prefers this set.
 */
export function selectKodyPlanRetainingSubscriptions(
	env: BillingEnv,
	subscriptions: ReadonlyArray<StripeSubscription>,
): Array<StripeSubscription> {
	return selectPlanRetainingSubscriptions(subscriptions).filter(
		(subscription) => isKodySubscription(env, subscription),
	)
}

/**
 * Purchasable Pro seat prices only. Retired Standard/Pro prices keep their
 * exact billing in P6 (no quantity or price changes); seat quantity sync
 * applies only to current seat prices.
 */
export function isPurchasableProSubscription(
	env: BillingEnv,
	subscription: StripeSubscription,
): boolean {
	const purchasable = new Set(getCreditsEligiblePriceIds(env))
	return subscription.items.data.some((item) => purchasable.has(item.price.id))
}

/**
 * Retired production prices that still have live subscribers. Checkout only
 * sells the configured Pro price ({@link getProPriceId}); these ids stay
 * active in Stripe and must keep resolving to standard/pro so existing
 * subscriptions keep their plan (no mass migration). None of them is
 * wallet-eligible. Delete an id once no subscriber remains on it (#2617).
 *
 * - Standard $12 / $120 (the 2026-09 public Standard) and historical $5.
 * - Pro $49 / $480 (the 2026-09 public Pro) and historical $20 / $29 / $288.
 */
export const retiredStandardPriceIds = [
	'price_1U3sg6LAQpAnsYszGeL2nc8O',
	'price_1U3sg6LAQpAnsYszqq9abwIY',
	'price_1Tv3W2LAQpAnsYszSr4PGBkE',
] as const
export const retiredProPriceIds = [
	'price_1UChg1LAQpAnsYszAYn6eGgt',
	'price_1UChg2LAQpAnsYszKAFCR778',
	'price_1U1AISLAQpAnsYszIQvRJNhl',
	'price_1U3sg6LAQpAnsYszlVpEIFGx',
	'price_1U3sg7LAQpAnsYszpozAEFUi',
] as const

/** Higher rank = more useful UX signal when no active/trialing sub exists. */
const subscriptionStatusSignalRank: Record<string, number> = {
	past_due: 100,
	unpaid: 90,
	incomplete: 80,
	paused: 70,
	incomplete_expired: 60,
	canceled: 50,
}

export type ResolvedSubscriptionPlan = {
	stripePlan: PlanName | null
	/**
	 * True when the subscription that granted `stripePlan` uses the
	 * configured (purchasable) Pro price. Persisted on
	 * `orgs.stripe_credits_eligible`; the only path to a credit wallet.
	 */
	creditsEligible: boolean
	/**
	 * Billing interval of the subscription that granted `stripePlan`, when its
	 * price is the configured monthly/yearly Pro id. Null for retired prices
	 * or metadata-only matches, so the UI cannot offer an interval switch it
	 * cannot describe.
	 */
	stripeInterval: BillingInterval | null
	/**
	 * Price id on the subscription that granted `stripePlan`, when that item
	 * is a configured or retired Standard/Pro price. Null for metadata-only
	 * grants. Persisted on `users.stripe_price_id` so a later refresh can
	 * drop `legacy` when the price, product, or interval changes.
	 */
	stripePriceId: string | null
	cancelAt: string | null
	subscriptionStatus: string | null
}

export function isBillingConfigured(env: BillingEnv) {
	return Boolean(env.STRIPE_SECRET_KEY?.trim())
}

/**
 * Stripe Billing Portal configuration (`bpc_...`) whose subscription-update
 * flow lists the purchasable Pro prices with `always_invoice` proration.
 * Unset deployments use the Stripe account's default portal configuration.
 */
export function getBillingPortalConfigurationId(env: BillingEnv) {
	return env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID?.trim() || null
}

export function getProPriceId(env: BillingEnv) {
	return env.STRIPE_PRO_PRICE_ID?.trim() || null
}

export function getProYearlyPriceId(env: BillingEnv) {
	return env.STRIPE_PRO_YEARLY_PRICE_ID?.trim() || null
}

export function parseBillingInterval(value: unknown): BillingInterval | null {
	if (value === undefined || value === null || value === '') return 'month'
	if (value === 'month' || value === 'year') return value
	return null
}

export function getPurchasablePlans(env: BillingEnv): Array<PurchasablePlan> {
	return getProPriceId(env) || getProYearlyPriceId(env) ? ['pro'] : []
}

export function getPriceIdForPlan(
	env: BillingEnv,
	plan: PurchasablePlan,
	interval: BillingInterval = 'month',
): string | null {
	switch (plan) {
		case 'pro':
			switch (interval) {
				case 'month':
					return getProPriceId(env)
				case 'year':
					return getProYearlyPriceId(env)
				default: {
					const exhaustive: never = interval
					throw new Error(`Unknown billing interval: ${String(exhaustive)}`)
				}
			}
		default: {
			const exhaustive: never = plan
			throw new Error(`Unknown purchasable plan: ${String(exhaustive)}`)
		}
	}
}

/** Configured Pro price ids (monthly and yearly): the wallet-eligible prices. */
export function getCreditsEligiblePriceIds(env: BillingEnv): Array<string> {
	return collectPriceIds([getProPriceId(env), getProYearlyPriceId(env)])
}

export function isCreditsEligiblePriceId(
	env: BillingEnv,
	priceId: string | null | undefined,
): boolean {
	const trimmed = priceId?.trim()
	if (!trimmed) return false
	return getCreditsEligiblePriceIds(env).includes(trimmed)
}

function collectPriceIds(
	ids: ReadonlyArray<string | null | undefined>,
): Array<string> {
	const seen = new Set<string>()
	const result: Array<string> = []
	for (const id of ids) {
		const trimmed = id?.trim()
		if (!trimmed || seen.has(trimmed)) continue
		seen.add(trimmed)
		result.push(trimmed)
	}
	return result
}

export function getMatchingPriceIdsForPlan(
	env: BillingEnv,
	plan: StripeGrantedPlan,
): Array<string> {
	switch (plan) {
		case 'standard':
			return collectPriceIds([...retiredStandardPriceIds])
		case 'pro':
			return collectPriceIds([
				getProPriceId(env),
				getProYearlyPriceId(env),
				...retiredProPriceIds,
			])
		default: {
			const exhaustive: never = plan
			throw new Error(`Unknown purchasable plan: ${String(exhaustive)}`)
		}
	}
}

/**
 * Unguessable checkout attribution for a billing subject id (the org id).
 * Personal orgs reuse the owner's stable user id, so single-org checkout
 * keeps the same reference. The raw id alone is NOT sufficient (legacy
 * accounts may be a plain SHA-256 of the email), so this is HMAC'd with the
 * deployment cookie secret.
 */
export async function createBillingLinkReference(
	env: Pick<Env, 'COOKIE_SECRET'>,
	billingSubjectId: string,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(env.COOKIE_SECRET),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(`billing-link:${billingSubjectId}`),
	)
	return toHex(new Uint8Array(signature))
}

function pickHigherPlan(
	current: PlanName | null,
	candidate: PlanName | null,
): PlanName | null {
	if (!candidate) return current
	if (!current) return candidate
	return getPlanRank(candidate) > getPlanRank(current) ? candidate : current
}

function planFromSubscription(
	subscription: StripeSubscription,
	standardPriceIds: ReadonlyArray<string>,
	proPriceIds: ReadonlyArray<string>,
): PlanName | null {
	const standardPriceIdSet = new Set(standardPriceIds)
	const proPriceIdSet = new Set(proPriceIds)
	let matchedStandardPrice = false
	for (const item of subscription.items.data) {
		if (proPriceIdSet.has(item.price.id)) return 'pro'
		if (standardPriceIdSet.has(item.price.id)) {
			matchedStandardPrice = true
		}
	}
	if (matchedStandardPrice) return 'standard'

	// Price ids are the primary, unambiguous source of truth; `kody_plan`
	// metadata is the fallback for subscriptions whose price id rotated.
	const metadataPlan = subscription.metadata?.['kody_plan']
	return parseStripePlanName(metadataPlan)
}

function grantingPriceIdFromSubscription(
	subscription: StripeSubscription,
	plan: PlanName,
	env: BillingEnv,
): string | null {
	if (plan !== 'standard' && plan !== 'pro') return null
	const matching = new Set(getMatchingPriceIdsForPlan(env, plan))
	for (const item of subscription.items.data) {
		if (matching.has(item.price.id)) return item.price.id
	}
	return null
}

function intervalFromSubscription(
	subscription: StripeSubscription,
	env: BillingEnv,
): BillingInterval | null {
	const monthlyPriceIds = new Set(collectPriceIds([getProPriceId(env)]))
	const yearlyPriceIds = new Set(collectPriceIds([getProYearlyPriceId(env)]))
	for (const item of subscription.items.data) {
		if (yearlyPriceIds.has(item.price.id)) return 'year'
		if (monthlyPriceIds.has(item.price.id)) return 'month'
	}
	return null
}

function pickSubscriptionStatus(
	subscriptions: ReadonlyArray<StripeSubscription>,
): string | null {
	let hasActive = false
	let hasTrialing = false
	let bestSignal: string | null = null
	let bestRank = -1

	for (const subscription of subscriptions) {
		const status = subscription.status.trim()
		if (!status) continue
		if (status === 'active') {
			hasActive = true
			continue
		}
		if (status === 'trialing') {
			hasTrialing = true
			continue
		}
		const rank = subscriptionStatusSignalRank[status] ?? 1
		if (rank > bestRank) {
			bestRank = rank
			bestSignal = status
		}
	}

	if (hasActive) return 'active'
	if (hasTrialing) return 'trialing'
	return bestSignal
}

/**
 * Map Stripe subscriptions to the highest matching Kody plan among
 * plan-retaining (active/trialing/past_due) subscriptions, plus the
 * soonest non-null cancel_at
 * (Unix seconds → ISO string) for display, and a UX-oriented
 * subscriptionStatus (prefer active/trialing, else highest-signal status
 * such as past_due).
 */
export function resolveSubscriptionPlan(
	subscriptions: ReadonlyArray<StripeSubscription>,
	env: BillingEnv,
): ResolvedSubscriptionPlan {
	const standardPriceIds = getMatchingPriceIdsForPlan(env, 'standard')
	const proPriceIds = getMatchingPriceIdsForPlan(env, 'pro')
	let stripePlan: PlanName | null = null
	let stripeInterval: BillingInterval | null = null
	let stripePriceId: string | null = null
	let creditsEligible = false
	let soonestCancelAt: number | null = null

	for (const subscription of selectKodyPlanRetainingSubscriptions(
		env,
		subscriptions,
	)) {
		const subscriptionPlan = planFromSubscription(
			subscription,
			standardPriceIds,
			proPriceIds,
		)
		const nextPlan = pickHigherPlan(stripePlan, subscriptionPlan)
		const grantingPriceId = subscriptionPlan
			? grantingPriceIdFromSubscription(subscription, subscriptionPlan, env)
			: null
		const subscriptionCreditsEligible =
			subscriptionPlan === 'pro' &&
			isCreditsEligiblePriceId(env, grantingPriceId)
		// Same rank (a retired Pro alongside the purchasable Pro): prefer the
		// wallet-eligible subscription so credits are not hidden.
		const upgradesToCredits =
			subscriptionPlan === nextPlan &&
			subscriptionCreditsEligible &&
			!creditsEligible
		if (subscriptionPlan && (nextPlan !== stripePlan || upgradesToCredits)) {
			stripeInterval = intervalFromSubscription(subscription, env)
			stripePriceId = grantingPriceId
			creditsEligible = subscriptionCreditsEligible
		}
		stripePlan = nextPlan
		if (
			typeof subscription.cancel_at === 'number' &&
			Number.isFinite(subscription.cancel_at) &&
			(soonestCancelAt == null || subscription.cancel_at < soonestCancelAt)
		) {
			soonestCancelAt = subscription.cancel_at
		}
	}

	return {
		stripePlan,
		creditsEligible,
		stripeInterval,
		stripePriceId,
		cancelAt:
			soonestCancelAt == null
				? null
				: new Date(soonestCancelAt * 1000).toISOString(),
		subscriptionStatus: pickSubscriptionStatus(subscriptions),
	}
}
