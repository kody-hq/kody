import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type CommunityListingCategory } from '#universal/community-categories.ts'

export type CommunityListingStatus = 'active' | 'delisted'

export type CommunityReportStatus = 'open' | 'resolved' | 'dismissed'

export type CommunityListingRow = {
	id: string
	owner_user_id: string
	package_id: string
	source_id: string
	kody_id: string
	name: string
	description: string
	tags_json: string
	category: CommunityListingCategory
	search_text: string | null
	readme_content: string | null
	license: string
	/** package.json#version at last community publish, or null when absent. */
	package_version: string | null
	pinned_commit: string
	status: CommunityListingStatus
	featured_at: string | null
	created_at: string
	updated_at: string
	published_at: string
}

export type CommunityListingRecord = {
	id: string
	ownerUserId: OwnerId
	packageId: string
	sourceId: string
	kodyId: string
	name: string
	description: string
	tags: Array<string>
	/**
	 * Stored browse category. Publish writes `kody.category` or a tag
	 * inference; reads use the column as-is so SQL filters and chips agree.
	 */
	category: CommunityListingCategory
	searchText: string | null
	readmeContent: string | null
	license: string
	/**
	 * Author-supplied `package.json#version` captured at community publish.
	 * Null/omitted when the author did not set a string, or the listing
	 * predates the column. Not a platform versioning contract.
	 */
	version?: string | null
	pinnedCommit: string
	/**
	 * Commit the public listing icon is derived from: the owner package's
	 * current published commit when the listing's package source still
	 * exists, otherwise the pinned snapshot commit. Package publishes move
	 * this forward without a community republish, so icon URLs and cache
	 * keys bust as soon as a new `community-icon.*` is published.
	 */
	iconCommit: string
	status: CommunityListingStatus
	/**
	 * Always null. Trusted listings were removed; the public record still
	 * exposes these fields so MCP and UI contracts stay stable.
	 */
	trustedCommit: string | null
	trustedAt: string | null
	/** Always false. Trusted listings were removed. */
	trusted: boolean
	/**
	 * When an admin marked this listing as an onboarding starter package, or
	 * null when never featured (or the mark was removed). Featured is
	 * editorial only (`featured_at IS NOT NULL`) and does not depend on trust.
	 */
	featuredAt: string | null
	featured: boolean
	createdAt: string
	updatedAt: string
	publishedAt: string
}

export type CommunityListingAggregates = {
	averageStars: number | null
	ratingCount: number
	averageAdaptationEffort: number | null
	forkCount: number
}

export type ProfileVisibility = 'public' | 'private'

export type CommunityProfileRecord = {
	userId: string
	username: string
	displayName: string
	bio: string | null
	avatarKey: string | null
	visibility: ProfileVisibility
	joinedAt: string
	publicPackageCount: number
	listingCount: number
}

export type CommunityActivityEventType =
	| 'listing_published'
	| 'listing_updated'
	| 'listing_forked'

export type CommunityActivityItem = {
	type: CommunityActivityEventType
	actorUserId: string
	actorUsername: string
	actorDisplayName: string
	actorAvatarKey: string | null
	listingId: string
	listingName: string
	listingKodyId: string
	createdAt: string
}

export type PublicProfilePackage = {
	packageId: string
	name: string
	kodyId: string
	description: string
	tags: Array<string>
	updatedAt: string
	createdAt: string
	communityListingId: string | null
	/**
	 * The listing's own `kody_id`, which only moves on republish and so can lag
	 * the package's. Public links have to use this one to stay resolvable.
	 */
	communityListingKodyId: string | null
	/** published_at of the active community listing, when the package has one. */
	communityPublishedAt: string | null
	/**
	 * True when the active listing pin is behind the package published
	 * commit. False with no listing, or when the pin matches. Not derived
	 * from `updated_at` vs `published_at`.
	 */
	needsRepublish: boolean
	/**
	 * True when this row is a saved package (package extension). Plain repos
	 * from `user_repos` set this false.
	 */
	hasPackage: boolean
	/** True when the saved package declares a package app. */
	hasApp: boolean
	/** Inbound webhook endpoints declared on this saved package. */
	webhookCount: number
	/** Package-owned jobs whose `source_id` matches this saved package. */
	jobCount: number
	/** Owner-only: repo visibility. Always false on public profile lists. */
	isPrivate: boolean
	/** Owner-only: hidden from ranked search. Always false on public profile lists. */
	hidden: boolean
	/** Package published commit used to build a list identity-icon URL. */
	publishedCommit: string | null
	/** Listing icon commit when an active community listing exists. */
	listingIconCommit: string | null
	/**
	 * Plain-repo list mark commit (`indexed_commit` or `published_commit`).
	 * When set with `hasPackage: false`, `packageId` is the `user_repos.id`.
	 */
	repoIconCommit: string | null
}

/** Internal list row: `sourceId` is used to attach job counts, then stripped. */
export type PublicProfilePackageListRow = PublicProfilePackage & {
	sourceId: string
}

