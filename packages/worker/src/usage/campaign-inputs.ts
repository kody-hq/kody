import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { resolveUserEntitlementFromRow } from '#worker/entitlements/service.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'
import type { OAuthGrantListHelpers } from '#worker/oauth-grants.ts'
import {
	parseStripePlanName,
	resolveEntitlementLimits,
} from '#universal/plans.ts'
import { countDistinctInboundClientIds } from './campaign-inbound-clients.ts'
import {
	usageCampaignLimitAwareThreshold,
	usageCampaignStrongUseActiveMs,
	usageCampaignStrongUseMinExecuteEvents,
} from './campaign-states.ts'
import type { UsageCampaignSnapshot } from './campaign-evaluator.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export type UsageCampaignCandidate = {
	stable_user_id: OwnerId
	username: string
	email: string
	email_verified_at: string
	first_mcp_connected_at: string | null
	first_saved_package_at: string | null
	first_execute_at: string | null
	mcp_client_name: string | null
	last_active_at: string | null
	second_agent_standard_gift_granted_at: string | null
	second_agent_standard_gift_expires_at: string | null
	referral_standard_credit_expires_at: string | null
	plan: string
	stripe_plan: string | null
	entitlement_ladder: string | null
	stripe_credits_eligible?: number | null
	admin_credits_eligible?: number | null
}

/**
 * Live reads that sit beside the user stamps: distinct inbound clientIds
 * (paged grants, not grant count), jobs, execute-rollup depth, stock caps.
 */
export async function gatherUsageCampaignSnapshot(input: {
	env: Env
	user: UsageCampaignCandidate
	now: Date
}): Promise<UsageCampaignSnapshot> {
	const [clients, jobs, execute, nearCap] = await Promise.all([
		countDistinctInboundClients(input.env, input.user.stable_user_id),
		readJobActivity(input.env, input.user.stable_user_id),
		readMonthlyExecuteCount(
			input.env.APP_DB,
			input.user.stable_user_id,
			input.now,
		),
		readNearStockCap({
			db: input.env.APP_DB,
			user: input.user,
			now: input.now,
		}),
	])

	return {
		emailVerifiedAt: input.user.email_verified_at,
		firstMcpConnectedAt: input.user.first_mcp_connected_at,
		firstSavedPackageAt: input.user.first_saved_package_at,
		lastActiveAt: input.user.last_active_at,
		distinctInboundClientCount: clients.uniqueClientCount,
		inboundListingFailed: clients.listingFailed,
		hasEnabledScheduledJob: jobs.hasEnabledScheduledJob,
		lastJobActivityAt: jobs.lastJobActivityAt,
		jobListingFailed: jobs.listingFailed,
		hasStrongRecentUse: isStrongRecentUse({
			lastActiveAt: input.user.last_active_at,
			firstExecuteAt: input.user.first_execute_at,
			executeCount: execute.eventCount,
			now: input.now,
		}),
		executeReadFailed: execute.readFailed,
		isStripePaid: isStripePaidPlan(input.user.stripe_plan),
		isNearEntitlementCap: nearCap,
		username: input.user.username,
		now: input.now,
	}
}

export function isStripePaidPlan(stripePlan: string | null) {
	const parsed = parseStripePlanName(stripePlan)
	return parsed === 'standard' || parsed === 'pro'
}

export function isStrongRecentUse(input: {
	lastActiveAt: string | null
	firstExecuteAt: string | null
	executeCount: number
	now: Date
}) {
	if (input.firstExecuteAt == null) return false
	if (input.executeCount < usageCampaignStrongUseMinExecuteEvents) return false
	if (input.lastActiveAt == null) return false
	const lastActive = Date.parse(input.lastActiveAt)
	if (!Number.isFinite(lastActive)) return false
	return input.now.getTime() - lastActive < usageCampaignStrongUseActiveMs
}

async function countDistinctInboundClients(env: Env, userId: OwnerId) {
	const helpers = await resolveOAuthHelpers<OAuthGrantListHelpers>(env)
	return countDistinctInboundClientIds(helpers, userId)
}

async function readJobActivity(env: Env, userId: string) {
	try {
		const jobs = await jobsData(env).listJobsForUser({ userId })
		let hasEnabledScheduledJob = false
		let lastJobActivityAt: string | null = null
		for (const job of jobs) {
			if (job.record.enabled && !job.record.killSwitchEnabled) {
				hasEnabledScheduledJob = true
			}
			const runAt = job.record.lastRunAt
			if (runAt && (lastJobActivityAt == null || runAt > lastJobActivityAt)) {
				lastJobActivityAt = runAt
			}
		}
		return {
			hasEnabledScheduledJob,
			lastJobActivityAt,
			listingFailed: false,
		}
	} catch (error) {
		console.warn('usage-campaign-jobs-read-failed', error)
		return {
			hasEnabledScheduledJob: false,
			lastJobActivityAt: null,
			listingFailed: true,
		}
	}
}

async function readMonthlyExecuteCount(
	db: D1Database,
	userId: string,
	now: Date,
) {
	try {
		const row = await db
			.prepare(
				`SELECT event_count FROM usage_rollups
				 WHERE user_id = ? AND metric = 'execute' AND month = ?`,
			)
			.bind(userId, utcMonthKey(now))
			.first<{ event_count: number }>()
		return {
			eventCount: Number(row?.event_count ?? 0),
			readFailed: false,
		}
	} catch (error) {
		console.warn('usage-campaign-execute-read-failed', error)
		return {
			eventCount: 0,
			readFailed: true,
		}
	}
}

async function readNearStockCap(input: {
	db: D1Database
	user: UsageCampaignCandidate
	now: Date
}) {
	try {
		const entitlement = await resolveUserEntitlementFromRow({
			db: input.db,
			stableUserId: input.user.stable_user_id,
			row: input.user,
			now: input.now,
		})
		const limits = resolveEntitlementLimits(entitlement, input.now)
		const [packages, secrets] = await Promise.all([
			input.db
				.prepare(
					`SELECT COUNT(*) AS count FROM saved_packages WHERE user_id = ?${andLiveDeletedAtSql()}`,
				)
				.bind(input.user.stable_user_id)
				.first<{ count: number }>(),
			input.db
				.prepare(
					`SELECT COUNT(*) AS count FROM secret_entries se
					 JOIN secret_buckets sb ON sb.id = se.bucket_id
					 WHERE sb.user_id = ?
					   AND (sb.expires_at IS NULL OR sb.expires_at > ?)${andLiveDeletedAtSql('se')}${andLiveDeletedAtSql('sb')}`,
				)
				.bind(input.user.stable_user_id, input.now.toISOString())
				.first<{ count: number }>(),
		])
		const packageCount = Number(packages?.count ?? 0)
		const secretCount = Number(secrets?.count ?? 0)
		return (
			packageCount >=
				Math.ceil(limits.maxSavedPackages * usageCampaignLimitAwareThreshold) ||
			secretCount >=
				Math.ceil(limits.maxSecrets * usageCampaignLimitAwareThreshold)
		)
	} catch (error) {
		console.warn('usage-campaign-stock-read-failed', error)
		return false
	}
}
