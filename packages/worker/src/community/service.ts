import { optionalOrgAuditWriter } from '#worker/orgs/org-audit.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { invalidateCommunityPublicCache } from '#app/data-cache.ts'
import { viewerCanReadSavedPackage } from '#app/package-viewer-access.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { parseListingOwnerUsername } from '#universal/community-links.ts'
import { communityForkAdoptionReviewNoteMinLength } from '#universal/community-fork-adoption.ts'
import {
	communityIndexOverviewCandidateLimitPerCategory,
	communityIndexOverviewLimitPerCategory,
	communityListingCategories,
	resolveCommunityListingCategory,
	type CommunityCategoryCounts,
	type CommunityListingCategory,
} from '#universal/community-categories.ts'
import {
	defaultCommunityListingSort,
	type CommunityListingSort,
} from '#universal/community-search.ts'
import { tokenizeSearchText } from '#worker/vectorize/scoring.ts'
import { buildPackageReadmeDetail } from '#worker/package-registry/package-readme.ts'
import {
	getSavedPackageById,
	resolveSavedPackageRef,
	getSavedPackageByName,
	updateSavedPackage,
} from '#worker/package-registry/repo.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import {
	cleanupArtifactReposForPackage,
	deleteUserScopedArtifactRepo,
} from '#worker/repo/artifact-repo-cleanup.ts'
import {
	deleteEntitySource,
	getEntitySourceById,
} from '#worker/repo/entity-sources.ts'
import { readArtifactSourceSnapshot } from '#worker/repo/artifact-source-snapshot.ts'
import {
	buildEntityRepoId,
	resolveArtifactSourceHead,
} from '#worker/repo/artifacts.ts'
import {
	forkArtifactRepo,
	persistForkedArtifactRepoContents,
	resolveCommunityForkArtifactsGitFallbackTree,
	shouldFallbackFromArtifactFork,
	shouldFallbackFromForkedArtifactPersist,
} from '#worker/repo/artifact-repo-fork.ts'
import { readPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	ensureEntitySource,
	type EnsuredEntitySource,
} from '#worker/repo/source-service.ts'
import { syncArtifactSourceSnapshot } from '#worker/repo/source-sync.ts'
import { shouldStripIdentityIconFromCommunitySnapshot } from '#worker/repo/identity-icon-paths.ts'
import {
	pushServerTiming,
	type ServerTimingEntry,
} from '#worker/server-timing.ts'
import { KODY_DESCRIPTION_MAX_LENGTH } from '#worker/package-registry/types.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { normalizePackageNameInput } from '#worker/package-registry/package-name.ts'
import { getPackageScopeByUserId } from '#worker/package-registry/user-scope.ts'
import { ensureFollowForCommunityFork } from '#worker/follow/fork-follow.ts'
import { notifyFollowsOfPublishedPackage } from '#worker/follow/notify.ts'
import { enqueueCommunityActivityDispatch } from './activity-dispatch-queue-producer.ts'
import { assertNotCommunityBanned } from './assert-not-community-banned.ts'
import { CommunityActionError } from './errors.ts'
import { hasCommunityListingReleaseChanged } from './fork-upstream-updated-subscription-event.ts'
import { enqueueCommunityListingPublishedDispatch } from './listing-published-dispatch-queue-producer.ts'
import { type CommunityListingPublishedProjection } from './listing-published-subscription-event.ts'
import {
	deletePackageSlugRedirects,
	getCommunityPackageHref,
} from './package-url.ts'
import {
	countCommunityForksByListingIds,
	deleteCommunityForksByIds,
	deleteCommunityForksForPackage,
	deleteCommunityListing,
	deleteCommunityRatingsByListingId,
	getCommunityActivityByIdForAdmin,
	getCommunityForkByForkedPackageId,
	getCommunityForkByListingAndUser,
	getActiveCommunityListingWithPublisherUsername,
	getCommunityListingById,
	getCommunityListingsByIds as getCommunityListingsByIdsFromDb,
	getCommunityListingByOwnerAndKodyId,
	getCommunityListingByOwnerAndPackage,
	listCommunityForksByListingAndUser,
	listCommunityForksByUpstreamPackageAndUser,
	markCommunityForkAdopted,
	updateCommunityForkOriginCommit,
	listCommunityActivityPageRowsForAdmin,
	listCommunityActivityRowsForAdmin,
	getCommunityRatingAggregatesByListingId,
	getCommunityRatingAggregatesByListingIds,
	getCommunityReportById,
	insertCommunityFork,
	insertCommunityListing,
	listOrphanedCommunityForks,
	insertCommunityBan,
	insertCommunityReport,
	countActiveCommunityListingsByCategory,
	listCommunityIndexOverviewCandidates,
	listCommunityListingCandidates,
	listCommunityReports as listCommunityReportsFromDb,
	listFeaturedCommunityListings as listFeaturedCommunityListingsFromDb,
	repointOrphanedCommunityForksToListing,
	resolveCommunityReportRow,
	setCommunityListingFeaturedAt,
	setCommunityListingStatus,
	updateCommunityListing,
	upsertCommunityRating,
	deleteCommunityBan,
} from './repo.ts'
import {
	readPackageManifestVersion,
	resolveListingPackageVersion,
} from './package-version.ts'
import {
	deleteCommunityActivityEventsByListingId,
	insertCommunityActivityEvent,
} from './profile-repo.ts'
import { resolveCommunityForkAlternateLeaf } from './allocate-fork-leaf.ts'
import {
	collectChangedForkFiles,
	rewriteForkedPackageSelfReferences,
	rewritePackageManifestForFork,
	scanCrossScopeReferences,
} from './fork-scan.ts'
import { rethrowCommunityForkFailure } from './fork-resource-limit.ts'
import { withCommunityForkClaim } from './fork-claims.ts'
import {
	deleteCommunitySnapshot,
	readCommunitySnapshot,
	writeCommunitySnapshot,
} from './snapshot.ts'
import {
	communityIconPaths,
	deleteCommunityIconAssets,
	findCommunityIconPath,
} from './community-icon.ts'
import {
	type CommunityForkActor,
	type CommunityForkRecord,
	type CommunityListingRecord,
	type CommunityListingSearchResult,
	type CommunityListingWithAggregates,
	type CommunityActivityKind,
	type CommunityRatingRecord,
	type CommunityReportRecord,
	type CommunityReportResolutionAction,
	type CrossScopeReference,
	type ForkCommunityListingResult,
} from './types.ts'

const communityBayesianPriorMean = 3.25
const communityBayesianPriorWeight = 5
const communityActivityDefaultPageSize = 20
const communityActivityMaxPageSize = 100

// Community search ranks on query terms only. Listings have no semantic
// embedding, and the hash-based deterministic embedding is not semantic: it
// scored unrelated listings high enough that nonsense queries returned
// results. Exact term hits score 1; a term of at least
// `COMMUNITY_SEARCH_PARTIAL_TERM_MIN_LENGTH` characters inside a longer word
// (for example "slac" in "slack") scores 0.5. Relevance is the mean term score.
export const COMMUNITY_SEARCH_MIN_RELEVANCE = 0.2

export const COMMUNITY_SEARCH_PARTIAL_TERM_MIN_LENGTH = 3

// Community search/browse never scores more than this many listings in
// memory; candidates are pre-filtered (including stored category) and
// recency-ordered in SQL. Unfiltered All uses one windowed overview
// query (newest N per populated category) instead of this global
// window. Filtered browse ranks within the newest 500 of that
// category. Revisit with a materialized score column if a single
// category approaches this size.
export const COMMUNITY_SEARCH_CANDIDATE_LIMIT = 500

// The LIKE pre-filter is looser than the term scorer (a short term such as
// "go" matches inside "going"), so a full candidate page can be rejected
// entirely while an older listing holds the exact term. Search reads further
// prefiltered pages until it has enough matches (every page when a
// resultFilter applies), up to this many pages.
export const COMMUNITY_SEARCH_MAX_CANDIDATE_PAGES = 4

function normalizeCommunityActivityPage(value: number | undefined) {
	if (value === undefined || !Number.isFinite(value)) return 1
	return Math.max(1, Math.trunc(value))
}

function normalizeCommunityActivityPageSize(value: number | undefined) {
	if (value === undefined || !Number.isFinite(value)) {
		return communityActivityDefaultPageSize
	}
	return Math.min(communityActivityMaxPageSize, Math.max(1, Math.trunc(value)))
}

async function enqueueRecordedCommunityActivity(input: {
	env: Env
	kind: CommunityActivityKind
	activityId: string
}) {
	try {
		await enqueueCommunityActivityDispatch({
			queue: input.env.COMMUNITY_ACTIVITY_DISPATCH_QUEUE,
			kind: input.kind,
			activityId: input.activityId,
		})
	} catch (error) {
		console.error('community-activity-dispatch-enqueue-failed', error)
	}
}

async function enqueuePublishedCommunityListing(input: {
	env: Env
	listingId: string
}) {
	try {
		await enqueueCommunityListingPublishedDispatch({
			queue: input.env.COMMUNITY_LISTING_PUBLISHED_DISPATCH_QUEUE,
			listingId: input.listingId,
		})
	} catch (error) {
		console.error('community-listing-published-dispatch-enqueue-failed', error)
	}
}

async function deleteCommunityIconAssetsBestEffort(input: {
	env: Env
	listingId: string
	keepCommits?: ReadonlyArray<string>
	reason: 'republish' | 'unpublish' | 'hard-delete'
}) {
	try {
		await deleteCommunityIconAssets(input)
	} catch (error) {
		console.error(
			'community-icon-delete-failed',
			input.reason,
			input.listingId,
			error,
		)
	}
}

export function scoreCommunityListingSearch(input: {
	query: string
	document: string
}): number {
	const queryTerms = tokenizeSearchText(input.query)
	if (queryTerms.size === 0) return 0
	const documentTerms = tokenizeSearchText(input.document)
	let total = 0
	for (const term of queryTerms) {
		if (documentTerms.has(term)) {
			total += 1
			continue
		}
		if (term.length < COMMUNITY_SEARCH_PARTIAL_TERM_MIN_LENGTH) continue
		for (const documentTerm of documentTerms) {
			if (documentTerm.includes(term)) {
				total += 0.5
				break
			}
		}
	}
	return total / queryTerms.size
}

export function isCommunityListingSearchMatch(input: {
	query: string
	document: string
}): boolean {
	if (!input.query.trim()) return true
	return scoreCommunityListingSearch(input) >= COMMUNITY_SEARCH_MIN_RELEVANCE
}

export function buildCommunityListingSearchDocument(
	listing: CommunityListingRecord,
) {
	const readmeSnippet = listing.readmeContent
		? listing.readmeContent.slice(0, 1_000)
		: ''
	return [
		listing.name,
		listing.kodyId,
		listing.description,
		listing.tags.join(' '),
		listing.searchText ?? '',
		readmeSnippet,
	]
		.filter((value) => value.length > 0)
		.join('\n')
}

export function computeCommunityBayesianScore(input: {
	averageStars: number | null
	ratingCount: number
}): number {
	const averageStars = input.averageStars ?? communityBayesianPriorMean
	return (
		(communityBayesianPriorWeight * communityBayesianPriorMean +
			input.ratingCount * averageStars) /
		(communityBayesianPriorWeight + input.ratingCount)
	)
}

export function compareCommunityListingsByBayesianAndPublishedAt(
	left: CommunityListingWithAggregates,
	right: CommunityListingWithAggregates,
): number {
	const leftScore = computeCommunityBayesianScore({
		averageStars: left.averageStars,
		ratingCount: left.ratingCount,
	})
	const rightScore = computeCommunityBayesianScore({
		averageStars: right.averageStars,
		ratingCount: right.ratingCount,
	})
	if (rightScore !== leftScore) return rightScore - leftScore
	return right.publishedAt.localeCompare(left.publishedAt)
}