export type CommunityListingWithAggregates = CommunityListingRecord &
	CommunityListingAggregates

export type CommunityListingSearchResult = CommunityListingWithAggregates & {
	relevance: number | null
}

export const communityActivityKinds = ['fork', 'rating'] as const

export type CommunityActivityKind = (typeof communityActivityKinds)[number]

type CommunityActivityRecordBase = {
	id: string
	listingId: string
	listingName: string
	listingKodyId: string
	actingUsername: string | null
	occurredAt: string
}

export type CommunityActivityRecord =
	| (CommunityActivityRecordBase & {
			kind: 'fork'
	  })
	| (CommunityActivityRecordBase & {
			kind: 'rating'
			stars: number
			adaptationEffort: number
	  })

/**
 * Who caused a fork: a person clicking install in the web app, or that
 * person's agent calling `communityFork` over MCP. Null on rows created
 * before the distinction was recorded.
 */
export type CommunityForkActor = 'human' | 'agent'

export type CommunityForkRow = {
	id: string
	listing_id: string | null
	forker_user_id: string
	origin_commit: string
	forked_package_id: string
	forked_source_id: string
	target_kody_id: string
	created_at: string
	adopted_at: string | null
	adoption_note: string | null
	actor: CommunityForkActor | null
	upstream_owner_id?: string | null
	upstream_package_id?: string | null
}

/** A fork row read through a `listing_id` filter, so its listing is set. */
export type ListingCommunityForkRecord = CommunityForkRecord & {
	listingId: string
}

export type CommunityForkRecord = {
	id: string
	/** Null for a fork of a private package (see upstreamPackageId). */
	listingId: string | null
	/** Org that owns the forked private package; null for a listing fork. */
	upstreamOwnerId: string | null
	/** The forked private package; null for a listing fork. */
	upstreamPackageId: string | null
	forkerUserId: string
	originCommit: string
	forkedPackageId: string
	forkedSourceId: string
	targetKodyId: string
	createdAt: string
	adoptedAt: string | null
	adoptionNote: string | null
}

export type CommunityRatingRow = {
	id: string
	listing_id: string
	user_id: string
	stars: number
	adaptation_effort: number
	note: string | null
	created_at: string
	updated_at: string
}

export type CommunityRatingRecord = {
	id: string
	listingId: string
	userId: string
	stars: number
	adaptationEffort: number
	note: string | null
	createdAt: string
	updatedAt: string
}

export type CommunityRatingAggregate = {
	listingId: string
	averageStars: number | null
	ratingCount: number
	averageAdaptationEffort: number | null
}

export type CommunityReportRow = {
	id: string
	listing_id: string
	listing_name: string
	listing_owner_user_id: string
	reporter_user_id: string
	reason: string
	status: CommunityReportStatus
	resolved_by_user_id: string | null
	resolved_at: string | null
	resolution_note: string | null
	created_at: string
	updated_at: string
}

export type CommunityReportRecord = {
	id: string
	listingId: string
	listingName: string
	listingOwnerUserId: OwnerId
	reporterUserId: OwnerId
	reason: string
	status: CommunityReportStatus
	resolvedByUserId: string | null
	resolvedAt: string | null
	resolutionNote: string | null
	createdAt: string
	updatedAt: string
}

export type CommunityBanRow = {
	user_id: string
	banned_by_user_id: string
	reason: string
	created_at: string
}

export type CommunityBanRecord = {
	userId: string
	bannedByUserId: string
	reason: string
	createdAt: string
}

export type CommunitySnapshot = {
	version: 1
	listingId: string
	pinnedCommit: string
	files: Record<string, string>
	communityIconPath?: string | null
	createdAt: string
}

export type CrossScopeReference = {
	file: string
	specifier: string
}

export type ForkCommunityListingResult = {
	forkId: string
	packageId: string
	sourceId: string
	targetKodyId: string
	targetName: string
	originCommit: string
	crossScopeReferences: Array<CrossScopeReference>
	filesCount: number
	/**
	 * The rewritten snapshot files that were synced into the fork's source.
	 * One-click install runs publish checks against these without re-reading
	 * the snapshot; capability results must never expose them directly.
	 */
	files: Record<string, string>
	/**
	 * Request-scoped phase timings for this fork. Same shape as execute
	 * `serverTiming`. Returned on the response only — not stored.
	 */
	serverTiming?: Array<{ name: string; durationMs: number }>
	/**
	 * True when this account already had a fork of the listing (or one was
	 * in flight and finished while this request waited), so that fork is
	 * returned instead of creating a duplicate. `files` is empty and
	 * `filesCount` is 0 in that case: nothing was copied.
	 */
	alreadyForked?: boolean
	/** Human/agent readable note; set when `alreadyForked` is true. */
	message?: string
}

export type CommunityReportResolutionAction = 'dismiss' | 'delist' | 'delete'
