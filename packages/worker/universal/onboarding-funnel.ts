/**
 * Activation-funnel stage names and the only dimensions that may leave the
 * product path. No prompts, secrets, emails, or free-text errors.
 *
 * Unique-user counts group on `index1` (stable user id). Dimensions are
 * closed enums or stripped card ids.
 */

import { entitlementResources } from './plans.ts'
import { onboardingChecklistItems } from './onboarding-process.ts'
import { waitingFirstUseIds } from './waiting.ts'

export {
	onboardingFunnelStageLabels,
	sanitizeFunnelClientId,
	sanitizeMcpConnectErrorClass,
	sanitizeOnboardingFunnelPlan,
} from './onboarding-funnel-point.ts'

const fixedWaitingCardIds = new Set([
	'verify-email',
	'secret-expired',
	'secret-expired-more',
	'email-change',
	'error-rate',
])

const firstUseCardIds = new Set(
	waitingFirstUseIds.map((id) => `first-use:${id}`),
)

const onboardingCardIds = new Set(
	onboardingChecklistItems.map((item) => `onboarding:${item.id}`),
)

const entitlementCardIds = new Set(
	entitlementResources.map((resource) => `entitlement:${resource}`),
)

const integrationAuthSlugPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/
const publishLockIdPattern =
	/^publish-lock:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Map a Waiting item id to a funnel card id. Secret names never pass through.
 * Unknown ids are dropped rather than stored.
 */
export function sanitizeWaitingCardId(cardId: string): string | null {
	const trimmed = cardId.trim()
	if (!trimmed || trimmed.length > 80) return null
	if (trimmed === 'secret-expired-more') return trimmed
	if (trimmed === 'secret-expired' || trimmed.startsWith('secret-expired:')) {
		return 'secret-expired'
	}
	if (trimmed === 'mcp-server' || trimmed.startsWith('mcp-server:')) {
		return 'mcp-server'
	}
	if (trimmed.startsWith('enablement-paused')) return 'enablement-paused'
	if (fixedWaitingCardIds.has(trimmed)) return trimmed
	if (firstUseCardIds.has(trimmed)) return trimmed
	if (onboardingCardIds.has(trimmed)) return trimmed
	if (entitlementCardIds.has(trimmed)) return trimmed
	if (trimmed.startsWith('integration-auth:')) {
		const slug = trimmed.slice('integration-auth:'.length)
		return integrationAuthSlugPattern.test(slug)
			? `integration-auth:${slug}`
			: 'integration-auth'
	}
	if (publishLockIdPattern.test(trimmed)) return trimmed
	if (trimmed === 'publish-lock' || trimmed.startsWith('publish-lock:')) {
		return 'publish-lock'
	}
	if (trimmed === 'publish-held' || trimmed.startsWith('publish-held:')) {
		return 'publish-held'
	}
	return null
}