export function compareCommunityListingsForSort(
	left: CommunityListingWithAggregates,
	right: CommunityListingWithAggregates,
	sort: CommunityListingSort,
): number {
	switch (sort) {
		case 'newest':
			return right.publishedAt.localeCompare(left.publishedAt)
		case 'best':
			return compareCommunityListingsByBayesianAndPublishedAt(left, right)
		default: {
			const exhaustive: never = sort
			throw new Error(`Unhandled community listing sort: ${String(exhaustive)}`)
		}
	}
}

function resolveCommunityListingSort(sort: CommunityListingSort | undefined) {
	return sort ?? defaultCommunityListingSort
}

function buildRepeatForkErrorMessage(input: {
	targetKodyId: string
	forkedSourceId: string
	forkedPackageId: string
}) {
	return `You already forked this listing as package name "${input.targetKodyId}". Resume the existing fork with source_id "${input.forkedSourceId}" (package_id "${input.forkedPackageId}") via repoOpenSession, or pass a different package name leaf to fork again.`
}

async function cleanupFailedCommunityFork(input: {
	env: Env
	userId: OwnerId
	sourceId: string
	packageId: string
}) {
	const destDeleted = await deleteUserScopedArtifactRepo({
		env: input.env,
		userId: input.userId,
		repoName: buildEntityRepoId({
			entityKind: 'package',
			entityId: input.packageId,
		}),
	})
	if (!destDeleted) {
		console.warn(
			JSON.stringify({
				message: 'community fork dest artifact repo cleanup failed',
				userId: input.userId,
				packageId: input.packageId,
				sourceId: input.sourceId,
			}),
		)
	}
	await cleanupArtifactReposForPackage({
		env: input.env,
		userId: input.userId,
		sourceId: input.sourceId,
	}).catch((error) => {
		console.warn(
			JSON.stringify({
				message: 'community fork artifact repo cleanup failed',
				userId: input.userId,
				packageId: input.packageId,
				sourceId: input.sourceId,
				error: getErrorMessage(error),
			}),
		)
	})
	await deleteEntitySource(input.env, {
		id: input.sourceId,
		userId: input.userId,
	}).catch((error) => {
		console.warn(
			JSON.stringify({
				message: 'community fork entity source cleanup failed',
				userId: input.userId,
				packageId: input.packageId,
				sourceId: input.sourceId,
				error: getErrorMessage(error),
			}),
		)
	})
	await deleteCommunityForksForPackage(input.env.APP_DB, {
		userId: input.userId,
		packageId: input.packageId,
		sourceId: input.sourceId,
	}).catch((error) => {
		console.warn(
			JSON.stringify({
				message: 'community fork row cleanup failed',
				userId: input.userId,
				packageId: input.packageId,
				sourceId: input.sourceId,
				error: getErrorMessage(error),
			}),
		)
	})
	await deletePackageSlugRedirects({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: input.packageId,
	}).catch((error) => {
		console.warn(
			JSON.stringify({
				message: 'community fork slug redirect cleanup failed',
				userId: input.userId,
				packageId: input.packageId,
				sourceId: input.sourceId,
				error: getErrorMessage(error),
			}),
		)
	})
	invalidateCommunityPublicCache()
}

function buildListingSearchDocument(listing: CommunityListingRecord) {
	return buildCommunityListingSearchDocument(listing)
}

async function attachListingAggregates(
	db: D1Database,
	listing: CommunityListingRecord,
): Promise<CommunityListingWithAggregates> {
	const [ratingAggregate, forkCounts] = await Promise.all([
		getCommunityRatingAggregatesByListingId(db, listing.id),
		countCommunityForksByListingIds(db, [listing.id]),
	])
	return {
		...listing,
		averageStars: ratingAggregate.averageStars,
		ratingCount: ratingAggregate.ratingCount,
		averageAdaptationEffort: ratingAggregate.averageAdaptationEffort,
		forkCount: forkCounts[listing.id] ?? 0,
	}
}

export async function attachListingAggregatesBatch(
	db: D1Database,
	listings: Array<CommunityListingRecord>,
): Promise<Array<CommunityListingWithAggregates>> {
	if (listings.length === 0) return []
	const listingIds = listings.map((listing) => listing.id)
	const [ratingAggregates, forkCounts] = await Promise.all([
		getCommunityRatingAggregatesByListingIds(db, listingIds),
		countCommunityForksByListingIds(db, listingIds),
	])
	return listings.map((listing) => {
		const ratingAggregate = ratingAggregates[listing.id] ?? {
			listingId: listing.id,
			ratingCount: 0,
			averageStars: null,
			averageAdaptationEffort: null,
		}
		return {
			...listing,
			averageStars: ratingAggregate.averageStars,
			ratingCount: ratingAggregate.ratingCount,
			averageAdaptationEffort: ratingAggregate.averageAdaptationEffort,
			forkCount: forkCounts[listing.id] ?? 0,
		}
	})
}

/**
 * `(owner, kody.id)` is the canonical package URL, and a partial unique index
 * keeps at most one active listing per pair. The pair can still be contested:
 * deleting a package leaves its listing behind (the pinned snapshot outlives
 * the source), so a later package can be published under a reused `kody.id`.
 * The package that still exists takes the URL, and the stranded listing is
 * delisted -- the same rule migration 0009 applied to historical collisions.
 */
async function releaseContestedCommunityPackageUrl(input: {
	env: Env
	ownerUserId: string
	packageId: string
	kodyId: string
}): Promise<string | null> {
	const competing = await getCommunityListingByOwnerAndKodyId(
		input.env.APP_DB,
		{ ownerUserId: input.ownerUserId, kodyId: input.kodyId },
	)
	if (!competing || competing.packageId === input.packageId) return null

	const competingPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.ownerUserId,
		packageId: competing.packageId,
	})
	if (competingPackage) {
		// `saved_packages` is unique on `(user_id, kody_id)`, so two live packages
		// cannot claim one id. A live competitor means that listing's `kody_id`
		// has drifted from its package, and re-publishing it is the fix.
		throw new CommunityActionError(
			`Community URL "${input.kodyId}" is already used by package "${competingPackage.name}". Re-publish that package to move it to its current id.`,
		)
	}

	await updateCommunityListing(input.env.APP_DB, {
		listingId: competing.id,
		ownerUserId: input.ownerUserId,
		status: 'delisted',
	})
	invalidateCommunityPublicCache()
	return competing.id
}

/**
 * Give a released listing its page back when the publish that displaced it
 * fails. Nothing else can: publishing refuses to touch a delisted listing, and
 * the released one is stranded precisely because its package is gone.
 */
async function restoreReleasedCommunityPackageUrl(input: {
	env: Env
	ownerUserId: string
	listingId: string | null
}) {
	if (!input.listingId) return
	try {
		await updateCommunityListing(input.env.APP_DB, {
			listingId: input.listingId,
			ownerUserId: input.ownerUserId,
			status: 'active',
		})
		invalidateCommunityPublicCache()
	} catch (restoreError) {
		console.error(
			'Failed to restore released community listing after publish failure:',
			restoreError,
		)
	}
}

async function restoreCommunityListingAfterPublishFailure(input: {
	env: Env
	ownerUserId: string
	listingId: string
	existingListing: CommunityListingRecord | null
}) {
	try {
		if (input.existingListing) {
			await updateCommunityListing(input.env.APP_DB, {
				listingId: input.listingId,
				ownerUserId: input.ownerUserId,
				sourceId: input.existingListing.sourceId,
				kodyId: input.existingListing.kodyId,
				name: input.existingListing.name,
				description: input.existingListing.description,
				tagsJson: JSON.stringify(input.existingListing.tags),
				category: input.existingListing.category,
				searchText: input.existingListing.searchText,
				readmeContent: input.existingListing.readmeContent,
				license: input.existingListing.license,
				packageVersion: input.existingListing.version ?? null,
				pinnedCommit: input.existingListing.pinnedCommit,
				publishedAt: input.existingListing.publishedAt,
			})
		} else {
			await deleteCommunityListing(input.env.APP_DB, {
				listingId: input.listingId,
				ownerUserId: input.ownerUserId,
			})
		}
	} catch (revertError) {
		console.error(
			'Failed to revert community listing after publish failure:',
			revertError,
		)
	}
}

