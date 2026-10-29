import type { FeatureFlagKey } from '#universal/feature-flags/registry.ts'
import type { SessionInfo } from './session.ts'

/**
 * Synchronous client gate for evaluated feature flags embedded in the
 * session payload (SSR shell + `/session` refresh). Anonymous / missing
 * sessions treat every flag as off.
 */
export function isFeatureFlagEnabled(
	session: SessionInfo | null | undefined,
	key: FeatureFlagKey,
): boolean {
	return session?.featureFlags?.[key] === true
}
