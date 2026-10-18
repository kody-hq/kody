import {
	checkRateLimit,
	releaseRateLimit,
	type RateLimitConfig,
	type RateLimitResult,
} from '#worker/rate-limit.ts'

export {
	checkRateLimit,
	releaseRateLimit,
	type RateLimitConfig,
	type RateLimitResult,
}

type AuthRateLimitEnv = {
	APP_DB: D1Database
	AUTH_RATE_LIMITER?: RateLimit
}

type SentryTunnelRateLimitEnv = {
	APP_DB: D1Database
	SENTRY_TUNNEL_RATE_LIMITER?: RateLimit
}

export const authRateLimitConfig: RateLimitConfig = {
	maxRequests: 10,
	windowSeconds: 60,
}

/** Public org invite-link join attempts per IP (and per token prefix). */
export const orgInviteJoinRateLimitConfig: RateLimitConfig = {
	maxRequests: 20,
	windowSeconds: 60,
}

/**
 * Guessing a 6-digit TOTP code only works with many attempts, so the second
 * factor gets a far tighter per-account budget than the per-IP auth ingress
 * limit (which a distributed attacker can spread across addresses).
 */
export const twoFactorVerifyRateLimitConfig: RateLimitConfig = {
	maxRequests: 5,
	windowSeconds: 60 * 15,
}

/**
 * A browser tab with session replay enabled posts an envelope every few
 * seconds, so the ceiling has to clear steady replay traffic while still
 * capping a scripted flood from a single address.
 */
export const sentryTunnelRateLimitConfig: RateLimitConfig = {
	maxRequests: 120,
	windowSeconds: 60,
}

/**
 * Uses Cloudflare's per-location rate-limit binding when deployed, keeping a
 * D1 fallback for local development, tests, and self-hosted configs.
 */
async function checkBoundRateLimit(
	limiter: RateLimit | undefined,
	db: D1Database,
	key: string,
	config: RateLimitConfig,
): Promise<RateLimitResult> {
	if (!limiter) {
		return checkRateLimit(db, key, config)
	}
	const result = await limiter.limit({ key })
	return result.success
		? { allowed: true, retryAfterSeconds: null }
		: { allowed: false, retryAfterSeconds: config.windowSeconds }
}

export async function checkAuthRateLimit(
	env: AuthRateLimitEnv,
	key: string,
): Promise<RateLimitResult> {
	return checkBoundRateLimit(
		env.AUTH_RATE_LIMITER,
		env.APP_DB,
		key,
		authRateLimitConfig,
	)
}

export async function checkSentryTunnelRateLimit(
	env: SentryTunnelRateLimitEnv,
	key: string,
): Promise<RateLimitResult> {
	return checkBoundRateLimit(
		env.SENTRY_TUNNEL_RATE_LIMITER,
		env.APP_DB,
		key,
		sentryTunnelRateLimitConfig,
	)
}
