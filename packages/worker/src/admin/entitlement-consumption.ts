import {
	entitlementResourceLabels,
	resolveEntitlementLimit,
	type EntitlementResource,
	type UserEntitlement,
} from '#universal/plans.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { readCurrentEntitlementResourceUsage } from '#worker/entitlements/service.ts'
import type { AdminUsageEntitlementConsumption } from '#universal/loader-data.ts'

export const adminEntitlementResources = [
	'saved_packages',
	'scheduled_jobs',
	'repo_sessions',
	'email_sends_per_day',
	'email_receives_per_day',
	'stored_email_messages',
	'secrets',
	'concurrent_workflows',
	'execute_unique_workers_per_day',
	'outbound_fetches_per_day',
	'job_runs_per_day',
	'automation_invocations_per_day',
	'storage_bytes',
] as const satisfies ReadonlyArray<EntitlementResource>

export const entitlementWarningThreshold = 0.8

/**
 * Current entitlement consumption for one account. `storage_bytes` is read from
 * UserMeter via `readCurrentEntitlementResourceUsage`, matching the signed-in
 * account usage page. `ladder` must be the account's stored
 * `users.entitlement_ladder` so legacy Standard/Pro is scored against
 * `legacyPlanLimits`, matching `consumeDailyEntitlement`.
 *
 * Pass {@link inboundReceive} when the account may have a temporary Pro
 * overlay: inbound mail enforces `email_receives_per_day` against the base
 * (manual + Stripe) plan, never the gift overlay, so fleet / admin pressure
 * must score that one resource the same way.
 */
export async function readAdminEntitlementConsumption(input: {
	env: Env
	usageUserId: OwnerId
	/** Effective entitlement: plan, seat pool, and limit overrides. */
	entitlement: UserEntitlement
	now: Date
	/**
	 * Base-plan entitlement for `email_receives_per_day` when it differs from
	 * the effective plan (gift / referral overlays).
	 */
	inboundReceive?: UserEntitlement
}): Promise<Array<AdminUsageEntitlementConsumption>> {
	return await Promise.all(
		adminEntitlementResources.map(async (resource) => {
			const current = await readCurrentEntitlementResourceUsage({
				db: input.env.APP_DB,
				env: input.env,
				userId: input.usageUserId,
				resource,
				now: input.now,
			})
			const limitEntitlement =
				resource === 'email_receives_per_day' && input.inboundReceive
					? input.inboundReceive
					: input.entitlement
			const limit = resolveEntitlementLimit(
				limitEntitlement,
				resource,
				input.now,
			)
			const percentOfLimit = limit === 0 ? null : current / limit
			return {
				resource,
				label: entitlementResourceLabels[resource],
				current,
				limit,
				percentOfLimit,
				overEightyPercent:
					percentOfLimit !== null &&
					percentOfLimit > entitlementWarningThreshold,
			}
		}),
	)
}
