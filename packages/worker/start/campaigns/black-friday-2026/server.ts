/**
 * Server side of the Black Friday 2026 campaign: who gets the offer, and
 * which Stripe promotion code checkout applies for them. Never import this
 * from browser code: the code names stay on the server.
 */
import type { AuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	authorize,
	AuthorizationError,
} from '#worker/authorization/authorize.ts'
import type { BillingInterval } from '#worker/billing/billing-config.ts'
import {
	hasBlockingPromoClaim,
	promoClaimedRejection,
	resolveCheckoutPromotionCode,
} from '#worker/billing/checkout-promo.ts'
import {
	StripeApiError,
	type StripeEnv,
} from '#worker/billing/stripe-client.ts'
import {
	resolveUserPlanFromRow,
	userEntitlementColumnsSql,
	type UserEntitlementRow,
} from '#worker/entitlements/service.ts'
import { loadOrgBindingsForSlugs } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import {
	blackFridayCampaignId,
	blackFridayCheckoutSummary,
	isBlackFridayActive,
} from './offer.ts'

/** Stripe promotion codes by the billing interval the person picks. */
const promotionCodes: Record<BillingInterval, string> = {
	month: 'BLACKFRIDAY-MONTHLY',
	year: 'BLACKFRIDAY-YEARLY',
}

/** Both codes carry `kody_campaign=blackfriday-2026`: one claim per person. */
const claimKey = `campaign:${blackFridayCampaignId}`

/** Keeps the org lookup inside one D1 statement for people in many orgs. */
const maxOrgsChecked = 50

export type BlackFridayBanner =
	| { audience: 'signed-out' }
	| { audience: 'free'; orgSlugs: Array<string> }
	| null

/**
 * The one eligibility rule, shared by the banner and by checkout. Returns the
 * ids among `orgIds` that can take the offer: the sale is running, the person
 * has no claim or live reservation for this campaign, and the org is on Free
 * with no plan-retaining Stripe subscription (`orgs.stripe_plan` is the
 * stored result of the same subscription filter checkout runs live).
 */
async function blackFridayOfferOrgIds(input: {
	db: D1Database
	userId: string
	orgIds: ReadonlyArray<string>
	now: Date
}): Promise<Set<string>> {
	const eligible = new Set<string>()
	if (!isBlackFridayActive(input.now.getTime())) return eligible
	const orgIds = input.orgIds.slice(0, maxOrgsChecked)
	if (orgIds.length === 0) return eligible
	const [claimed, rows] = await Promise.all([
		hasBlockingPromoClaim({
			db: input.db,
			userId: input.userId,
			claimKey,
			now: input.now,
		}),
		input.db
			.prepare(
				`SELECT id, ${userEntitlementColumnsSql()} FROM orgs
				 WHERE id IN (${orgIds.map(() => '?').join(', ')}) AND deleted_at IS NULL`,
			)
			.bind(...orgIds)
			.all<UserEntitlementRow & { id: string }>(),
	])
	if (claimed) return eligible
	for (const row of rows.results ?? []) {
		if (row.stripe_plan) continue
		if (resolveUserPlanFromRow(row, input.now).plan !== 'free') continue
		eligible.add(row.id)
	}
	return eligible
}

/**
 * What the shell shows this viewer, if anything: for a signed-in person, the
 * slugs of their organizations that can take the offer and that they hold
 * `billing:write` in. A failure here must not take the page down with it.
 */
