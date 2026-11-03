import { checkRateLimit, releaseRateLimit } from '#app/rate-limit.ts'
import type { PlanName } from '#universal/plans.ts'
import { getCachedUserPlan } from '#worker/entitlements/service.ts'
import { SearchRateLimitError } from '#worker/search-rate-limit-error.ts'

export {
	SearchRateLimitError,
	isSearchRateLimitError,
	searchRateLimitErrorCode,
	type SearchRateLimitWindow,
} from '#worker/search-rate-limit-error.ts'

/**
 * Abuse-protection ceilings for MCP/meta search — not plan entitlements.
 * Search is intentionally absent from entitlement resources / usageGet; these
 * limits only stop DOW and runaway agent loops before embeddings / Jev burn.
 *
 * Tuned against sibling daily ladders (`maxExecuteUniqueWorkersPerDay` 150 → 25_000,
 * `maxOutboundFetchesPerDay` 1_000 → 750_000): search is cheaper than execute
 * but still pays Workers AI (~$0.0009/search with Jev → ~$22.50/day at the
 * max daily ceiling). Burst is doubled relative to the initial ship so agent
 * loops have headroom when Jev is on; daily stays the DOW/cost backstop.
 */
export const searchRateLimitByPlan = {
	free: {
		burst: { maxRequests: 80, windowSeconds: 60 },
		daily: { maxRequests: 1_000, windowSeconds: 60 * 60 * 24 },
	},
	standard: {
		burst: { maxRequests: 160, windowSeconds: 60 },
		daily: { maxRequests: 5_000, windowSeconds: 60 * 60 * 24 },
	},
	pro: {
		burst: { maxRequests: 200, windowSeconds: 60 },
		daily: { maxRequests: 10_000, windowSeconds: 60 * 60 * 24 },
	},
	max: {
		burst: { maxRequests: 240, windowSeconds: 60 },
		daily: { maxRequests: 25_000, windowSeconds: 60 * 60 * 24 },
	},
} as const satisfies Record<
	PlanName,
	{
		burst: { maxRequests: number; windowSeconds: number }
		daily: { maxRequests: number; windowSeconds: number }
	}
>

export function searchBurstRateLimitKey(userId: string) {
	return `mcp-search-burst:user:${userId}`
}

export function searchDailyRateLimitKey(userId: string) {
	return `mcp-search-daily:user:${userId}`
}

/**
 * Consume burst + daily search slots for a signed-in user before paid AI
 * (embeddings / Jev). No-ops when `userId` is null (nothing to attribute).
 * If the daily window rejects after burst was consumed, the burst slot is
 * refunded so a day-cap trip does not also spend the minute budget.
 * Returns the plan the ceilings were resolved against (`free` without a
 * user) so callers do not look it up again.
 */
export async function consumeSearchRateLimit(input: {
	db: D1Database
	userId: string | null
	email: string | null | undefined
}): Promise<PlanName> {
	if (!input.userId) return 'free'

	// Abuse ceilings are plan-limit resolution: the shared 60s plan cache
	// applies, so a search does not pay a users read before its writes.
	const plan = await getCachedUserPlan(input.db, {
		userId: input.userId,
		email: input.email,
	})
	const limits = searchRateLimitByPlan[plan]
	const burstKey = searchBurstRateLimitKey(input.userId)
	const dailyKey = searchDailyRateLimitKey(input.userId)

	const burst = await checkRateLimit(input.db, burstKey, limits.burst)
	if (!burst.allowed) {
		throw new SearchRateLimitError({
			window: 'burst',
			retryAfterSeconds: burst.retryAfterSeconds ?? limits.burst.windowSeconds,
			limit: limits.burst.maxRequests,
			plan,
		})
	}

	const daily = await checkRateLimit(input.db, dailyKey, limits.daily)
	if (!daily.allowed) {
		await releaseRateLimit(input.db, burstKey).catch(() => undefined)
		throw new SearchRateLimitError({
			window: 'day',
			retryAfterSeconds: daily.retryAfterSeconds ?? limits.daily.windowSeconds,
			limit: limits.daily.maxRequests,
			plan,
		})
	}
	return plan
}