export async function publishCommunityListing(input: {
	env: Env
	baseUrl: string
	userId: OwnerId
	/**
	 * Acting person when the owner is an org. Community bans bind to the
	 * person acting, not just the owning org.
	 */
	actorUserId?: string
	packageId: string
}): Promise<CommunityListingRecord> {
	await assertNotCommunityBanned(input.env.APP_DB, input.userId)
	if (input.actorUserId && input.actorUserId !== input.userId) {
		await assertNotCommunityBanned(input.env.APP_DB, input.actorUserId)
	}

	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId: input.packageId,
	})
	if (!savedPackage) {
		// Missing / wrong-owner package_id is caller-clearable.
		// CommunityActionError keeps these on mcp-event lines and out of Sentry
		// (KODY-CLOUDFLARE-5B).
		throw new CommunityActionError(
			`Saved package "${input.packageId}" was not found in this org. Confirm package_id with search({ domain: "packages" }) and that this connection is bound to the org that owns it.`,
		)
	}

	const existingListing = await getCommunityListingByOwnerAndPackage(
		input.env.APP_DB,
		{
			ownerUserId: input.userId,
			packageId: input.packageId,
		},
	)
	if (existingListing?.status === 'delisted') {
		throw new CommunityActionError(
			`Catalog entry for package "${input.packageId}" was delisted by an admin and cannot be re-published.`,
		)
	}

	const loadedSource = await loadPackageSourceBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: savedPackage.sourceId,
	})
	const publishedCommit = loadedSource.source.published_commit
	if (!publishedCommit) {
		throw new CommunityActionError(
			`Saved package "${input.packageId}" does not have a published commit.`,
		)
	}

	const packageJsonContent = loadedSource.files['package.json']
	if (!packageJsonContent) {
		throw new CommunityActionError(
			'Saved packages require a root package.json file.',
		)
	}
	const description = loadedSource.manifest.kody.description
	if (description.length > KODY_DESCRIPTION_MAX_LENGTH) {
		throw new CommunityActionError(
			'kody.description must be at most 200 characters (short public tagline).',
		)
	}
	const license = existingListing?.license ?? ''
	const packageVersion = readPackageManifestVersion(packageJsonContent)
	const fullReadme = buildPackageReadmeDetail({
		files: loadedSource.files,
		maxChars: Number.MAX_SAFE_INTEGER,
	})

	const listingId = existingListing?.id ?? crypto.randomUUID()
	const releasedListingId = await releaseContestedCommunityPackageUrl({
		env: input.env,
		ownerUserId: input.userId,
		packageId: input.packageId,
		kodyId: savedPackage.kodyId,
	})

	const now = new Date().toISOString()
	const tagsJson = JSON.stringify(savedPackage.tags)
	const category = resolveCommunityListingCategory({
		category: loadedSource.manifest.kody.category,
		tags: savedPackage.tags,
	})
	const communityIconPath = findCommunityIconPath(loadedSource.files)
	const snapshotFiles = { ...loadedSource.files }
	for (const iconPath of communityIconPaths) {
		if (!shouldStripIdentityIconFromCommunitySnapshot(iconPath)) continue
		// Package source snapshots are text-backed. Keep the selected binary
		// list-mark path as metadata for public artifact reads, but do not put
		// corrupted UTF-8 raster bytes into community forks. Package-app
		// `icons/icon-192.png` stays so forks keep their PWA icon.
		delete snapshotFiles[iconPath]
	}
	const snapshot = {
		version: 1 as const,
		listingId,
		pinnedCommit: publishedCommit,
		files: snapshotFiles,
		communityIconPath,
		createdAt: now,
	}

	// A released listing is delisted before this one exists, so every failure
	// from here on has to hand its page back.
	try {
		if (existingListing) {
			const updated = await updateCommunityListing(input.env.APP_DB, {
				listingId,
				ownerUserId: input.userId,
				sourceId: savedPackage.sourceId,
				kodyId: savedPackage.kodyId,
				name: savedPackage.name,
				description,
				tagsJson,
				category,
				searchText: savedPackage.searchText,
				readmeContent: fullReadme?.content ?? '',
				license,
				packageVersion,
				pinnedCommit: publishedCommit,
				publishedAt: now,
				requireStatus: 'active',
			})
			if (!updated) {
				throw new CommunityActionError(
					`Catalog entry for package "${input.packageId}" was delisted by an admin and cannot be re-published.`,
				)
			}
		} else {
			await insertCommunityListing(input.env.APP_DB, {
				id: listingId,
				owner_user_id: input.userId,
				package_id: input.packageId,
				source_id: savedPackage.sourceId,
				kody_id: savedPackage.kodyId,
				name: savedPackage.name,
				description,
				tags_json: tagsJson,
				category,
				search_text: savedPackage.searchText,
				readme_content: fullReadme?.content ?? '',
				license,
				package_version: packageVersion,
				pinned_commit: publishedCommit,
				status: 'active',
				published_at: now,
			})
		}

		// Unpublish intentionally deletes the listing row while preserving fork
		// provenance. The surviving row does not retain owner/package ids, so the
		// narrowest historical lineage key available is an orphaned listing id plus
		// the exact scoped package name and kody.id captured at fork time.
		await repointOrphanedCommunityForksToListing(input.env.APP_DB, {
			listingId,
			listingName: savedPackage.name,
			listingKodyId: savedPackage.kodyId,
		})

		try {
			await writeCommunitySnapshot(input.env.BUNDLE_ARTIFACTS_KV, snapshot)
		} catch (snapshotError) {
			await restoreCommunityListingAfterPublishFailure({
				env: input.env,
				ownerUserId: input.userId,
				listingId,
				existingListing,
			})
			throw snapshotError
		}
	} catch (publishError) {
		await restoreReleasedCommunityPackageUrl({
			env: input.env,
			ownerUserId: input.userId,
			listingId: releasedListingId,
		})
		throw publishError
	}
	if (existingListing) {
		// Drop all cached icon revisions (including a reused commit id) so the
		// republished listing regenerates its icon lazily from fresh state.
		await deleteCommunityIconAssetsBestEffort({
			env: input.env,
			listingId,
			reason: 'republish',
		})
	}

	const listing = await getCommunityListingById(input.env.APP_DB, {
		listingId,
		includeDelisted: true,
	})
	if (!listing) {
		throw new Error(`Catalog entry "${listingId}" could not be loaded.`)
	}
	await updateSavedPackage(input.env.APP_DB, {
		userId: input.userId,
		packageId: input.packageId,
		isPrivate: false,
		audit: optionalOrgAuditWriter(input.env, {
			userId: input.actorUserId ?? input.userId,
		}),
	})
	try {
		await insertCommunityActivityEvent(input.env.APP_DB, {
			id: crypto.randomUUID(),
			actorUserId: input.actorUserId ?? input.userId,
			eventType: existingListing ? 'listing_updated' : 'listing_published',
			listingId,
		})
	} catch (activityError) {
		console.error(
			'Failed to record community activity event after publish:',
			activityError,
		)
	}
	if (!existingListing) {
		await enqueuePublishedCommunityListing({
			env: input.env,
			listingId,
		})
	} else {
		const previous = {
			pinnedCommit: existingListing.pinnedCommit,
			packageVersion: existingListing.version ?? null,
		}
		const current = { pinnedCommit: publishedCommit, packageVersion }
		if (hasCommunityListingReleaseChanged({ previous, current })) {
			try {
				await notifyFollowsOfPublishedPackage({
					env: input.env,
					ownerId: input.userId,
					packageId: input.packageId,
					previousCommit: previous.pinnedCommit,
					publishedCommit: current.pinnedCommit,
					publishedAt: now,
					listing: { listingId, previous, current },
				})
			} catch (error) {
				console.error('follow-published-notify-failed', listingId, error)
			}
		}
	}
	invalidateCommunityPublicCache()
	return listing
}

export async function unpublishCommunityListing(input: {
	env: Env
	userId: OwnerId
	/**
	 * Acting member when an org unpublishes. Community bans must bind to the
	 * person acting, not just the owning org.
	 */
	actorUserId?: string
	listingId: string
}): Promise<void> {
	if (input.actorUserId && input.actorUserId !== input.userId) {
		await assertNotCommunityBanned(input.env.APP_DB, input.actorUserId)
	}
	const listing = await getCommunityListingById(input.env.APP_DB, {
		listingId: input.listingId,
		includeDelisted: true,
	})
	if (!listing || listing.ownerUserId !== input.userId) {
		// Missing / not-owned ids are caller-clearable (stale listing_id, typo,
		// or another owner's listing). CommunityActionError keeps them on
		// mcp-event lines and out of Sentry (KODY-CLOUDFLARE-4N).
		throw new CommunityActionError(
			`Catalog entry "${input.listingId}" was not found.`,
		)
	}
	if (listing.status === 'delisted') {
		throw new CommunityActionError(
			'This listing was delisted by an administrator and cannot be unpublished.',
		)
	}

	const deleted = await deleteCommunityListing(input.env.APP_DB, {
		listingId: input.listingId,
		ownerUserId: input.userId,
	})
	if (!deleted) {
		throw new CommunityActionError(
			`Catalog entry "${input.listingId}" was not found.`,
		)
	}

	await deleteCommunityIconAssetsBestEffort({
		env: input.env,
		listingId: listing.id,
		reason: 'unpublish',
	})
	await deleteCommunityRatingsByListingId(input.env.APP_DB, input.listingId)
	await deleteCommunityActivityEventsByListingId(
		input.env.APP_DB,
		input.listingId,
	)
	await deleteCommunitySnapshot(input.env.BUNDLE_ARTIFACTS_KV, input.listingId)
	await updateSavedPackage(input.env.APP_DB, {
		userId: input.userId,
		packageId: listing.packageId,
		isPrivate: true,
		audit: optionalOrgAuditWriter(input.env, {
			userId: input.actorUserId ?? input.userId,
		}),
	})
	invalidateCommunityPublicCache()
}

/**
 * Admin curation: mark a listing as an onboarding starter package, or remove
 * the mark. Featured is editorial only — it is not a trust or safety badge.
 */
export async function setCommunityListingFeatured(input: {
	env: Env
	listingId: string
	featured: boolean
}): Promise<CommunityListingRecord> {
	const listing = await getCommunityListingById(input.env.APP_DB, {
		listingId: input.listingId,
		includeDelisted: true,
	})
	if (!listing) {
		throw new CommunityActionError(
			`Catalog entry "${input.listingId}" was not found.`,
		)
	}
	if (input.featured && listing.status !== 'active') {
		throw new CommunityActionError(
			'Delisted catalog entries cannot be featured.',
		)
	}
	await setCommunityListingFeaturedAt(input.env.APP_DB, {
		listingId: input.listingId,
		featured: input.featured,
	})
	invalidateCommunityPublicCache()
	const updated = await getCommunityListingById(input.env.APP_DB, {
		listingId: input.listingId,
		includeDelisted: true,
	})
	if (!updated) {
		throw new Error(`Catalog entry "${input.listingId}" could not be loaded.`)
	}
	return updated
}

/**
 * Onboarding starter packages: admin-featured listings with rating/fork
 * aggregates attached for public display.
 */
export async function listFeaturedCommunityListingsWithAggregates(input: {
	env: Env
	limit: number
}): Promise<Array<CommunityListingWithAggregates>> {
	const listings = await listFeaturedCommunityListingsFromDb(input.env.APP_DB, {
		limit: input.limit,
	})
	return await attachListingAggregatesBatch(input.env.APP_DB, listings)
}

export async function getCommunityListingWithAggregates(input: {
	env: Env
	listingId: string
	includeDelisted: boolean
}): Promise<CommunityListingWithAggregates | null> {
	const listing = await getCommunityListingById(input.env.APP_DB, {
		listingId: input.listingId,
		includeDelisted: input.includeDelisted,
	})
	if (!listing) return null
	return await attachListingAggregates(
		input.env.APP_DB,
		await withSnapshotPackageVersion(input.env, listing),
	)
}

async function withSnapshotPackageVersion(
	env: Env,
	listing: CommunityListingRecord,
): Promise<CommunityListingRecord> {
	if (listing.version || !env.BUNDLE_ARTIFACTS_KV) return listing
	try {
		const snapshot = await readCommunitySnapshot(
			env.BUNDLE_ARTIFACTS_KV,
			listing.id,
		)
		const version = resolveListingPackageVersion({
			stored: listing.version,
			packageJson: snapshot?.files['package.json'],
		})
		return version ? { ...listing, version } : listing
	} catch (error) {
		console.error(
			'Failed to read community snapshot for listing package version:',
			error,
		)
		return listing
	}
}

/**
 * Public listing cards for a fixed id set (onboarding chooser). One listing
 * `IN (...)` plus the two aggregate batch queries, then ordered by `ids`.
 */
export async function getCommunityListingsByIds(
	db: D1Database,
	ids: Array<string>,
	options: { includeDelisted: boolean },
): Promise<Array<CommunityListingWithAggregates>> {
	const listings = await getCommunityListingsByIdsFromDb(db, {
		listingIds: ids,
		includeDelisted: options.includeDelisted,
	})
	return await attachListingAggregatesBatch(db, listings)
}

export async function listCommunityListingsWithAggregates(input: {
	env: Env
	includeDelisted: boolean
	limit: number
	offset: number
	sort?: CommunityListingSort
	category?: CommunityListingCategory | null
}): Promise<Array<CommunityListingWithAggregates>> {
	const listings = await listCommunityListingCandidates(input.env.APP_DB, {
		includeDelisted: input.includeDelisted,
		limit: COMMUNITY_SEARCH_CANDIDATE_LIMIT,
		category: input.category ?? null,
	})
	const withAggregates = await attachListingAggregatesBatch(
		input.env.APP_DB,
		listings,
	)
	const sort = resolveCommunityListingSort(input.sort)
	const filtered = filterCommunityListingsByCategory(
		withAggregates,
		input.category,
	)
	return filtered
		.sort((left, right) => compareCommunityListingsForSort(left, right, sort))
		.slice(input.offset, input.offset + input.limit)
}

export async function getCommunityCategoryCounts(input: {
	env: Env
}): Promise<CommunityCategoryCounts> {
	return countActiveCommunityListingsByCategory(input.env.APP_DB)
}

export type CommunityIndexOverviewGroup = {
	category: CommunityListingCategory
	listings: Array<CommunityListingWithAggregates>
	total: number
}

/**
 * Unfiltered `/community` shelf: a few cards per populated category, with
 * SQL totals so "See all" and chips stay honest past the global candidate
 * window. Empty categories are omitted so a zero catalog stays quiet.
 */
export async function listCommunityIndexOverview(input: {
	env: Env
	sort?: CommunityListingSort
}): Promise<{
	listings: Array<CommunityListingWithAggregates>
	groups: Array<CommunityIndexOverviewGroup>
	categoryCounts: CommunityCategoryCounts
}> {
	const sort = resolveCommunityListingSort(input.sort)
	const categoryCounts = await getCommunityCategoryCounts({ env: input.env })
	const populated = communityListingCategories.filter(
		(category) => categoryCounts[category] > 0,
	)
	if (populated.length === 0) {
		return {
			listings: [],
			groups: [],
			categoryCounts,
		}
	}
	const rows = await listCommunityIndexOverviewCandidates(input.env.APP_DB, {
		limitPerCategory: communityIndexOverviewCandidateLimitPerCategory,
		categories: populated,
	})
	const withAggregates = await attachListingAggregatesBatch(
		input.env.APP_DB,
		rows,
	)
	const byCategory = new Map<
		CommunityListingCategory,
		Array<CommunityListingWithAggregates>
	>()
	for (const listing of withAggregates) {
		const group = byCategory.get(listing.category) ?? []
		group.push(listing)
		byCategory.set(listing.category, group)
	}
	const groups = populated.map((category) => {
		const candidates = byCategory.get(category) ?? []
		const visible = candidates
			.sort((left, right) => compareCommunityListingsForSort(left, right, sort))
			.slice(0, communityIndexOverviewLimitPerCategory)
		return {
			category,
			listings: visible,
			total: categoryCounts[category],
		}
	})
	return {
		listings: groups.flatMap((group) => group.listings),
		groups,
		categoryCounts,
	}
}

