import type { OnboardingFeaturedListing } from '#universal/community-public-types.ts'

/**
 * Production featured zero-auth onboarding examples. Prefer matching live
 * featured listings by `zero-auth` tag; these ids only stabilize order and act
 * as a fallback identifier when tags are missing.
 */
const onboardingExampleListingIds = [
	'f619713e-1a01-4fbf-91f2-03660d615832', // @kody/local-conditions
	'18f8977e-a001-4c83-bddd-f329eefc3f7c', // @kody/hn-pulse
	'bd541b8f-6c77-4a8d-9151-6e3b36afa069', // @kody/personal-capture
] as const

const onboardingExampleListingIdSet = new Set<string>(
	onboardingExampleListingIds,
)

function isOnboardingExampleListing(listing: {
	id: string
	tags: Array<string>
}): boolean {
	return (
		listing.tags.includes('zero-auth') ||
		onboardingExampleListingIdSet.has(listing.id)
	)
}

/**
 * Featured zero-auth examples shown under onboarding Step 2 "Just try Kody".
 * Ordered like the known production set when present. Returns whatever the
 * featured payload includes; callers should tolerate an empty list when
 * curation has not landed yet.
 */
function selectOnboardingExampleListings(
	featuredListings: Array<OnboardingFeaturedListing>,
): Array<OnboardingFeaturedListing> {
	const examples = featuredListings.filter(isOnboardingExampleListing)
	const knownIds = onboardingExampleListingIds as ReadonlyArray<string>
	return [...examples].sort((left, right) => {
		const leftIndex = knownIds.indexOf(left.id)
		const rightIndex = knownIds.indexOf(right.id)
		const leftRank = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex
		const rightRank = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex
		return leftRank - rightRank
	})
}

export function firstInstalledOnboardingExampleName(
	listings: Array<OnboardingFeaturedListing>,
): string | null {
	const installed = selectOnboardingExampleListings(listings).find(
		(listing) => listing.viewerInstall != null,
	)
	return installed?.viewerInstall?.targetName ?? installed?.name ?? null
}
