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
import { loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { blackFridayCampaignId, isBlackFridayActive } from './offer.ts'

/** Stripe promotion codes by the billing interval the person picks. */
const promotionCodes: Record<BillingInterval, string> = {
	month: 'BLACKFRIDAY-MONTHLY',
	year: 'BLACKFRIDAY-YEARLY',
}

/** Both codes carry `kody_campaign=blackfriday-2026`: one claim per person. */
const claimKey = `campaign:${blackFridayCampaignId}`

export type BlackFridayBanner =
	| { audience: 'signed-out' }
	| { audience: 'free'; orgSlug: string }
	| null

/**
 * The one eligibility rule, shared by the banner and by checkout: the sale is
 * running, the org is on Free with no plan-retaining Stripe subscription
 * (`orgs.stripe_plan` is the stored result of the same subscription filter
 * checkout runs live), and the person has no claim or live reservation for
 * this campaign.
 */
async function blackFridayOfferAvailable(input: {
	db: D1Database
	userId: string
	orgId: string
	now: Date
}): Promise<boolean> {
	if (!isBlackFridayActive(input.now.getTime())) return false
	const row = await input.db
		.prepare(
			`SELECT ${userEntitlementColumnsSql()} FROM orgs WHERE id = ? AND deleted_at IS NULL`,
		)
		.bind(input.orgId)
		.first<UserEntitlementRow>()
	if (!row || row.stripe_plan) return false
	if (resolveUserPlanFromRow(row, input.now).plan !== 'free') return false
	return !(await hasBlockingPromoClaim({
		db: input.db,
		userId: input.userId,
		claimKey,
		now: input.now,
	}))
}

/** What the shell shows this viewer, if anything. */
export async function loadBlackFridayBanner(input: {
	env: Env
	user: Pick<AuthenticatedAppUser, 'mcpUser'> | null
	/** Organizations of the signed-in session; null when signed out. */
	organizations: ReadonlyArray<{ slug: string; personal: boolean }> | null
	/** Shell path: `/@slug` for an org page, `/` otherwise. */
	pathname: string
	now: Date
}): Promise<BlackFridayBanner> {
	if (!isBlackFridayActive(input.now.getTime())) return null
	if (!input.user || !input.organizations) return { audience: 'signed-out' }
	const scoped = /^\/@([^/]+)/.exec(input.pathname)?.[1]
	const orgSlug = scoped
		? decodeURIComponent(scoped)
		: input.organizations.find((org) => org.personal)?.slug
	if (!orgSlug) return null
	const userId = input.user.mcpUser.userId
	const binding = await loadOrgBindingForSlug(input.env.APP_DB, userId, orgSlug)
	if (!binding || binding.role == null) return null
	try {
		await authorize(
			{
				env: input.env,
				request: deriveRequestContext({
					user: input.user.mcpUser,
					source: { kind: 'session' },
					orgBinding: binding,
				}),
			},
			'billing:write',
		)
	} catch (error) {
		if (error instanceof AuthorizationError) return null
		throw error
	}
	const available = await blackFridayOfferAvailable({
		db: input.env.APP_DB,
		userId,
		orgId: binding.org.id,
		now: input.now,
	})
	return available
		? { audience: 'free', orgSlug: binding.org.slug ?? orgSlug }
		: null
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
	const available = await blackFridayOfferAvailable({
		db: input.env.APP_DB,
		userId: input.userId,
		orgId: input.orgId,
		now: input.now,
	})
	if (!available) return null
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
		if (!(error instanceof StripeApiError)) throw error
		console.info('billing_checkout_campaign_promo_unavailable', {
			campaign: blackFridayCampaignId,
			interval: input.interval,
			reason: error.message,
		})
	}
	return null
}