export async function searchCommunityListings(input: {
	env: Env
	query: string
	limit: number
	sort?: CommunityListingSort
	category?: CommunityListingCategory | null
	resultFilter?: (listing: CommunityListingWithAggregates) => boolean
}): Promise<Array<CommunityListingSearchResult>> {
	const trimmedQuery = input.query.trim()
	const sort = resolveCommunityListingSort(input.sort)
	const readCandidates = (page: number) =>
		listCommunityListingCandidates(input.env.APP_DB, {
			includeDelisted: false,
			limit: COMMUNITY_SEARCH_CANDIDATE_LIMIT,
			offset: page * COMMUNITY_SEARCH_CANDIDATE_LIMIT,
			query: trimmedQuery || null,
			category: input.category ?? null,
		})
	const listings = await readCandidates(0)
	if (!trimmedQuery) {
		const withAggregates = await attachListingAggregatesBatch(
			input.env.APP_DB,
			listings,
		)
		const relevanceOrdered = withAggregates.sort((left, right) =>
			compareCommunityListingsForSort(left, right, sort),
		)
		return finalizeCommunitySearchResults(
			relevanceOrdered.map((listing) => ({ ...listing, relevance: null })),
			input,
		)
	}
	// The SQL LIKE pre-filter keeps every listing that contains a query term
	// as a substring, a superset of what the term scorer accepts, so a miss
	// across the prefiltered pages is a real no-results answer. No unfiltered
	// fallback read.
	const scoreListings = (page: Array<CommunityListingRecord>) =>
		page
			.map((listing) => ({
				listing,
				relevance: scoreCommunityListingSearch({
					query: trimmedQuery,
					document: buildListingSearchDocument(listing),
				}),
			}))
			.filter((entry) => entry.relevance >= COMMUNITY_SEARCH_MIN_RELEVANCE)
	const scoredMatches = scoreListings(listings)
	let lastPage = listings
	for (
		let page = 1;
		page < COMMUNITY_SEARCH_MAX_CANDIDATE_PAGES &&
		lastPage.length >= COMMUNITY_SEARCH_CANDIDATE_LIMIT &&
		// resultFilter runs after scoring, so scored matches do not prove
		// enough eligible results; read through the page cap instead.
		(input.resultFilter != null || scoredMatches.length < input.limit);
		page += 1
	) {
		lastPage = await readCandidates(page)
		scoredMatches.push(...scoreListings(lastPage))
	}
	const relevanceById = new Map(
		scoredMatches.map((entry) => [entry.listing.id, entry.relevance]),
	)
	const withAggregates = await attachListingAggregatesBatch(
		input.env.APP_DB,
		scoredMatches.map((entry) => entry.listing),
	)
	const scored = withAggregates.map((listing) => {
		const relevance = relevanceById.get(listing.id) ?? 0
		const bayesian = computeCommunityBayesianScore({
			averageStars: listing.averageStars,
			ratingCount: listing.ratingCount,
		})
		return {
			listing: { ...listing, relevance },
			rankScore: relevance * bayesian,
		}
	})

	const relevanceOrdered = scored
		.sort((left, right) => {
			switch (sort) {
				case 'newest':
					return right.listing.publishedAt.localeCompare(
						left.listing.publishedAt,
					)
				case 'best':
					return right.rankScore - left.rankScore
				default: {
					const exhaustive: never = sort
					throw new Error(
						`Unhandled community listing sort: ${String(exhaustive)}`,
					)
				}
			}
		})
		.map((entry) => entry.listing)
	return finalizeCommunitySearchResults(relevanceOrdered, input)
}

function filterCommunityListingsByCategory<
	T extends { category: CommunityListingCategory },
>(listings: Array<T>, category?: CommunityListingCategory | null): Array<T> {
	if (category == null) return listings
	return listings.filter((listing) => listing.category === category)
}

function finalizeCommunitySearchResults(
	relevanceOrdered: Array<CommunityListingSearchResult>,
	input: {
		limit: number
		category?: CommunityListingCategory | null
		resultFilter?: (listing: CommunityListingWithAggregates) => boolean
	},
): Array<CommunityListingSearchResult> {
	const categoryFiltered = filterCommunityListingsByCategory(
		relevanceOrdered,
		input.category,
	)
	const filtered = input.resultFilter
		? categoryFiltered.filter(input.resultFilter)
		: categoryFiltered
	return filtered.slice(0, input.limit)
}

export async function listCommunityActivityForAdmin(input: {
	db: D1Database
	page?: number
	pageSize?: number
	kind?: CommunityActivityKind
	listingId?: string
}) {
	let page = normalizeCommunityActivityPage(input.page)
	const pageSize = normalizeCommunityActivityPageSize(input.pageSize)
	const query = {
		page,
		pageSize,
		kind: input.kind,
		listingId: input.listingId,
	}
	const result = await listCommunityActivityRowsForAdmin(input.db, query)
	const lastPage = Math.ceil(result.total / pageSize)
	if (result.total > 0 && page > lastPage) {
		page = lastPage
		result.items = await listCommunityActivityPageRowsForAdmin(input.db, {
			...query,
			page,
		})
	}
	return {
		...result,
		page,
		pageSize,
	}
}

export async function getCommunityActivityForAdmin(input: {
	db: D1Database
	kind: CommunityActivityKind
	activityId: string
}) {
	const activity = await getCommunityActivityByIdForAdmin(input.db, input)
	return activity
}

export async function getCommunityListingPublishedForAdmin(input: {
	db: D1Database
	baseUrl: string
	listingId: string
}): Promise<CommunityListingPublishedProjection | null> {
	const loaded = await getActiveCommunityListingWithPublisherUsername(
		input.db,
		{ listingId: input.listingId },
	)
	if (!loaded) return null
	const publisherUsername =
		loaded.publisherUsername ?? parseListingOwnerUsername(loaded.listing.name)
	const kodyId = loaded.listing.kodyId
	if (!publisherUsername || !kodyId) {
		// Never fall back to `/community/{listing_id}` for subscription payloads.
		return null
	}
	const description = loaded.listing.description.trim()
	return {
		id: loaded.listing.id,
		name: loaded.listing.name,
		kodyId,
		description: description.length > 0 ? description : null,
		publisherUsername,
		publishedAt: loaded.listing.publishedAt,
		publicUrl: `${input.baseUrl}${getCommunityPackageHref({
			username: publisherUsername,
			kodyId,
		})}`,
	}
}

export type PrepareCommunityForkInput = {
	env: Env
	baseUrl: string
	userId: OwnerId
	expectedPackageScope: string
	listingId: string
	kodyId?: string
	/**
	 * When set, the fork is rejected unless the snapshot still pins this
	 * commit. One-click install passes the commit the user saw (and
	 * acknowledged), so an owner republish between the confirmation and the
	 * fork cannot swap in unreviewed content.
	 */
	expectedPinnedCommit?: string
	/**
	 * Who is forking. One-click install in the web app is `human`; the
	 * `communityFork` capability is `agent`. Recorded so activation metrics
	 * can separate what a user chose from what their agent did on its own.
	 */
	actor?: CommunityForkActor | null
	/**
	 * Org that owns the follow. Web install passes the personal org. An
	 * org-scoped `communityFork` passes the active org. Omit to use `userId`
	 * (person-keyed fixtures and legacy equal-id rows).
	 */
	followerOrgId?: OwnerId
	/** Acting person. Omit to use `userId` when that value is already the person. */
	creatorUserId?: string
}

export type PreparedCommunityFork = {
	env: Env
	baseUrl: string
	userId: OwnerId
	followerOrgId: OwnerId
	creatorUserId: string
	/** Null when forking a private package (see `upstreamPackageId`). */
	listingId: string | null
	/** Org that owns the forked private package; null for listing forks. */
	upstreamOwnerId: OwnerId | null
	/** Forked private package; null for listing forks. */
	upstreamPackageId: string | null
	/** `community_fork_claims` key: the listing id or `package:<id>`. */
	claimKey: string
	/** Origin package name (`@owner/leaf`) at fork time. */
	listingName: string
	listingKodyId: string
	originCommit: string
	actor: CommunityForkActor | null
	packageId: string
	targetKodyId: string
	targetName: string
	expectedPackageScope: string
	originRepoId: string | null
	files: Record<string, string>
	changedFiles: Record<string, string>
	crossScopeReferences: Array<CrossScopeReference>
}

function logCommunityPhaseTiming(input: {
	phase: string
	durationMs: number
	listingId?: string
	packageId?: string
	filesCount?: number
}) {
	console.info(
		JSON.stringify({
			message: 'community-phase-timing',
			...input,
		}),
	)
}

/**
 * Rewrite the listing snapshot and run collision checks without touching
 * Artifacts. One-click install overlaps the subsequent git bootstrap with
 * publish checks against these in-memory files.
 */
export async function prepareCommunityFork(
	input: PrepareCommunityForkInput,
): Promise<PreparedCommunityFork> {
	// Ban check, listing row, and pinned KV snapshot are independent reads —
	// overlapping them shaves fork preflight latency before the Artifacts
	// bootstrap (the dominant cost) begins.
	const [, , listing, snapshot] = await Promise.all([
		assertNotCommunityBanned(input.env.APP_DB, input.userId),
		// Bans bind to the acting person, not just the owning org.
		input.creatorUserId && input.creatorUserId !== input.userId
			? assertNotCommunityBanned(input.env.APP_DB, input.creatorUserId)
			: undefined,
		getCommunityListingById(input.env.APP_DB, {
			listingId: input.listingId,
			includeDelisted: false,
		}),
		readCommunitySnapshot(input.env.BUNDLE_ARTIFACTS_KV, input.listingId),
	])
	if (!listing) {
		throw new CommunityActionError(
			`Catalog entry "${input.listingId}" was not found.`,
		)
	}
	const source = await getEntitySourceById(input.env.APP_DB, listing.sourceId)
	let originCommit = listing.pinnedCommit
	if (source) {
		try {
			const head = await resolveArtifactSourceHead(input.env, source.repo_id)
			if (head.commit) originCommit = head.commit
		} catch {
			originCommit = source.published_commit || listing.pinnedCommit
		}
	}
	let files = snapshot?.files ?? null
	let filesCommit = listing.pinnedCommit
	if (source && originCommit) {
		try {
			const published = await readPublishedSourceSnapshot({
				env: input.env,
				sourceId: listing.sourceId,
				publishedCommit: originCommit,
			})
			if (published?.files) {
				files = published.files
				filesCommit = originCommit
			}
		} catch {
			// Fall through to git snapshot / listing pin.
		}
		if (files === snapshot?.files || files == null) {
			try {
				const treeSnapshot = await readArtifactSourceSnapshot({
					env: input.env,
					repoId: source.repo_id,
					commit: originCommit,
				})
				if (treeSnapshot?.files) {
					files = treeSnapshot.files
					filesCommit = originCommit
				}
			} catch {
				// Fall through to listing pin snapshot.
			}
		}
	}
	if (!files) {
		throw new Error(
			`Catalog entry snapshot for "${input.listingId}" was not found.`,
		)
	}
	originCommit = filesCommit
	if (
		input.expectedPinnedCommit &&
		originCommit !== input.expectedPinnedCommit
	) {
		throw new CommunityActionError(
			'This listing changed after you confirmed the install. Review the updated listing and try again.',
		)
	}

	return await prepareForkFromOriginFiles({
		input,
		files,
		originCommit,
		originName: listing.name,
		originKodyId: listing.kodyId,
		originRepoId: source?.repo_id ?? null,
		lineage: {
			listingId: input.listingId,
			upstreamOwnerId: null,
			upstreamPackageId: null,
			claimKey: input.listingId,
		},
		subject: 'listing',
		listExistingForks: () =>
			listCommunityForksByListingAndUser(input.env.APP_DB, {
				listingId: input.listingId,
				userId: input.userId,
			}),
	})
}

