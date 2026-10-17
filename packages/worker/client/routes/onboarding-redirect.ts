import { buildPendingVerificationPath } from '#client/routes/pending-verification-path.ts'

export const onboardingPath = '/onboarding'

/**
 * Destination for unverified onboarding visitors. Preserves only a normalized
 * same-origin redirectTo so SPA behavior matches the server handler.
 */
export function resolveOnboardingPendingVerificationPath(
	redirectTo?: string | null,
) {
	return buildPendingVerificationPath(redirectTo)
}
