import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'

/** Stripe object metadata keys for org-scoped billing (P6). */

export const KODY_ORG_ID_METADATA_KEY = 'kody_org_id'

/** Legacy personal-org key; same id as org for migrated rows. */
export const KODY_STABLE_USER_ID_METADATA_KEY = 'kody_stable_user_id'

/**
 * Which Stripe metadata key supplied the org id. Used to gate dropping the
 * `kody_stable_user_id` dual-write / reader fallback (Cleanup issue).
 */
export type StripeOrgIdMetadataSource =
	| 'kody_org_id'
	| 'kody_stable_user_id'
	| 'missing'

/** Stable Workers Logs event when a reader still needs the legacy metadata key. */
export const stripeMetadataOrgIdLegacyFallbackLogEvent =
	'stripe_metadata_org_id_legacy_fallback'

/**
 * Metadata for new Stripe objects during personal-org dual-resolve. Always sets
 * `kody_org_id`; also sets `kody_stable_user_id` to the same value so webhooks
 * and checkout paths that still read the legacy key keep working. Cleanup will
 * drop `kody_stable_user_id` once all readers prefer `kody_org_id`.
 *
 * For a team org the value is the team `orgs.id`, which is not a person id.
 * Equality of the two keys therefore does not mean "personal org" — that is
 * only true when the shared value also exists as `users.stable_user_id`.
 */
export function buildOrgBillingMetadata(orgId: string): Record<string, string> {
	return {
		[KODY_ORG_ID_METADATA_KEY]: orgId,
		[KODY_STABLE_USER_ID_METADATA_KEY]: orgId,
	}
}

export function classifyStripeOrgIdMetadataSource(
	metadata: Record<string, string> | null | undefined,
): StripeOrgIdMetadataSource {
	const orgId = metadata?.[KODY_ORG_ID_METADATA_KEY]?.trim()
	if (orgId) return 'kody_org_id'
	const stableUserId = metadata?.[KODY_STABLE_USER_ID_METADATA_KEY]?.trim()
	if (stableUserId) return 'kody_stable_user_id'
	return 'missing'
}

export function resolveOrgIdFromStripeMetadata(
	metadata: Record<string, string> | null | undefined,
): OwnerId | null {
	const source = classifyStripeOrgIdMetadataSource(metadata)
	if (source === 'kody_stable_user_id') {
		// Counts toward Cleanup: drop dual-write after zero legacy-only resolves.
		// Ids omitted — Workers Logs only needs the event name + source.
		console.info(stripeMetadataOrgIdLegacyFallbackLogEvent, { source })
	}
	switch (source) {
		case 'kody_org_id':
			return metadata![KODY_ORG_ID_METADATA_KEY]!.trim() as OwnerId
		case 'kody_stable_user_id':
			return metadata![KODY_STABLE_USER_ID_METADATA_KEY]!.trim() as OwnerId
		case 'missing':
			return null
		default: {
			const exhaustive: never = source
			throw new Error(`Unknown Stripe org metadata source: ${exhaustive}`)
		}
	}
}
