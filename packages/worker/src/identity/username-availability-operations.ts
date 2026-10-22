import { authOperationResult } from './auth-operation-result.ts'
import {
	checkUsernameAvailability,
	type UsernameSuggestionSeeds,
} from './username-availability.ts'
import { checkRateLimit, type RateLimitConfig } from '#app/rate-limit.ts'
import { getRequestIp } from '#worker/audit-log.ts'
import { normalizeUsername } from '#worker/identity/username.ts'

/** Live username checks while typing: higher than auth POST, still abuse-capped. */
export const usernameAvailabilityRateLimitConfig: RateLimitConfig = {
	maxRequests: 30,
	windowSeconds: 60,
}

export async function checkWebsiteUsernameAvailability({
	env,
	request,
	body,
}: {
	env: Env
	request: Request
	body: Record<string, unknown>
}) {
	const requestIp = getRequestIp(request) ?? 'unknown'
	const rateLimit = await checkRateLimit(
		env.APP_DB,
		`username-availability:${requestIp}`,
		usernameAvailabilityRateLimitConfig,
	)
	if (!rateLimit.allowed) {
		return authOperationResult(
			{
				ok: false as const,
				error: 'Too many username checks. Please wait a moment and try again.',
				code: 'rate_limited' as const,
			},
			{
				status: 429,
				headers: {
					'Retry-After': String(rateLimit.retryAfterSeconds ?? 60),
				},
			},
		)
	}

	const username = normalizeUsername(body.username)
	const seeds: UsernameSuggestionSeeds = {
		email: typeof body.email === 'string' ? body.email : null,
		providerUsername:
			typeof body.providerUsername === 'string' ? body.providerUsername : null,
		displayName: typeof body.displayName === 'string' ? body.displayName : null,
	}

	const result = await checkUsernameAvailability({
		db: env.APP_DB,
		username,
		env,
		seeds,
	})

	return authOperationResult({
		ok: true as const,
		...result,
	})
}