export async function loadBlackFridayBanner(input: {
	env: Env
	user: Pick<AuthenticatedAppUser, 'mcpUser'> | null
	/** Organizations of the signed-in session; null when signed out. */
	organizations: ReadonlyArray<{ slug: string }> | null
	now: Date
}): Promise<BlackFridayBanner> {
	if (!isBlackFridayActive(input.now.getTime())) return null
	const { user, organizations } = input
	if (!user || !organizations) return { audience: 'signed-out' }
	try {
		const userId = user.mcpUser.userId
		const bindings = [
			...(
				await loadOrgBindingsForSlugs(
					input.env.APP_DB,
					userId,
					organizations.map((org) => org.slug),
				)
			).entries(),
		].filter(([, binding]) => binding.role != null)
		const eligible = await blackFridayOfferOrgIds({
			db: input.env.APP_DB,
			userId,
			orgIds: bindings.map(([, binding]) => binding.org.id),
			now: input.now,
		})
		const orgSlugs = (
			await Promise.all(
				bindings
					.filter(([, binding]) => eligible.has(binding.org.id))
					.map(async ([slug, orgBinding]) => {
						try {
							await authorize(
								{
									env: input.env,
									request: deriveRequestContext({
										user: user.mcpUser,
										source: { kind: 'session' },
										orgBinding,
									}),
								},
								'billing:write',
							)
							return slug
						} catch (error) {
							if (error instanceof AuthorizationError) return null
							throw error
						}
					}),
			)
		).filter((slug) => slug !== null)
		return orgSlugs.length > 0 ? { audience: 'free', orgSlugs } : null
	} catch (error) {
		console.error('black_friday_banner_load_failed', error)
		return null
	}
}

/**
 * What a checkout link says about the sale before the person pays: the sale
 * price when {@link resolveBlackFridayCheckoutPromo} would apply a code for
 * them, or why it will not. Null once the sale is over. Never names a code.
 */
export async function loadBlackFridayCheckoutOffer(input: {
	db: D1Database
	userId: string
	orgId: string
	interval: BillingInterval
	now: Date
}): Promise<
	{ applies: true; summary: string } | { applies: false; reason: string } | null
> {
	if (!isBlackFridayActive(input.now.getTime())) return null
	const eligible = await blackFridayOfferOrgIds({
		db: input.db,
		userId: input.userId,
		orgIds: [input.orgId],
		now: input.now,
	})
	if (eligible.has(input.orgId)) {
		return {
			applies: true,
			summary: blackFridayCheckoutSummary[input.interval],
		}
	}
	const claimed = await hasBlockingPromoClaim({
		db: input.db,
		userId: input.userId,
		claimKey,
		now: input.now,
	})
	return {
		applies: false,
		reason: claimed
			? promoClaimedRejection(claimKey)
			: 'The sale price is for organizations on the Free plan with no subscription.',
	}
}

/**
 * The promotion code checkout applies when the person typed none. Null means
 * "no campaign discount": checkout continues at full price. The code goes
 * through the same validation as a typed code.
 */
export async function resolveBlackFridayCheckoutPromo(input: {
	env: StripeEnv & { APP_DB: D1Database }
	userId: string
	orgId: string
	interval: BillingInterval
	now: Date
}): Promise<{ promotionCodeId: string; claimKey: string } | null> {
	const eligible = await blackFridayOfferOrgIds({
		db: input.env.APP_DB,
		userId: input.userId,
		orgIds: [input.orgId],
		now: input.now,
	})
	if (!eligible.has(input.orgId)) return null
	try {
		const resolved = await resolveCheckoutPromotionCode(input.env, {
			code: promotionCodes[input.interval],
			interval: input.interval,
			now: input.now,
		})
		if (resolved.ok && resolved.claimKey === claimKey) {
			return { promotionCodeId: resolved.id, claimKey }
		}
		console.info('billing_checkout_campaign_promo_unavailable', {
			campaign: blackFridayCampaignId,
			interval: input.interval,
			reason: resolved.ok ? 'claim key mismatch' : resolved.error,
		})
	} catch (error) {
		// Stripe errors, timeouts, and network failures alike: no discount, but
		// the person still reaches checkout.
		const log = error instanceof StripeApiError ? console.info : console.error
		log('billing_checkout_campaign_promo_unavailable', {
			campaign: blackFridayCampaignId,
			interval: input.interval,
			reason: error instanceof Error ? error.message : String(error),
		})
	}
	return null
}
