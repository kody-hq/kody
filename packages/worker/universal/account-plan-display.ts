import type { AdminPlanName } from '#universal/loader-data.ts'

/**
 * True when an admin grant is a deliberate non-free override that does not
 * match the Stripe subscription. Ordinary subscribers keep `orgs.plan =
 * 'free'` with their paid tier only on `orgs.stripe_plan`; that is not a
 * split.
 */
export function adminGrantDiffersFromSubscription(
	manualPlan: AdminPlanName,
	stripePlan: AdminPlanName | null,
) {
	return manualPlan !== 'free' && stripePlan !== manualPlan
}
