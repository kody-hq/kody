import type { PlanName } from '#universal/plans.ts'

export type SearchRateLimitWindow = 'burst' | 'day'

export const searchRateLimitErrorCode = 'rate_limited' as const

/**
 * Thrown when MCP/meta search exceeds the per-user abuse ceiling.
 * Not an entitlement denial — agents should back off, not upgrade.
 */
export class SearchRateLimitError extends Error {
	readonly code = searchRateLimitErrorCode
	readonly window: SearchRateLimitWindow
	readonly retryAfterSeconds: number
	readonly limit: number
	readonly plan: PlanName

	constructor(input: {
		window: SearchRateLimitWindow
		retryAfterSeconds: number
		limit: number
		plan: PlanName
	}) {
		const windowLabel = input.window === 'burst' ? 'per-minute' : 'per-day'
		super(
			`Search rate limit exceeded (${windowLabel}; plan "${input.plan}" allows ${input.limit} searches ${windowLabel === 'per-minute' ? 'per minute' : 'per day'}). Retry after ${input.retryAfterSeconds} seconds. This is abuse protection, not a plan quota.`,
		)
		this.name = 'SearchRateLimitError'
		this.window = input.window
		this.retryAfterSeconds = input.retryAfterSeconds
		this.limit = input.limit
		this.plan = input.plan
	}
}

export function isSearchRateLimitError(
	error: unknown,
): error is SearchRateLimitError {
	return error instanceof SearchRateLimitError
}