type ForkLineage = Pick<
	PreparedCommunityFork,
	'listingId' | 'upstreamOwnerId' | 'upstreamPackageId' | 'claimKey'
>

type ForkSubject = 'listing' | 'package'

/**
 * Shared second half of preparing a fork: pick the target leaf, rewrite the
 * manifest and self-references, and scan cross-scope imports. Listing and
 * private package forks differ only in where `files` came from.
 */
async function prepareForkFromOriginFiles(args: {
	input: Omit<PrepareCommunityForkInput, 'listingId' | 'expectedPinnedCommit'>
	files: Record<string, string>
	originCommit: string
	originName: string
	originKodyId: string
	originRepoId: string | null
	lineage: ForkLineage
	subject: ForkSubject
	listExistingForks: () => Promise<Array<CommunityForkRecord>>
}): Promise<PreparedCommunityFork> {
	const { input, files, originCommit, subject } = args
	const packageJsonContent = files['package.json']
	if (!packageJsonContent) {
		throw new Error(
			subject === 'listing'
				? 'Catalog entry snapshot is missing package.json.'
				: 'This package has no package.json on its default branch.',
		)
	}

	const explicitKodyId = input.kodyId?.trim() || undefined
	const preferredKodyId = explicitKodyId || args.originKodyId
	const packageScope = input.expectedPackageScope.replace(/^@/, '')
	const scopedName = (leaf: string) => `@${packageScope}/${leaf}`
	const [existingByKody, existingByName, existingForks] = await Promise.all([
		resolveSavedPackageRef(input.env.APP_DB, {
			userId: input.userId,
			ref: preferredKodyId,
			match: 'slug',
		}),
		getSavedPackageByName(input.env.APP_DB, {
			userId: input.userId,
			name: scopedName(preferredKodyId),
		}),
		args.listExistingForks(),
	])
	const collidingFork = existingForks.find(
		(fork) => fork.targetKodyId === preferredKodyId,
	)
	let targetKodyId = preferredKodyId
	if (existingByKody || existingByName) {
		// A fork row for this listing at the preferred leaf is a repeat fork
		// (Installed / adaptation_required). An unrelated same-leaf package —
		// no fork linkage — used to make one-click Install/Fork fail on the
		// default leaf. Auto-pick the next free leaf only for that default
		// path; an explicit leaf still errors so callers keep control.
		if (!explicitKodyId && !collidingFork) {
			// Already forked this listing under another leaf (for example the
			// previous default auto-picked leaf-2). Do not silently mint leaf-3;
			// resume the existing fork or pass an explicit different leaf.
			const existingAlternateFork =
				existingForks.length > 0
					? existingForks[existingForks.length - 1]
					: null
			if (existingAlternateFork) {
				throw new CommunityActionError(
					buildRepeatForkErrorMessage({
						targetKodyId: existingAlternateFork.targetKodyId,
						forkedSourceId: existingAlternateFork.forkedSourceId,
						forkedPackageId: existingAlternateFork.forkedPackageId,
					}),
				)
			}
			const alternate = await resolveCommunityForkAlternateLeaf({
				preferredLeaf: preferredKodyId,
				reservedLeaves: new Set(existingForks.map((fork) => fork.targetKodyId)),
				isLeafTaken: async (leaf) => {
					const [byKody, byName] = await Promise.all([
						resolveSavedPackageRef(input.env.APP_DB, {
							userId: input.userId,
							ref: leaf,
							match: 'slug',
						}),
						getSavedPackageByName(input.env.APP_DB, {
							userId: input.userId,
							name: scopedName(leaf),
						}),
					])
					return Boolean(byKody || byName)
				},
			})
			if (!alternate) {
				throw new CommunityActionError(
					`You already have a saved package named "${preferredKodyId}". Pass a different package name leaf to fork this ${subject}.`,
				)
			}
			targetKodyId = alternate
		} else {
			throw new CommunityActionError(
				`You already have a saved package named "${preferredKodyId}". Pass a different package name leaf to fork this ${subject}.`,
			)
		}
	} else if (collidingFork) {
		throw new CommunityActionError(
			buildRepeatForkErrorMessage({
				targetKodyId: preferredKodyId,
				forkedSourceId: collidingFork.forkedSourceId,
				forkedPackageId: collidingFork.forkedPackageId,
			}),
		)
	}

	let rewrittenManifest: ReturnType<typeof rewritePackageManifestForFork>
	try {
		rewrittenManifest = rewritePackageManifestForFork({
			manifestContent: packageJsonContent,
			expectedPackageScope: input.expectedPackageScope,
			targetKodyId,
		})
		// Validate the rewritten snapshot before Artifacts bootstrap. Stale
		// listing pins (e.g. pre-map kody.dependencies) are owner-fixable via
		// communityPublish — keep them on mcp-event, not Sentry.
		parseAuthoredPackageJson({
			content: rewrittenManifest.content,
			manifestPath: 'package.json',
			expectedPackageScope: input.expectedPackageScope,
		})
	} catch (error) {
		throw new CommunityActionError(getErrorMessage(error))
	}

	const collidingForkAtTarget = existingForks.find(
		(fork) => fork.targetKodyId === targetKodyId,
	)
	if (collidingForkAtTarget) {
		throw new CommunityActionError(
			buildRepeatForkErrorMessage({
				targetKodyId,
				forkedSourceId: collidingForkAtTarget.forkedSourceId,
				forkedPackageId: collidingForkAtTarget.forkedPackageId,
			}),
		)
	}

	const originFiles = {
		...files,
		'package.json': packageJsonContent,
	}
	const rewrittenFiles = rewriteForkedPackageSelfReferences({
		files: {
			...originFiles,
			'package.json': rewrittenManifest.content,
		},
		originPackageName: args.originName,
		nextPackageName: rewrittenManifest.targetName,
	})
	const crossScopeReferences = scanCrossScopeReferences({
		files: rewrittenFiles,
		expectedPackageScope: input.expectedPackageScope,
	})

	return {
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		followerOrgId: input.followerOrgId ?? input.userId,
		creatorUserId: input.creatorUserId ?? input.userId,
		...args.lineage,
		listingName: args.originName,
		listingKodyId: args.originKodyId,
		originCommit,
		actor: input.actor ?? null,
		packageId: crypto.randomUUID(),
		targetKodyId,
		targetName: rewrittenManifest.targetName,
		expectedPackageScope: input.expectedPackageScope,
		originRepoId: args.originRepoId,
		files: rewrittenFiles,
		changedFiles: collectChangedForkFiles({
			originFiles,
			rewrittenFiles,
		}),
		crossScopeReferences,
	}
}

/**
 * Create the Artifacts repo, copy the origin tree at the storage layer when
 * possible, apply only rewritten files, and insert the inert
 * `community_forks` row. Callers that already hold a prepared fork
 * (one-click install) can overlap this with `runRepoChecks`.
 */
export async function persistPreparedCommunityFork(
	prepared: PreparedCommunityFork,
	options?: {
		serverTiming?: Array<ServerTimingEntry>
		/** Live fork-claim id; fences the community_forks insert on takeover. */
		claimId?: string | null
	},
): Promise<ForkCommunityListingResult> {
	const persistStartedAt = Date.now()
	const serverTiming = options?.serverTiming
	const claimId = options?.claimId?.trim() || null
	const destRepoId = buildEntityRepoId({
		entityKind: 'package',
		entityId: prepared.packageId,
	})
	let copiedAtStorageLayer = false
	const originRepoId = prepared.originRepoId
	if (originRepoId) {
		try {
			await pushServerTiming(serverTiming, 'artifacts-fork', () =>
				forkArtifactRepo({
					env: prepared.env,
					sourceRepoId: originRepoId,
					targetRepoId: destRepoId,
				}),
			)
			copiedAtStorageLayer = true
		} catch (error) {
			if (!shouldFallbackFromArtifactFork(error)) {
				rethrowCommunityForkFailure(error)
			}
		}
	}
	let ensuredSource: EnsuredEntitySource
	try {
		ensuredSource = await ensureEntitySource({
			db: prepared.env.APP_DB,
			env: prepared.env,
			userId: prepared.userId,
			entityKind: 'package',
			entityId: prepared.packageId,
			requirePersistence: true,
			serverTiming,
		})
	} catch (error) {
		if (copiedAtStorageLayer) {
			await deleteUserScopedArtifactRepo({
				env: prepared.env,
				userId: prepared.userId,
				repoName: destRepoId,
			})
		}
		rethrowCommunityForkFailure(error)
	}
	try {
		let originCommit = prepared.originCommit
		let syncedFiles = prepared.files
		if (copiedAtStorageLayer) {
			try {
				const persisted = await persistForkedArtifactRepoContents({
					env: prepared.env,
					baseUrl: prepared.baseUrl,
					userId: prepared.userId,
					source: ensuredSource,
					originCommit: prepared.originCommit,
					expectedPackageScope: prepared.expectedPackageScope,
					targetKodyId: prepared.targetKodyId,
					changedFiles: prepared.changedFiles,
					files: prepared.files,
					bootstrapAccess: ensuredSource.bootstrapAccess ?? null,
					serverTiming,
				})
				originCommit = persisted.copiedOriginCommit
			} catch (error) {
				// Storage-layer fork can leave a dest whose git clone fails with
				// persistent Artifacts HTTP 5xx / corrupt pack even when origin
				// is healthy. Fall back to writing a full tree into a fresh empty
				// repo. Prefer dest HEAD from origin when preparation still holds
				// an older listing-pin snapshot.
				if (!shouldFallbackFromForkedArtifactPersist(error)) {
					throw error
				}
				const fallbackTree = await resolveCommunityForkArtifactsGitFallbackTree(
					{
						env: prepared.env,
						destRepoId,
						originRepoId: prepared.originRepoId,
						preparedOriginCommit: prepared.originCommit,
						preparedFiles: prepared.files,
						expectedPackageScope: prepared.expectedPackageScope,
						targetKodyId: prepared.targetKodyId,
						listingName: prepared.listingName,
						targetName: prepared.targetName,
					},
				)
				if (!fallbackTree) {
					throw error
				}
				const destDeleted = await deleteUserScopedArtifactRepo({
					env: prepared.env,
					userId: prepared.userId,
					repoName: destRepoId,
					waitUntilAbsent: true,
				})
				if (!destDeleted) {
					throw error
				}
				console.info(
					JSON.stringify({
						message: 'community-fork-artifacts-git-fallback',
						listingId: prepared.listingId,
						packageId: prepared.packageId,
						sourceId: ensuredSource.id,
						originCommit: fallbackTree.originCommit,
						preparedOriginCommit: prepared.originCommit,
						error: getErrorMessage(error),
					}),
				)
				copiedAtStorageLayer = false
				ensuredSource = await ensureEntitySource({
					db: prepared.env.APP_DB,
					env: prepared.env,
					userId: prepared.userId,
					entityKind: 'package',
					entityId: prepared.packageId,
					requirePersistence: true,
					serverTiming,
				})
				if (!ensuredSource.bootstrapAccess) {
					throw error
				}
				originCommit = fallbackTree.originCommit
				syncedFiles = fallbackTree.files
				const snapshotCommit = await syncArtifactSourceSnapshot({
					env: prepared.env,
					baseUrl: prepared.baseUrl,
					userId: prepared.userId,
					sourceId: ensuredSource.id,
					files: syncedFiles,
					bootstrapAccess: ensuredSource.bootstrapAccess,
					serverTiming,
					runPublishChecks: false,
				})
				if (snapshotCommit == null) {
					throw error
				}
			}
		} else {
			await syncArtifactSourceSnapshot({
				env: prepared.env,
				baseUrl: prepared.baseUrl,
				userId: prepared.userId,
				sourceId: ensuredSource.id,
				files: prepared.files,
				bootstrapAccess: ensuredSource.bootstrapAccess ?? null,
				serverTiming,
				// Persist an inert fork even when checks would fail; installer's
				// parallel runRepoChecks chooses live vs adaptation_required.
				runPublishChecks: false,
			})
		}

		const forkId = crypto.randomUUID()
		await pushServerTiming(serverTiming, 'fork-row', async () => {
			await insertCommunityFork(prepared.env.APP_DB, {
				id: forkId,
				listing_id: prepared.listingId,
				upstream_owner_id: prepared.upstreamOwnerId,
				upstream_package_id: prepared.upstreamPackageId,
				claim_key: prepared.claimKey,
				forker_user_id: prepared.userId,
				origin_commit: originCommit,
				forked_package_id: prepared.packageId,
				forked_source_id: ensuredSource.id,
				target_kody_id: prepared.targetKodyId,
				listing_name: prepared.listingName,
				listing_kody_id: prepared.listingKodyId,
				actor: prepared.actor,
				...(claimId ? { claim_id: claimId } : {}),
			})
			// Private package forks are not community activity and have no
			// listing to follow.
			if (!prepared.listingId) return
			await ensureFollowForCommunityFork({
				env: prepared.env,
				listingId: prepared.listingId,
				followerOrgId: prepared.followerOrgId,
				creatorUserId: prepared.creatorUserId,
			})
			await enqueueRecordedCommunityActivity({
				env: prepared.env,
				kind: 'fork',
				activityId: forkId,
			})
		})

		if (prepared.listingId) invalidateCommunityPublicCache()
		logCommunityPhaseTiming({
			phase: 'fork-persist',
			durationMs: Date.now() - persistStartedAt,
			listingId: prepared.listingId ?? undefined,
			packageId: prepared.packageId,
			filesCount: Object.keys(syncedFiles).length,
		})

		return {
			forkId,
			packageId: prepared.packageId,
			sourceId: ensuredSource.id,
			targetKodyId: prepared.targetKodyId,
			targetName: prepared.targetName,
			originCommit,
			crossScopeReferences: prepared.crossScopeReferences,
			filesCount: Object.keys(syncedFiles).length,
			files: syncedFiles,
			...(serverTiming && serverTiming.length > 0 ? { serverTiming } : {}),
		}
	} catch (error) {
		await cleanupFailedCommunityFork({
			env: prepared.env,
			userId: prepared.userId,
			sourceId: ensuredSource.id,
			packageId: prepared.packageId,
		})
		rethrowCommunityForkFailure(error)
	}
}

