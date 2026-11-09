import {
	buildForkListingDiffHref,
	buildListingAheadPrompt,
} from '#universal/community-listing-ahead.ts'
import type {
	OnboardingFeaturedListing,
	PublicCommunityActivityItem,
	PublicCommunityListing,
	PublicCommunityProfile,
	PublicProfilePackageItem,
	ViewerListingInstall,
} from '#universal/community-public-types.ts'
import {
	buildCommunityIconUrl,
	buildPackageIdentityIconUrl,
	resolvePackageListIconUrl,
} from '#universal/identity-icon-urls.ts'
import {
	buildUserAvatarUrl,
	getOwnerUsernameFromListingName,
} from '#worker/community/public-urls.ts'
import type {
	CommunityActivityItem,
	CommunityListingWithAggregates,
	CommunityProfileRecord,
	PublicProfilePackage,
} from '#worker/community/types.ts'

export {
	type OnboardingFeaturedListing,
	type PublicCommunityListing,
	type ViewerListingInstall,
} from '#universal/community-public-types.ts'
export {
	buildUserAvatarUrl,
	getOwnerUsernameFromListingName,
} from '#worker/community/public-urls.ts'

/**
 * Public payload mappers deliberately rebuild objects field-by-field so
 * internal identifiers (stable user ids, saved package ids) never serialize
 * into public JSON: stable user ids are unsalted email hashes and package
 * ids are the owner's private handles.
 */
export function toPublicCommunityProfile(
	profile: CommunityProfileRecord,
): PublicCommunityProfile {
	return {
		username: profile.username,
		displayName: profile.displayName,
		bio: profile.bio,
		avatarUrl: buildUserAvatarUrl({
			username: profile.username,
			avatarKey: profile.avatarKey,
		}),
		visibility: profile.visibility,
		joinedAt: profile.joinedAt,
		publicPackageCount: profile.publicPackageCount,
		listingCount: profile.listingCount,
	}
}

export function toPublicProfilePackageItem(
	pkg: PublicProfilePackage,
	options?: {
		includeOwnerVisibility?: boolean
		username?: string
		canOpenDetail?: boolean
	},
): PublicProfilePackageItem {
	return {
		name: pkg.name,
		kodyId: pkg.kodyId,
		description: pkg.description,
		tags: pkg.tags,
		updatedAt: pkg.updatedAt,
		createdAt: pkg.createdAt,
		communityListingId: pkg.communityListingId,
		communityListingKodyId: pkg.communityListingKodyId,
		communityPublishedAt: pkg.communityPublishedAt,
		needsRepublish: pkg.needsRepublish,
		hasPackage: pkg.hasPackage,
		hasApp: pkg.hasApp,
		webhookCount: pkg.webhookCount,
		jobCount: pkg.jobCount,
		// Plain repos share `/@:user/:kodyId/icon/:commit` with packages; the
		// route falls back to entity_kind:'repo' with the same access as the
		// detail page (public for anyone, private for org members).
		iconUrl: !pkg.hasPackage
			? options?.username && pkg.repoIconCommit
				? buildPackageIdentityIconUrl({
						username: options.username,
						kodyId: pkg.kodyId,
						iconCommit: pkg.repoIconCommit,
					})
				: null
			: options?.username
				? resolvePackageListIconUrl({
						username: options.username,
						kodyId: pkg.kodyId,
						listingId: pkg.communityListingId,
						listingIconCommit: pkg.listingIconCommit,
						publishedCommit: pkg.publishedCommit,
					})
				: null,
		...(options?.includeOwnerVisibility
			? { isPrivate: pkg.isPrivate, hidden: pkg.hidden }
			: {}),
		...(options?.canOpenDetail === false ? { canOpenDetail: false } : {}),
	}
}

export function toPublicCommunityActivityItem(
	item: CommunityActivityItem,
): PublicCommunityActivityItem {
	return {
		type: item.type,
		actorUsername: item.actorUsername,
		actorDisplayName: item.actorDisplayName,
		actorAvatarUrl: buildUserAvatarUrl({
			username: item.actorUsername,
			avatarKey: item.actorAvatarKey,
		}),
		listingId: item.listingId,
		listingName: item.listingName,
		listingKodyId: item.listingKodyId,
		createdAt: item.createdAt,
	}
}

export function truncateCommunityText(text: string, maxLength: number) {
	const trimmed = text.trim()
	if (trimmed.length <= maxLength) return trimmed
	return `${trimmed.slice(0, maxLength - 1)}…`
}

export { buildCommunityIconUrl } from '#universal/identity-icon-urls.ts'

export function toPublicCommunityListing(
	listing: CommunityListingWithAggregates,
): PublicCommunityListing {
	return {
		id: listing.id,
		kodyId: listing.kodyId,
		name: listing.name,
		description: listing.description,
		iconUrl: buildCommunityIconUrl({
			listingId: listing.id,
			iconCommit: listing.iconCommit,
		}),
		tags: listing.tags,
		category: listing.category,
		readmeContent: listing.readmeContent,
		license: listing.license,
		version: listing.version ?? null,
		pinnedCommit: listing.pinnedCommit,
		publishedAt: listing.publishedAt,
		ownerUsername: getOwnerUsernameFromListingName(listing.name),
		trusted: false,
		featured: listing.featured,
		averageStars: listing.averageStars,
		ratingCount: listing.ratingCount,
		averageAdaptationEffort: listing.averageAdaptationEffort,
		forkCount: listing.forkCount,
	}
}

