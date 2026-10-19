import { parseStoredPlanName, parseStripePlanName } from '#universal/plans.ts'
import {
	canBuyCreditsForUser,
	loadAccountUsageCredits,
} from '#app/account-credits-data.ts'
import { type BillingPageOrg } from '#app/account-billing-data.ts'
import { loadAccountUsageStory } from '#app/account-usage-story.ts'
import { isBillingConfigured } from '#worker/billing/billing-config.ts'
import { readCreditWallet } from '#worker/billing/credit-wallet.ts'
import { reconcileSignupWelcomeCreditsIfPending } from '#worker/billing/signup-welcome-credits.ts'
import { readAccountComputeOverage } from '#worker/billing/compute-overage-account.ts'
import {
	resolveUserEntitlementFromRow,
	resolveUserPlanFromRow,
	userEntitlementColumnsSql,
	type UserEntitlementRow,
} from '#worker/entitlements/service.ts'
import { readEntitlementUsageSnapshot } from '#worker/entitlements/usage-snapshot.ts'
import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	type AccountUsageEntitlementConsumption,
	type AccountUsageLoaderData,
	type AccountUsageWeekWindow,
} from '#universal/loader-data.ts'
import { loadCreditAttributionBreakdown } from '#worker/usage/credit-attribution.ts'
import { orgBillingPath } from '#universal/org-pages.ts'

type PersonalUsageRow = UserEntitlementRow & {
	id: number
	stable_user_id: string
	personal_org_id: string | null
	org_id: string
	username: string
	stripe_customer_id: string | null
}

type TeamUsageRow = UserEntitlementRow & {
	slug: string
	display_name: string | null
	stripe_customer_id: string | null
}

type ResolvedUsageOrg = {
	usageUserId: OwnerId
	username: string
	stripeCustomerId: string | null
	row: UserEntitlementRow
}

async function readPersonalUsageOrg(
	env: Env,
	userId: number,
): Promise<ResolvedUsageOrg | null> {
	const row = await env.APP_DB.prepare(
		`SELECT u.id, u.stable_user_id, u.personal_org_id, o.id AS org_id,
		        u.username, o.stripe_customer_id, ${userEntitlementColumnsSql('o')}
		 FROM users u
		 INNER JOIN orgs o ON o.id = COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id)
		 WHERE u.id = ?${andLiveDeletedAtSql('u')}${andLiveDeletedAtSql('o')}`,
	)
		.bind(userId)
		.first<PersonalUsageRow>()
	if (!row) return null
	const orgId =
		row.org_id?.trim() ||
		row.personal_org_id?.trim() ||
		row.stable_user_id.trim()
	return {
		// Usage / wallets / welcome credits are owner-keyed (personal org id).
		usageUserId: ownerIdFromStored(orgId),
		username: row.username,
		stripeCustomerId: row.stripe_customer_id?.trim() || null,
		row,
	}
}

