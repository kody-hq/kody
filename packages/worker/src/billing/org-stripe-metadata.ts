import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'

/** Stripe object metadata key for org-scoped billing (ADR 0065). */
export const KODY_ORG_ID_METADATA_KEY = 'kody_org_id'

/**
 * Metadata that ties a new Stripe object to its Kody org.
 *
 * For a team org the value is the team `orgs.id`, which is not a person id.
 */
export function buildOrgBillingMetadata(orgId: string): Record<string, string> {
	return { [KODY_ORG_ID_METADATA_KEY]: orgId }
}

export function resolveOrgIdFromStripeMetadata(
	metadata: Record<string, string> | null | undefined,
): OwnerId | null {
	const orgId = metadata?.[KODY_ORG_ID_METADATA_KEY]?.trim()
	return orgId ? (orgId as OwnerId) : null
}
