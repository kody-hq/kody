import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	buildCommunityListingBehindHint,
	buildUpdatePublicListingHref,
	type CommunityListingBehindHint,
} from '#universal/update-public-listing.ts'
import { getCommunityListingByOwnerAndPackage } from '#worker/community/repo.ts'
import { readPackageManifestVersion } from '#worker/community/package-version.ts'
import { listingNeedsRepublish } from '#worker/community/listing-needs-republish.ts'

/**
 * When the package has an active public listing whose pin lags the given
 * published commit, return the discoverability hint. Promote auto-syncs the
 * listing; this only surfaces when sync or the scheduled backfill has not
 * caught up yet. Never moves the listing itself.
 */
export async function resolveListingBehindPublishHint(input: {
	db: D1Database
	ownerUserId: OwnerId | string
	packageId: string
	ownerUsername: string
	kodyId: string
	promotedCommit: string
	/** Author-supplied package.json#version at the promoted commit, when known. */
	promotedVersion?: string | null
	/** Absolute or path update URL. Defaults to package settings fragment. */
	updateUrl?: string
}): Promise<CommunityListingBehindHint | null> {
	// Optional discoverability only — callers (publish/promote) must still
	// return success when the catalog lookup rejects.
	try {
		const listing = await getCommunityListingByOwnerAndPackage(input.db, {
			ownerUserId: input.ownerUserId,
			packageId: input.packageId,
		})
		if (!listing || listing.status !== 'active') return null
		if (
			!listingNeedsRepublish({
				listingPinnedCommit: listing.pinnedCommit,
				sourcePublishedCommit: input.promotedCommit,
			})
		) {
			return null
		}
		return buildCommunityListingBehindHint({
			listingPinnedCommit: listing.pinnedCommit,
			promotedCommit: input.promotedCommit,
			pinnedVersion: listing.version ?? null,
			promotedVersion: input.promotedVersion ?? null,
			updateUrl:
				input.updateUrl ??
				buildUpdatePublicListingHref({
					username: input.ownerUsername,
					kodyId: input.kodyId,
				}),
		})
	} catch (error) {
		console.warn(
			`[listing-behind-hint] lookup failed for ${input.ownerUsername}/${input.kodyId}:`,
			error instanceof Error ? error.message : error,
		)
		return null
	}
}

export function readPromotedVersionFromManifest(
	manifest: unknown,
): string | null {
	if (
		manifest == null ||
		typeof manifest !== 'object' ||
		Array.isArray(manifest)
	) {
		return null
	}
	return readPackageManifestVersion(JSON.stringify(manifest))
}