async function readTeamUsageOrg(
	env: Env,
	org: BillingPageOrg,
): Promise<ResolvedUsageOrg | null> {
	const row = await env.APP_DB.prepare(
		`SELECT slug, display_name, stripe_customer_id, ${userEntitlementColumnsSql()}
		 FROM orgs
		 WHERE id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(org.id)
		.first<TeamUsageRow>()
	if (!row) return null
	return {
		usageUserId: org.id,
		username: row.slug.trim() || org.slug,
		stripeCustomerId: row.stripe_customer_id?.trim() || null,
		row,
	}
}

/**
 * Plan, entitlement consumption, and Credits for one organization. Personal
 * orgs keep the users⋈orgs join; team orgs read plan columns from `orgs` and
 * meter against that org's id (the same `user_id` column usage rollups and
 * credit wallets already use).
 */
export async function loadAccountUsageData(input: {
	env: Env
	/** `users.id` of the signed-in person (personal-org overlays). */
	userId: number
	org: BillingPageOrg
	now?: Date
	notice?: string
	error?: string
}): Promise<AccountUsageLoaderData | null> {
	const now = input.now ?? new Date()
	const resolved = input.org.personal
		? await readPersonalUsageOrg(input.env, input.userId)
		: await readTeamUsageOrg(input.env, input.org)
	if (!resolved) return null

	const { usageUserId, username, stripeCustomerId, row } = resolved
	const manualPlan = parseStoredPlanName(row.plan)
	// Best-effort: retry a creation-time welcome grant that failed earlier.
	// No-ops unless signup_welcome_credits_pending is set (no pre-ship backfill).
	// Team orgs never receive the signup welcome grant.
	if (input.org.personal) {
		await reconcileSignupWelcomeCreditsIfPending({
			db: input.env.APP_DB,
			userId: usageUserId,
			now,
		})
	}
	const { creditsEligible } = resolveUserPlanFromRow(row, now)
	// One credit_wallets read for entitlement balance + Credits section.
	const wallet = creditsEligible
		? await readCreditWallet(input.env.APP_DB, usageUserId)
		: null
	const entitlement = await resolveUserEntitlementFromRow({
		db: input.env.APP_DB,
		stableUserId: usageUserId,
		row,
		now,
		...(wallet ? { balanceMicroUsd: wallet.balanceMicroUsd } : {}),
	})
	const [snapshot, computeOverage] = await Promise.all([
		readEntitlementUsageSnapshot({
			db: input.env.APP_DB,
			env: input.env,
			usageUserId,
			entitlement,
			now,
		}),
		readAccountComputeOverage({
			db: input.env.APP_DB,
			stableUserId: usageUserId,
			plan: entitlement.plan,
			ladder: entitlement.ladder,
			creditWallet: entitlement.creditWallet,
			limitOverrides: entitlement.limitOverrides,
			now,
		}),
	])
	const canBuyCredits = canBuyCreditsForUser({
		row,
		entitlement,
		stripeCustomerId,
	})
	const billingHref = orgBillingPath(input.org.slug)
	const { credits, wallet: creditsWallet } = await loadAccountUsageCredits({
		env: input.env,
		stableUserId: usageUserId,
		entitlement,
		canBuyCredits,
		computeOverage,
		now,
		billingHref,
		...(wallet ? { wallet } : {}),
	})
	const [story, whereItWent] = await Promise.all([
		loadAccountUsageStory({
			db: input.env.APP_DB,
			stableUserId: usageUserId,
			plan: entitlement.plan,
			creditWallet: entitlement.creditWallet,
			canBuyCredits: canBuyCredits && isBillingConfigured(input.env),
			computeOverage,
			now,
			...(creditsWallet ? { wallet: creditsWallet } : {}),
		}),
		loadCreditAttributionBreakdown({
			db: input.env.APP_DB,
			stableUserId: usageUserId,
			username,
			computeOverage,
			now,
		}),
	])

	return {
		ok: true,
		plan: snapshot.plan,
		manualPlan,
		stripePlan: parseStripePlanName(row.stripe_plan),
		today: snapshot.today,
		weekStart: snapshot.weekStart,
		entitlementConsumption: snapshot.resources.map(toAccountUsageRow),
		// Monthly include pressure is the credits alarm (`creditsAlarm`), not a
		// warning row, so the page raises it once.
		warnings: snapshot.warnings.map(toAccountUsageRow),
		computeOverage,
		canBuyCredits,
		...story,
		whereItWent,
		credits,
		...(input.notice ? { notice: input.notice } : {}),
		...(input.error ? { error: input.error } : {}),
	}
}

function toAccountUsageRow(row: {
	resource: string
	label: string
	group: AccountUsageEntitlementConsumption['group']
	kind: AccountUsageEntitlementConsumption['kind']
	whatCounts: string
	howToReduce: string
	current: number
	limit: number
	percentOfLimit: number | null
	overEightyPercent: boolean
	week?: AccountUsageWeekWindow
	storageByKind?: AccountUsageEntitlementConsumption['storageByKind']
}): AccountUsageEntitlementConsumption {
	return {
		resource: row.resource,
		label: row.label,
		group: row.group,
		kind: row.kind,
		whatCounts: row.whatCounts,
		howToReduce: row.howToReduce,
		current: row.current,
		limit: row.limit,
		percentOfLimit: row.percentOfLimit,
		overEightyPercent: row.overEightyPercent,
		...(row.week ? { week: row.week } : {}),
		...(row.storageByKind ? { storageByKind: row.storageByKind } : {}),
	}
}