export function toOnboardingFeaturedListing(
	listing: CommunityListingWithAggregates,
): OnboardingFeaturedListing {
	return {
		id: listing.id,
		kodyId: listing.kodyId,
		name: listing.name,
		description: listing.description,
		iconUrl: buildCommunityIconUrl({
			listingId: listing.id,
			iconCommit: listing.iconCommit,
		}),
		tags: listing.tags,
	}
}

export function buildForkPrompt(input: { name: string; listingId: string }) {
	return `Use Kody to fork the public package "${input.name}" (listing id: ${input.listingId}). Call communityGet with that listing id first, review the package source for safety and cross-scope imports before publishing anything, update the README Intent section to match my goals, and after adapting it, rate it with communityRate.`
}

export function buildInstallSuccessPrompt(input: { targetName: string }) {
	return `I just one-click installed the public package "${input.targetName}" into my Kody account. Call packageGet for export and secret metadata (it does not return files). Then open a repo session with repoOpenSession({ target: { kind: "package", kody_id: ${JSON.stringify(input.targetName)} } }) and repoReadFile README.md and AGENTS.md. Walk me through any remaining setup: create required secrets or OAuth connections, approve package secret access if prompted, and run a quick test to confirm it works.`
}

export function buildInstallAdaptPrompt(input: {
	targetName: string
	sourceId: string
}) {
	return `I one-click installed the public package "${input.targetName}" on Kody, but it needs adaptation before it can be published. The fork is an inert source in my account (source_id: ${input.sourceId}). Open it with repoOpenSession, do a read-only safety review of all files, fix the failing publish checks — re-implement or remove any cross-scope kody:@ imports — rewrite the README Intent section for my goals, then publish with repoPublishSession.`
}

export function buildExistingInstallPrompt(input: { targetName: string }) {
	return `I have the public package "${input.targetName}" installed in my Kody account. Call packageGet for export and secret metadata (it does not return files). Then open a repo session with repoOpenSession({ target: { kind: "package", kody_id: ${JSON.stringify(input.targetName)} } }), repoReadFile README.md and AGENTS.md, and adapt it to my needs: update the README Intent section, change behavior if needed, and publish the result.`
}

export function buildExistingAdaptPrompt(input: {
	targetName: string
	sourceId: string
}) {
	return `I already forked the public package "${input.targetName}" on Kody, but it still needs adaptation before it can be published. The fork is an inert source in my account (source_id: ${input.sourceId}). Open it with repoOpenSession, do a read-only safety review of all files, fix the failing publish checks — re-implement or remove any cross-scope kody:@ imports — rewrite the README Intent section for my goals, then publish with repoPublishSession.`
}

export function toViewerListingInstall(input: {
	status: 'installed' | 'adaptation_required'
	targetName: string
	sourceId: string
	packageId: string | null
	listingAhead?: boolean
	forkAhead?: boolean
	originCommit?: string | null
	listingPinnedCommit?: string | null
	listingId?: string
	listingName?: string
	listingKodyId?: string
}): ViewerListingInstall {
	const listingAhead = input.listingAhead === true
	const forkAhead = listingAhead ? false : input.forkAhead === true
	const listingAheadPrompt =
		listingAhead &&
		input.listingId &&
		input.listingName &&
		input.originCommit &&
		input.listingPinnedCommit
			? buildListingAheadPrompt({
					listingName: input.listingName,
					listingId: input.listingId,
					listingKodyId: input.listingKodyId,
					packageName: input.targetName,
					packageId: input.packageId,
					sourceId: input.sourceId,
					originCommit: input.originCommit,
					listingPinnedCommit: input.listingPinnedCommit,
				})
			: null
	const listingDiffHref =
		(listingAhead || forkAhead) && input.listingId && input.listingPinnedCommit
			? buildForkListingDiffHref({
					listingId: input.listingId,
					listingName: input.listingName,
					listingKodyId: input.listingKodyId,
					listingPinnedCommit: input.listingPinnedCommit,
				})
			: null
	if (input.status === 'installed') {
		return {
			status: input.status,
			targetName: input.targetName,
			agentPrompt: buildExistingInstallPrompt({
				targetName: input.targetName,
			}),
			packageId: input.packageId,
			listingAhead,
			listingAheadPrompt,
			forkAhead,
			listingDiffHref,
		}
	}
	return {
		status: input.status,
		targetName: input.targetName,
		agentPrompt: buildExistingAdaptPrompt({
			targetName: input.targetName,
			sourceId: input.sourceId,
		}),
		packageId: null,
		listingAhead,
		listingAheadPrompt,
		forkAhead,
		listingDiffHref,
	}
}
