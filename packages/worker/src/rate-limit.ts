import {
	RateLimiter,
	rateLimiterRuntime,
	type RateLimitConfig,
	type RateLimitResult,
} from '#worker/effect/rate-limit.ts'

export type { RateLimitConfig, RateLimitResult }

export function checkRateLimit(
	db: D1Database,
	key: string,
	config: RateLimitConfig,
): Promise<RateLimitResult> {
	return rateLimiterRuntime(db).runPromise(
		RateLimiter.use((limiter) => limiter.check(key, config)),
	)
}

export function releaseRateLimit(db: D1Database, key: string) {
	return rateLimiterRuntime(db).runPromise(
		RateLimiter.use((limiter) => limiter.release(key)),
	)
}