export function buildAlreadyForkedMessage(input: {
	targetName: string
	forkedPackageId: string
	forkedSourceId: string
	subject?: ForkSubject
}) {
	const subject = input.subject ?? 'listing'
	return `You already forked this ${subject} as "${input.targetName}" (package_id "${input.forkedPackageId}", source_id "${input.forkedSourceId}"). Returned that fork instead of creating a duplicate. Resume it with repoOpenSession, or pass a different package name leaf to fork the ${subject} again under a new name.`
}

/**
 * The fork a repeat request should get back instead of a new one. With an
 * explicit leaf, only a fork at that leaf counts (a different leaf is a
 * deliberate "fork again under a new name"). Without one, any fork of the
 * listing counts: prefer the fork at the listing leaf, else the newest.
 */
export async function findExistingCommunityFork(input: {
	env: Env
	userId: OwnerId
	listingId: string
	kodyId?: string
}): Promise<CommunityForkRecord | null> {
	const forks = await listCommunityForksByListingAndUser(input.env.APP_DB, {
		listingId: input.listingId,
		userId: input.userId,
	})
	return await pickExistingFork({
		forks,
		kodyId: input.kodyId,
		loadOriginLeaf: async () =>
			(
				await getCommunityListingById(input.env.APP_DB, {
					listingId: input.listingId,
					includeDelisted: true,
				})
			)?.kodyId ?? null,
	})
}

async function pickExistingFork(input: {
	forks: Array<CommunityForkRecord>
	kodyId?: string
	loadOriginLeaf: () => Promise<string | null>
}): Promise<CommunityForkRecord | null> {
	const { forks } = input
	if (forks.length === 0) return null
	const explicitKodyId = input.kodyId?.trim() || undefined
	if (explicitKodyId) {
		return forks.find((fork) => fork.targetKodyId === explicitKodyId) ?? null
	}
	const originLeaf = await input.loadOriginLeaf()
	const atOriginLeaf = originLeaf
		? forks.find((fork) => fork.targetKodyId === originLeaf)
		: undefined
	return atOriginLeaf ?? forks[forks.length - 1] ?? null
}

/**
 * Fork idempotently per (target owner, listing): hold the
 * `community_fork_claims` row while checking for an existing fork and
 * creating a new one, so concurrent requests (double submit, a retry after
 * navigating away mid-fork, an agent and the web UI at once) wait for the
 * first fork and then get it back instead of creating a duplicate.
 */
export async function runIdempotentCommunityFork<T>(
	input: Pick<
		PrepareCommunityForkInput,
		'env' | 'userId' | 'listingId' | 'kodyId' | 'creatorUserId'
	> & {
		onWaiting?: () => void | Promise<void>
		claimWaitMs?: number
		claimPollMs?: number
	},
	handlers: {
		existing: (fork: CommunityForkRecord) => Promise<T>
		create: (hold: { claimId: string }) => Promise<T>
	},
): Promise<T> {
	// Banned accounts get neither a new fork nor a handle to an old one.
	await Promise.all([
		assertNotCommunityBanned(input.env.APP_DB, input.userId),
		input.creatorUserId && input.creatorUserId !== input.userId
			? assertNotCommunityBanned(input.env.APP_DB, input.creatorUserId)
			: undefined,
	])
	return await withForkClaim(
		{ ...input, claimKey: input.listingId },
		() => findExistingCommunityFork(input),
		handlers,
	)
}

type IdempotentForkClaimInput = {
	env: Env
	userId: OwnerId
	claimKey: string
	kodyId?: string
	onWaiting?: () => void | Promise<void>
	claimWaitMs?: number
	claimPollMs?: number
}

async function withForkClaim<T>(
	input: IdempotentForkClaimInput,
	findExisting: () => Promise<CommunityForkRecord | null>,
	handlers: {
		existing: (fork: CommunityForkRecord) => Promise<T>
		create: (hold: { claimId: string }) => Promise<T>
	},
): Promise<T> {
	return await withCommunityForkClaim(
		{
			db: input.env.APP_DB,
			ownerId: input.userId,
			listingId: input.claimKey,
			requestedKodyId: input.kodyId?.trim() || null,
			waitMs: input.claimWaitMs,
			pollMs: input.claimPollMs,
			onWaiting: input.onWaiting,
		},
		async (hold) => {
			const existing = await findExisting()
			if (existing) return await handlers.existing(existing)
			// Fence create on a live claim so a lost lease cannot duplicate.
			await hold.assertHeld()
			return await handlers.create(hold)
		},
	)
}

export type PrivatePackageForkSource = {
	/** Org that owns the package being forked. */
	ownerId: OwnerId
	packageId: string
}

export type PreparePrivatePackageForkInput = Omit<
	PrepareCommunityForkInput,
	'listingId' | 'expectedPinnedCommit'
> & {
	sourcePackage: PrivatePackageForkSource
	/**
	 * The person forking. They must already hold `package:read` on the source
	 * package; the fork never grants them anything on it.
	 */
	reader: Pick<McpUserContext, 'userId' | 'username'>
	/** Reject when the source default branch moved past what the reader saw. */
	expectedOriginCommit?: string
}

/** Same message as a missing package so a fork never reveals one. */
export const privatePackageForkNotFoundMessage = 'Package not found.'

/**
 * The source package when `reader` may read it, else null. Non-readers get
 * the same answer as a package that does not exist.
 */
export async function loadReadablePrivateForkSource(input: {
	env: Env
	reader: Pick<McpUserContext, 'userId' | 'username'>
	sourcePackage: PrivatePackageForkSource
}) {
	const saved = await getSavedPackageById(input.env.APP_DB, {
		userId: input.sourcePackage.ownerId,
		packageId: input.sourcePackage.packageId,
	})
	if (!saved) return null
	const canRead = await viewerCanReadSavedPackage({
		env: input.env,
		viewer: input.reader,
		ownerId: input.sourcePackage.ownerId,
		packageId: input.sourcePackage.packageId,
	})
	return canRead ? saved : null
}

/**
 * Prepare a fork of a package the reader may read but that has no community
 * listing (private, or never listed). Files come from the source
 * default-branch HEAD, the same tree `git clone` returns with `package:read`.
 */
export async function preparePrivatePackageFork(
	input: PreparePrivatePackageForkInput,
): Promise<PreparedCommunityFork> {
	const [, , saved] = await Promise.all([
		assertNotCommunityBanned(input.env.APP_DB, input.userId),
		input.creatorUserId && input.creatorUserId !== input.userId
			? assertNotCommunityBanned(input.env.APP_DB, input.creatorUserId)
			: undefined,
		loadReadablePrivateForkSource(input),
	])
	if (!saved) {
		throw new CommunityActionError(privatePackageForkNotFoundMessage)
	}
	const source = await getEntitySourceById(input.env.APP_DB, saved.sourceId)
	if (!source?.repo_id) {
		throw new CommunityActionError(
			'This package has no source to fork yet. Ask the owner to push it first.',
		)
	}
	let originCommit: string | null = source.published_commit ?? null
	try {
		const head = await resolveArtifactSourceHead(input.env, source.repo_id)
		if (head.commit) originCommit = head.commit
	} catch {
		// Fall back to the published commit, like community forks.
	}
	if (!originCommit) {
		throw new CommunityActionError(
			'This package has no commits to fork yet. Ask the owner to push it first.',
		)
	}
	if (
		input.expectedOriginCommit &&
		originCommit !== input.expectedOriginCommit
	) {
		throw new CommunityActionError(
			'This package changed after you opened it. Reload the page and try again.',
		)
	}
	const snapshot = await readArtifactSourceSnapshot({
		env: input.env,
		repoId: source.repo_id,
		commit: originCommit,
	})
	if (!snapshot?.files) {
		throw new Error(
			`Source snapshot for package "${saved.id}" at ${originCommit} was not found.`,
		)
	}
	return await prepareForkFromOriginFiles({
		input,
		files: snapshot.files,
		originCommit,
		originName: saved.name,
		originKodyId: saved.kodyId,
		originRepoId: source.repo_id,
		lineage: {
			listingId: null,
			upstreamOwnerId: input.sourcePackage.ownerId,
			upstreamPackageId: saved.id,
			claimKey: privatePackageForkClaimKey(saved.id),
		},
		subject: 'package',
		listExistingForks: () =>
			listCommunityForksByUpstreamPackageAndUser(input.env.APP_DB, {
				upstreamPackageId: saved.id,
				userId: input.userId,
			}),
	})
}

function privatePackageForkClaimKey(packageId: string) {
	return `package:${packageId}`
}

