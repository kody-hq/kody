import { type CommunityListingCategory } from '#universal/community-categories.ts'

/**
 * Signed-in viewer's existing fork/install of a community listing. Present
 * only on viewer-specific payloads (never cached with public listing rows).
 */
export type ViewerListingInstall = {
	status: 'installed' | 'adaptation_required'
	targetName: string
	agentPrompt: string
	/**
	 * Saved package id when the viewer has a live package for this listing.
	 * Null for inert forks that still need adaptation.
	 */
	packageId: string | null
	/**
	 * True when this viewer's fork is behind or diverged: the listing pin is
	 * not an ancestor of the fork tip.
	 */
	listingAhead: boolean
	/** Copyable agent prompt when `listingAhead` is true; otherwise null. */
	listingAheadPrompt: string | null
	/**
	 * True when SHAs differ and the listing pin is an ancestor of the fork
	 * tip (or ancestry is unproven). Human-only informational UI; omit from
	 * MCP / search payloads.
	 */
	forkAhead: boolean
	/** Listing files at the pinned commit when outdated or ahead. */
	listingDiffHref: string | null
}

/**
 * Public listing shape shared by server loaders/handlers and client routes.
 * Keep this module dependency-free so it can live in the universal layer.
 */
export type PublicCommunityListing = {
	id: string
	kodyId: string
	name: string
	description: string
	iconUrl: string
	tags: Array<string>
	category: CommunityListingCategory
	readmeContent: string | null
	license: string
	/**
	 * Author-supplied `package.json#version` when present on the pinned
	 * snapshot. Omitted or null when the author did not set a string.
	 */
	version?: string | null
	pinnedCommit: string
	/**
	 * Git default-branch name for public `/tree/:ref` URLs. Omitted on cached
	 * catalog rows; the listing overlay sets it from artifact head lookup
	 * (`main` when lookup misses). Not `master` unless that is the repo default.
	 */
	defaultBranch?: string
	/** Default-branch HEAD SHA when it differs from the package runtime pin. */
	headCommit?: string | null
	/**
	 * True when default-branch HEAD differs from the package runtime pin,
	 * not the community catalog snapshot (`pinnedCommit`). Runtime publish
	 * can advance the pin without a community republish.
	 */
	sourceAhead?: boolean
	/**
	 * Owner-only overlay: true when the catalog pin lags the package
	 * `published_commit`. Guests never see this field.
	 */
	listingBehind?: boolean
	publishedAt: string
	ownerUsername: string
	/** Always false. Trusted listings were removed. */
	trusted: boolean
	/** True when an admin featured this listing in onboarding. */
	featured: boolean
	averageStars: number | null
	ratingCount: number
	averageAdaptationEffort: number | null
	forkCount: number
	/**
	 * Set only for signed-in viewers after a per-request overlay. Public
	 * listing cache rows omit this field.
	 */
	viewerInstall?: ViewerListingInstall | null
}

export type ProfileVisibility = 'public' | 'private'

export type PublicCommunityProfile = {
	username: string
	displayName: string
	bio: string | null
	avatarUrl: string | null
	visibility: ProfileVisibility
	joinedAt: string
	publicPackageCount: number
	listingCount: number
}

export type PublicProfilePackageItem = {
	name: string
	kodyId: string
	description: string
	tags: Array<string>
	updatedAt: string
	createdAt: string
	communityListingId: string | null
	/** The listing's package name leaf, which can lag the package's until republish. */
	communityListingKodyId: string | null
	communityPublishedAt: string | null
	/**
	 * True when the listing pin is behind the package published commit.
	 * Owners use this for the "Needs republish" filter and date reminder.
	 */
	needsRepublish: boolean
	/**
	 * True when this repository has the saved-package extension. Distinct
	 * from `hasApp` (a package that also declares a package app).
	 */
	hasPackage: boolean
	/** True when the saved package declares a package app. */
	hasApp: boolean
	/** Inbound webhook endpoints declared on this saved package. */
	webhookCount: number
	/** Package-owned jobs whose `source_id` matches this saved package. */
	jobCount: number
	/** List/identity mark URL, or null when no published or listing commit exists. */
	iconUrl: string | null
	/** Present on the owner's own profile list; omitted for other viewers. */
	isPrivate?: boolean
	/** Present on the owner's own profile list; omitted for other viewers. */
	hidden?: boolean
	/**
	 * When false, the row name is not a link to the package page (viewer can
	 * see the package for invoke, but lacks `package:read` to open the page).
	 * Omitted or true means link as usual.
	 */
	canOpenDetail?: boolean
}

/** GET query contract for the `/@username` package list. */
export type ProfilePackageVisibilityFilter = 'all' | 'public' | 'private'
export type ProfilePackageListingFilter =
	| 'all'
	| 'published'
	| 'unpublished'
	| 'ahead'
export type ProfilePackageHiddenFilter = 'all' | 'yes' | 'no'
export type ProfilePackageAppFilter = 'all' | 'yes' | 'no'
/** Whether the repository has the saved-package extension. URL `package=`. */
export type ProfilePackagePresenceFilter = 'all' | 'yes' | 'no'
/**
 * Client-side list order. Default `updated` matches `ORDER BY updated_at DESC`.
 * `dir` defaults to `desc` for updated/created and `asc` for name.
 */
export type ProfilePackageSort = 'updated' | 'created' | 'name'
export type ProfilePackageSortDirection = 'asc' | 'desc'

export type ProfilePackageFilters = {
	query: string
	visibility: ProfilePackageVisibilityFilter
	listing: ProfilePackageListingFilter
	hidden: ProfilePackageHiddenFilter
	app: ProfilePackageAppFilter
	package: ProfilePackagePresenceFilter
	sort: ProfilePackageSort
	dir: ProfilePackageSortDirection
}

export type CommunityActivityEventType =
	| 'listing_published'
	| 'listing_updated'
	| 'listing_forked'

export type PublicCommunityActivityItem = {
	type: CommunityActivityEventType
	actorUsername: string
	actorDisplayName: string
	actorAvatarUrl: string | null
	listingId: string
	listingName: string
	listingKodyId: string
	createdAt: string
}

/**
 * Slim listing shape embedded in the onboarding payload for the starter
 * package step. Kept minimal (no README) so onboarding stays light.
 */
export type OnboardingFeaturedListing = {
	id: string
	kodyId: string
	name: string
	description: string
	iconUrl: string
	tags: Array<string>
	/** Set only for signed-in viewers who already forked or installed this listing. */
	viewerInstall?: ViewerListingInstall | null
}

/**
 * Live fork state for one listing and the signed-in viewer, read on mount,
 * focus, and return so the Fork button never offers a second fork while one
 * exists or is still being created.
 */
export type CommunityForkState =
	| { state: 'none' }
	| { state: 'in_progress'; startedAt: string }
	| {
			state: 'installed' | 'adaptation_required'
			targetName: string
			href: string
	  }