/** This org's existing fork of a private package, same rules as listings. */
export async function findExistingPrivatePackageFork(input: {
	env: Env
	userId: OwnerId
	sourcePackage: PrivatePackageForkSource
	kodyId?: string
}): Promise<CommunityForkRecord | null> {
	const forks = await listCommunityForksByUpstreamPackageAndUser(
		input.env.APP_DB,
		{ upstreamPackageId: input.sourcePackage.packageId, userId: input.userId },
	)
	return await pickExistingFork({
		forks,
		kodyId: input.kodyId,
		loadOriginLeaf: async () =>
			(
				await getSavedPackageById(input.env.APP_DB, {
					userId: input.sourcePackage.ownerId,
					packageId: input.sourcePackage.packageId,
				})
			)?.kodyId ?? null,
	})
}

/**
 * Idempotent per (target org, source package), like
 * {@link runIdempotentCommunityFork}. The read check runs first so a
 * non-reader learns nothing, not even that a fork already exists.
 */
export async function runIdempotentPrivatePackageFork<T>(
	input: Pick<
		PreparePrivatePackageForkInput,
		'env' | 'userId' | 'kodyId' | 'creatorUserId' | 'sourcePackage' | 'reader'
	> & {
		onWaiting?: () => void | Promise<void>
		claimWaitMs?: number
		claimPollMs?: number
	},
	handlers: {
		existing: (fork: CommunityForkRecord) => Promise<T>
		create: (hold: { claimId: string }) => Promise<T>
	},
): Promise<T> {
	const [, , saved] = await Promise.all([
		assertNotCommunityBanned(input.env.APP_DB, input.userId),
		input.creatorUserId && input.creatorUserId !== input.userId
			? assertNotCommunityBanned(input.env.APP_DB, input.creatorUserId)
			: undefined,
		loadReadablePrivateForkSource(input),
	])
	if (!saved) {
		throw new CommunityActionError(privatePackageForkNotFoundMessage)
	}
	return await withForkClaim(
		{ ...input, claimKey: privatePackageForkClaimKey(saved.id) },
		() => findExistingPrivatePackageFork(input),
		handlers,
	)
}

/** Fork a readable private package into an inert source in `userId`. */
export async function forkPrivatePackage(
	input: PreparePrivatePackageForkInput & {
		onWaiting?: () => void | Promise<void>
		claimWaitMs?: number
		claimPollMs?: number
	},
): Promise<ForkCommunityListingResult> {
	return await runIdempotentPrivatePackageFork<ForkCommunityListingResult>(
		input,
		{
			existing: async (fork) =>
				existingForkResult(input.expectedPackageScope, fork, 'package'),
			create: async (hold) => {
				const serverTiming: Array<ServerTimingEntry> = []
				const prepared = await pushServerTiming(serverTiming, 'prepare', () =>
					preparePrivatePackageFork(input),
				)
				return await persistPreparedCommunityFork(prepared, {
					serverTiming,
					claimId: hold.claimId,
				})
			},
		},
	)
}

function existingForkResult(
	expectedPackageScope: string,
	fork: CommunityForkRecord,
	subject: ForkSubject,
): ForkCommunityListingResult {
	const packageScope = expectedPackageScope.replace(/^@/, '')
	const targetName = `@${packageScope}/${fork.targetKodyId}`
	return {
		forkId: fork.id,
		packageId: fork.forkedPackageId,
		sourceId: fork.forkedSourceId,
		targetKodyId: fork.targetKodyId,
		targetName,
		originCommit: fork.originCommit,
		crossScopeReferences: [],
		filesCount: 0,
		files: {},
		alreadyForked: true,
		message: buildAlreadyForkedMessage({
			targetName,
			forkedPackageId: fork.forkedPackageId,
			forkedSourceId: fork.forkedSourceId,
			subject,
		}),
	}
}

export async function forkCommunityListing(
	input: PrepareCommunityForkInput & {
		onWaiting?: () => void | Promise<void>
		claimWaitMs?: number
		claimPollMs?: number
	},
): Promise<ForkCommunityListingResult> {
	return await runIdempotentCommunityFork<ForkCommunityListingResult>(input, {
		existing: async (fork) =>
			existingForkResult(input.expectedPackageScope, fork, 'listing'),
		create: async (hold) => {
			const serverTiming: Array<ServerTimingEntry> = []
			const prepared = await pushServerTiming(serverTiming, 'prepare', () =>
				prepareCommunityFork(input),
			)
			return await persistPreparedCommunityFork(prepared, {
				serverTiming,
				claimId: hold.claimId,
			})
		},
	})
}

export type OrphanedCommunityFork = {
	forkId: string
	listingId: string | null
	listingName: string | null
	listingKodyId: string | null
	forkerUserId: string
	forkedPackageId: string
	forkedSourceId: string
	targetKodyId: string
	createdAt: string
}

export async function cleanupOrphanedCommunityForks(input: {
	env: Env
	apply: boolean
	forkIds?: Array<string>
}): Promise<{
	applied: boolean
	deletedCount: number
	orphans: Array<OrphanedCommunityFork>
}> {
	const orphans = (
		await listOrphanedCommunityForks(input.env.APP_DB, {
			forkIds: input.forkIds,
		})
	).map((row) => ({
		forkId: row.id,
		listingId: row.listing_id,
		listingName: row.listing_name,
		listingKodyId: row.listing_kody_id,
		forkerUserId: row.forker_user_id,
		forkedPackageId: row.forked_package_id,
		forkedSourceId: row.forked_source_id,
		targetKodyId: row.target_kody_id,
		createdAt: row.created_at,
	}))
	if (!input.apply) {
		return {
			applied: false,
			deletedCount: 0,
			orphans,
		}
	}
	if (orphans.length === 0) {
		return {
			applied: true,
			deletedCount: 0,
			orphans,
		}
	}
	const deletedCount = await deleteCommunityForksByIds(
		input.env.APP_DB,
		orphans.map((row) => row.forkId),
	)
	invalidateCommunityPublicCache()
	return {
		applied: true,
		deletedCount,
		orphans,
	}
}

export type AdoptCommunityForkResult = {
	packageId: string
	kodyId: string
	/** Null for a fork of a private package. */
	listingId: string | null
	originCommit: string
	adoptedAt: string
	alreadyAdopted: boolean
}

async function resolveOwnedCommunityPackageNameLeaf(input: {
	db: D1Database
	userId: OwnerId
	value: string
}) {
	const ownerScope = await getPackageScopeByUserId(input.db, input.userId)
	try {
		return normalizePackageNameInput({
			value: input.value,
			ownerScope,
			action: 'resolve',
		})
	} catch (error) {
		throw new CommunityActionError(getErrorMessage(error))
	}
}

async function resolveCommunityForkForAdoption(input: {
	env: Env
	userId: OwnerId
	packageId?: string
	kodyId?: string
}) {
	const packageIdCount =
		(input.packageId !== undefined ? 1 : 0) +
		(input.kodyId !== undefined ? 1 : 0)
	if (packageIdCount !== 1) {
		throw new CommunityActionError(
			'Provide exactly one of `package_id` or the package name leaf.',
		)
	}

	const savedPackage =
		input.packageId !== undefined
			? await getSavedPackageById(input.env.APP_DB, {
					userId: input.userId,
					packageId: input.packageId,
				})
			: await resolveSavedPackageRef(input.env.APP_DB, {
					userId: input.userId,
					match: 'slug',
					ref: await resolveOwnedCommunityPackageNameLeaf({
						db: input.env.APP_DB,
						userId: input.userId,
						value: input.kodyId ?? '',
					}),
				})
	if (!savedPackage) {
		const missingId = input.packageId ?? input.kodyId
		// Missing / mistyped package_id or name leaf is caller-clearable.
		// CommunityActionError keeps these on mcp-event lines and out of Sentry.
		throw new CommunityActionError(
			`Saved package "${missingId}" was not found. Confirm the id with search({ domain: "packages" }).`,
		)
	}

	const fork = await getCommunityForkByForkedPackageId(input.env.APP_DB, {
		forkerUserId: input.userId,
		forkedPackageId: savedPackage.id,
	})
	if (!fork) {
		throw new CommunityActionError(
			`Package "${savedPackage.kodyId}" is already self-authored; adoption is not needed.`,
		)
	}
	return { savedPackage, fork }
}

export type CommunityForkAdoptionState = {
	packageId: string
	kodyId: string
	ownerScope: string
	listingId: string | null
	originCommit: string
	adoptedAt: string | null
}

export async function inspectCommunityForkAdoption(input: {
	env: Env
	userId: OwnerId
	packageId?: string
	kodyId?: string
}): Promise<CommunityForkAdoptionState> {
	const { savedPackage, fork } = await resolveCommunityForkForAdoption(input)
	return {
		packageId: savedPackage.id,
		kodyId: savedPackage.kodyId,
		ownerScope: await getPackageScopeByUserId(input.env.APP_DB, input.userId),
		listingId: fork.listingId,
		originCommit: fork.originCommit,
		adoptedAt: fork.adoptedAt,
	}
}

/**
 * Widens implicit user-secret read/use for the fork. Only the signed-in
 * website account session may call this: MCP `execute` runs imported package
 * code with the agent's caller context, so any MCP/runtime path would let an
 * unadopted fork adopt itself.
 */
export async function adoptCommunityFork(input: {
	env: Env
	userId: OwnerId
	packageId: string
	reviewSummary: string
}): Promise<AdoptCommunityForkResult> {
	const reviewSummary = input.reviewSummary.trim()
	if (reviewSummary.length < communityForkAdoptionReviewNoteMinLength) {
		throw new CommunityActionError(
			`Adoption requires a review note of at least ${communityForkAdoptionReviewNoteMinLength} characters describing what was reviewed and why the fork is trusted.`,
		)
	}

	const { savedPackage, fork } = await resolveCommunityForkForAdoption({
		env: input.env,
		userId: input.userId,
		packageId: input.packageId,
	})
	const existingAdoption = (current: CommunityForkRecord | null) =>
		current?.adoptedAt
			? {
					packageId: savedPackage.id,
					kodyId: savedPackage.kodyId,
					listingId: current.listingId,
					originCommit: current.originCommit,
					adoptedAt: current.adoptedAt,
					alreadyAdopted: true,
				}
			: null
	const alreadyAdopted = existingAdoption(fork)
	if (alreadyAdopted) return alreadyAdopted

	const adoptedAt = new Date().toISOString()
	const updated = await markCommunityForkAdopted(input.env.APP_DB, {
		forkerUserId: input.userId,
		forkedPackageId: savedPackage.id,
		adoptionNote: reviewSummary,
		adoptedAt,
	})
	if (!updated) {
		const concurrentAdoption = existingAdoption(
			await getCommunityForkByForkedPackageId(input.env.APP_DB, {
				forkerUserId: input.userId,
				forkedPackageId: savedPackage.id,
			}),
		)
		if (concurrentAdoption) return concurrentAdoption
	}
	if (!updated?.adoptedAt) {
		throw new CommunityActionError(
			`Community fork for package "${savedPackage.kodyId}" could not be adopted.`,
		)
	}
	return {
		packageId: savedPackage.id,
		kodyId: savedPackage.kodyId,
		listingId: updated.listingId,
		originCommit: updated.originCommit,
		adoptedAt: updated.adoptedAt,
		alreadyAdopted: false,
	}
}

export type AbsorbCommunityForkUpstreamResult = {
	packageId: string
	kodyId: string
	/** Null for a fork of a private package. */
	listingId: string | null
	originCommit: string
	/** Listing pin, or the upstream package HEAD for a private package fork. */
	listingPinnedCommit: string
	alreadyAbsorbed: boolean
}

export async function absorbCommunityForkUpstream(input: {
	env: Env
	userId: OwnerId
	packageId?: string
	kodyId?: string
	originCommit?: string
	/**
	 * Person absorbing. Needed to read the upstream HEAD of a private package
	 * fork when `originCommit` is omitted; they must still hold package:read.
	 */
	reader?: Pick<McpUserContext, 'userId' | 'username'> | null
}): Promise<AbsorbCommunityForkUpstreamResult> {
	const packageIdCount =
		(input.packageId !== undefined ? 1 : 0) +
		(input.kodyId !== undefined ? 1 : 0)
	if (packageIdCount !== 1) {
		throw new CommunityActionError(
			'Provide exactly one of `package_id` or the package name leaf.',
		)
	}

	const savedPackage =
		input.packageId !== undefined
			? await getSavedPackageById(input.env.APP_DB, {
					userId: input.userId,
					packageId: input.packageId,
				})
			: await resolveSavedPackageRef(input.env.APP_DB, {
					userId: input.userId,
					match: 'slug',
					ref: await resolveOwnedCommunityPackageNameLeaf({
						db: input.env.APP_DB,
						userId: input.userId,
						value: input.kodyId ?? '',
					}),
				})
	if (!savedPackage) {
		const missingId = input.packageId ?? input.kodyId
		throw new CommunityActionError(
			`Saved package "${missingId}" was not found. Confirm the id with search({ domain: "packages" }).`,
		)
	}

	const fork = await getCommunityForkByForkedPackageId(input.env.APP_DB, {
		forkerUserId: input.userId,
		forkedPackageId: savedPackage.id,
	})
	if (!fork) {
		throw new CommunityActionError(
			`Package "${savedPackage.kodyId}" is self-authored and has no catalog entry to absorb.`,
		)
	}

	const upstream = await resolveForkUpstreamPin({
		env: input.env,
		fork,
		kodyId: savedPackage.kodyId,
		reader: input.reader ?? null,
		originCommit: input.originCommit,
	})
	const listing = { id: fork.listingId, pinnedCommit: upstream.pinnedCommit }
	const originCommit = input.originCommit?.trim() || listing.pinnedCommit
	if (fork.originCommit === originCommit) {
		return {
			packageId: savedPackage.id,
			kodyId: savedPackage.kodyId,
			listingId: listing.id,
			originCommit: fork.originCommit,
			listingPinnedCommit: listing.pinnedCommit,
			alreadyAbsorbed: true,
		}
	}

	const updated = await updateCommunityForkOriginCommit(input.env.APP_DB, {
		forkerUserId: input.userId,
		forkedPackageId: savedPackage.id,
		originCommit,
	})
	if (!updated) {
		throw new CommunityActionError(
			`Community fork for package "${savedPackage.kodyId}" could not record the listing update.`,
		)
	}
	return {
		packageId: savedPackage.id,
		kodyId: savedPackage.kodyId,
		listingId: listing.id,
		originCommit: updated.originCommit,
		listingPinnedCommit: listing.pinnedCommit,
		alreadyAbsorbed: false,
	}
}

/**
 * The commit a fork's upstream currently offers: the listing pin, or the
 * private package default-branch HEAD while the reader may still read it.
 */
async function resolveForkUpstreamPin(input: {
	env: Env
	fork: CommunityForkRecord
	kodyId: string
	reader: Pick<McpUserContext, 'userId' | 'username'> | null
	originCommit?: string
}): Promise<{ pinnedCommit: string }> {
	const { fork } = input
	if (fork.listingId) {
		const listing = await getCommunityListingById(input.env.APP_DB, {
			listingId: fork.listingId,
			includeDelisted: false,
		})
		if (!listing) {
			throw new CommunityActionError(
				`The source catalog entry for package "${input.kodyId}" is no longer active.`,
			)
		}
		return { pinnedCommit: listing.pinnedCommit }
	}
	const explicit = input.originCommit?.trim()
	if (!fork.upstreamOwnerId || !fork.upstreamPackageId || !input.reader) {
		if (explicit) return { pinnedCommit: explicit }
		throw new CommunityActionError(
			`The package "${input.kodyId}" was forked from is not available to you.`,
		)
	}
	const saved = await loadReadablePrivateForkSource({
		env: input.env,
		reader: input.reader,
		sourcePackage: {
			ownerId: fork.upstreamOwnerId as OwnerId,
			packageId: fork.upstreamPackageId,
		},
	})
	const source = saved
		? await getEntitySourceById(input.env.APP_DB, saved.sourceId)
		: null
	const head = source?.repo_id
		? await resolveArtifactSourceHead(input.env, source.repo_id)
		: null
	if (!head?.commit) {
		if (explicit) return { pinnedCommit: explicit }
		throw new CommunityActionError(
			`The package "${input.kodyId}" was forked from is not available to you.`,
		)
	}
	return { pinnedCommit: head.commit }
}

export async function rateCommunityListing(input: {
	env: Env
	/** Rater. Ratings stay person-keyed. */
	userId: OwnerId
	/**
	 * Org whose forks count as the rater's prior fork: the org the
	 * connection is bound to. communityFork keys fork rows by that org, which
	 * differs from the person id for new signups (#3053). Omit for legacy
	 * callers where the two are equal.
	 */
	forkOwnerId?: OwnerId
	listingId: string
	stars: number
	adaptationEffort: number
	note?: string
}): Promise<CommunityRatingRecord> {
	await assertNotCommunityBanned(input.env.APP_DB, input.userId)

	const listing = await getCommunityListingById(input.env.APP_DB, {
		listingId: input.listingId,
		includeDelisted: false,
	})
	if (!listing) {
		throw new CommunityActionError(
			`Catalog entry "${input.listingId}" was not found.`,
		)
	}
	const forkOwnerId = input.forkOwnerId ?? input.userId
	if (
		listing.ownerUserId === input.userId ||
		listing.ownerUserId === forkOwnerId
	) {
		throw new CommunityActionError('You cannot rate your own listing.')
	}

	// Forks from before the owner fix may still be keyed by the person id.
	const fork =
		(await getCommunityForkByListingAndUser(input.env.APP_DB, {
			listingId: input.listingId,
			userId: forkOwnerId,
		})) ??
		(forkOwnerId === input.userId
			? null
			: await getCommunityForkByListingAndUser(input.env.APP_DB, {
					listingId: input.listingId,
					userId: input.userId,
				}))
	if (!fork) {
		// Precondition the agent can clear: fork first, then rate.
		throw new CommunityActionError('Fork this public package before rating it.')
	}

	const rating = await upsertCommunityRating(input.env.APP_DB, {
		id: crypto.randomUUID(),
		listing_id: input.listingId,
		user_id: input.userId,
		stars: input.stars,
		adaptation_effort: input.adaptationEffort,
		note: input.note?.trim() || null,
	})
	await enqueueRecordedCommunityActivity({
		env: input.env,
		kind: 'rating',
		activityId: rating.id,
	})
	invalidateCommunityPublicCache()
	return rating
}

export async function reportCommunityListing(input: {
	env: Env
	userId: OwnerId
	listingId: string
	reason: string
}): Promise<CommunityReportRecord> {
	await assertNotCommunityBanned(input.env.APP_DB, input.userId)

	const listing = await getCommunityListingById(input.env.APP_DB, {
		listingId: input.listingId,
		includeDelisted: true,
	})
	if (!listing) {
		throw new CommunityActionError(
			`Catalog entry "${input.listingId}" was not found.`,
		)
	}

	const trimmedReason = input.reason.trim()
	if (trimmedReason.length < 1 || trimmedReason.length > 2_000) {
		throw new CommunityActionError(
			'Report reason must be between 1 and 2000 characters.',
		)
	}

	const reportId = crypto.randomUUID()
	await insertCommunityReport(input.env.APP_DB, {
		id: reportId,
		listing_id: listing.id,
		listing_name: listing.name,
		listing_owner_user_id: listing.ownerUserId,
		reporter_user_id: input.userId,
		reason: trimmedReason,
		status: 'open',
		resolved_by_user_id: null,
		resolved_at: null,
		resolution_note: null,
	})

	const report = await getCommunityReportById(input.env.APP_DB, reportId)
	if (!report) {
		throw new Error(`Community report "${reportId}" could not be loaded.`)
	}
	return report
}

export async function listCommunityReports(input: {
	env: Env
	status?: CommunityReportRecord['status']
}): Promise<Array<CommunityReportRecord>> {
	return await listCommunityReportsFromDb(input.env.APP_DB, {
		status: input.status,
	})
}

export async function resolveCommunityReport(input: {
	env: Env
	adminUserId: string
	reportId: string
	action: CommunityReportResolutionAction
	resolutionNote?: string
}): Promise<void> {
	const report = await getCommunityReportById(input.env.APP_DB, input.reportId)
	if (!report || report.status !== 'open') {
		throw new CommunityActionError(
			`Community report "${input.reportId}" was not found.`,
		)
	}

	switch (input.action) {
		case 'dismiss': {
			const resolved = await resolveCommunityReportRow(input.env.APP_DB, {
				reportId: input.reportId,
				status: 'dismissed',
				resolvedByUserId: input.adminUserId,
				resolutionNote: input.resolutionNote ?? null,
			})
			if (!resolved) {
				throw new CommunityActionError(
					`Community report "${input.reportId}" was not found.`,
				)
			}
			return
		}
		case 'delist': {
			await setCommunityListingStatus(input.env.APP_DB, {
				listingId: report.listingId,
				status: 'delisted',
			})
			invalidateCommunityPublicCache()
			const resolved = await resolveCommunityReportRow(input.env.APP_DB, {
				reportId: input.reportId,
				status: 'resolved',
				resolvedByUserId: input.adminUserId,
				resolutionNote: input.resolutionNote ?? null,
			})
			if (!resolved) {
				throw new CommunityActionError(
					`Community report "${input.reportId}" was not found.`,
				)
			}
			return
		}
		case 'delete': {
			// Hard delete removes listing metadata, ratings, snapshot, and icon.
			// Fork rows are preserved for provenance and the rate-after-fork gate;
			// report rows stay denormalized so moderation history survives deletion.
			const listing = await getCommunityListingById(input.env.APP_DB, {
				listingId: report.listingId,
				includeDelisted: true,
			})
			const deleted = await deleteCommunityListing(input.env.APP_DB, {
				listingId: report.listingId,
			})
			if (!deleted) {
				console.error(
					`Catalog entry "${report.listingId}" was already deleted during report resolution.`,
				)
			} else {
				if (listing) {
					await deleteCommunityIconAssetsBestEffort({
						env: input.env,
						listingId: listing.id,
						reason: 'hard-delete',
					})
				}
				await deleteCommunityRatingsByListingId(
					input.env.APP_DB,
					report.listingId,
				)
				await deleteCommunityActivityEventsByListingId(
					input.env.APP_DB,
					report.listingId,
				)
				await deleteCommunitySnapshot(
					input.env.BUNDLE_ARTIFACTS_KV,
					report.listingId,
				)
				invalidateCommunityPublicCache()
			}
			const resolved = await resolveCommunityReportRow(input.env.APP_DB, {
				reportId: input.reportId,
				status: 'resolved',
				resolvedByUserId: input.adminUserId,
				resolutionNote: input.resolutionNote ?? null,
			})
			if (!resolved) {
				throw new CommunityActionError(
					`Community report "${input.reportId}" was not found.`,
				)
			}
			return
		}
		default: {
			const unreachable: never = input.action
			throw new Error(`Unsupported report resolution action: ${unreachable}`)
		}
	}
}

export async function banCommunityUser(input: {
	env: Env
	adminUserId: string
	userId: OwnerId
	reason: string
}): Promise<void> {
	const trimmedReason = input.reason.trim()
	if (!trimmedReason) {
		throw new CommunityActionError('Ban reason is required.')
	}
	await insertCommunityBan(input.env.APP_DB, {
		user_id: input.userId,
		banned_by_user_id: input.adminUserId,
		reason: trimmedReason,
	})
}

export async function unbanCommunityUser(input: {
	env: Env
	userId: OwnerId
}): Promise<void> {
	const removed = await deleteCommunityBan(input.env.APP_DB, input.userId)
	if (!removed) {
		throw new Error(`Community ban for user "${input.userId}" was not found.`)
	}
}
