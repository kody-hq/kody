import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import {
	buildForkPrompt,
	toOnboardingFeaturedListing,
	toPublicCommunityListing,
	toViewerListingInstall,
	type OnboardingFeaturedListing,
	type PublicCommunityListing,
	type ViewerListingInstall,
} from '#app/community-public.ts'
import {
	buildCommunityDetailListingCacheKey,
	buildCommunityFeaturedCacheKey,
	buildCommunityIndexCacheKey,
	buildCommunityOnboardingMcpPackagesCacheKey,
	getOrSetDataCache,
} from '#app/data-cache.ts'
import { parseCommunityListingCategory } from '#universal/community-categories.ts'
import { listOnboardingFeaturedMcpListingIds } from '#universal/onboarding-mcp-chooser.ts'
import { parseCommunityListingSort } from '#universal/community-search.ts'
import { fallbackDefaultBranchName } from '#universal/package-files.ts'
import {
	type CommunityDetailLoaderData,
	type CommunityIndexLoaderData,
} from '#universal/loader-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { setRequestDataCacheLookup } from '#app/request-cache.ts'
import { listCommunityForksByListingIdsAndUser } from '#worker/community/repo.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { resolveCachedArtifactSourceHead } from '#worker/repo/artifact-head-cache.ts'
import { recordServerTiming } from '#worker/request-context.ts'
import {
	getCommunityCategoryCounts,
	getCommunityListingWithAggregates,
	getCommunityListingsByIds,
	listCommunityIndexOverview,
	listCommunityListingsWithAggregates,
	listFeaturedCommunityListingsWithAggregates,
	searchCommunityListings,
} from '#worker/community/service.ts'
import { getUserSocialRowByUsername } from '#worker/community/profile-repo.ts'
import { resolveListingPinAncestry } from '#worker/community/fork-listing-relation.ts'
import { resolveViewerListingInstalls } from '#worker/community/viewer-install.ts'
import {
	listSavedPackagesByIds,
	listSavedPackagesBySlugs,
} from '#worker/package-registry/repo.ts'
import { getMcpUserPackageScope } from '#worker/package-registry/user-scope.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'

const onboardingFeaturedListingLimit = 12

function isCommunityDataCacheEnabled(env: Env) {
	const sentryEnv = (env as { SENTRY_ENVIRONMENT?: string }).SENTRY_ENVIRONMENT
	return sentryEnv !== 'test'
}

async function loadWithCommunityCache<T>(
	env: Env,
	request: Request,
	key: string,
	load: () => Promise<T>,
): Promise<T> {
	if (!isCommunityDataCacheEnabled(env)) {
		setRequestDataCacheLookup(request, 'miss')
		return load()
	}

	const { value, lookup } = await getOrSetDataCache({ key, load })
	setRequestDataCacheLookup(request, lookup)
	return value
}

type CommunityIndexInput = {
	query: string
	sort: string | null
	category: string | null
	limit: number
}
const requestIndexDataStore = new WeakMap<
	Request,
	Map<string, Promise<CommunityIndexLoaderData>>
>()

export function loadCommunityIndexData(
	env: Env,
	request: Request,
	resource: CommunityIndexInput,
): Promise<CommunityIndexLoaderData> {
	let reads = requestIndexDataStore.get(request)
	if (!reads) {
		reads = new Map()
		requestIndexDataStore.set(request, reads)
	}
	const key = JSON.stringify(resource)
	let pending = reads.get(key)
	if (!pending) {
		pending = loadCommunityIndexDataUncached(env, request, resource)
		reads.set(key, pending)
	}
	return pending
}

async function loadCommunityIndexDataUncached(
	env: Env,
	request: Request,
	resource: CommunityIndexInput,
): Promise<CommunityIndexLoaderData> {
	const query = resource.query.trim()
	const sort = parseCommunityListingSort(resource.sort)
	const category = parseCommunityListingCategory(resource.category)
	const overview = query.length === 0 && category == null
	const limit = Math.min(100, Math.max(1, Math.floor(resource.limit)))

	const cacheKey = buildCommunityIndexCacheKey({
		query,
		sort,
		limit,
		category,
		overview,
	})
	const viewerPromise = readOptionalAuthenticatedViewer(request, env)
	const cached = await recordServerTiming(
		'community-listings',
		() =>
			loadWithCommunityCache(env, request, cacheKey, async () => {
				if (overview) {
					const overviewResult = await listCommunityIndexOverview({
						env,
						sort,
					})
					return {
						listings: overviewResult.listings.map(toPublicCommunityListing),
						groups: overviewResult.groups.map((group) => ({
							category: group.category,
							listings: group.listings.map(toPublicCommunityListing),
							total: group.total,
						})),
						categoryCounts: overviewResult.categoryCounts,
					}
				}
				const [rows, categoryCounts] = await Promise.all([
					query
						? searchCommunityListings({
								env,
								query,
								limit,
								sort,
								category,
							})
						: listCommunityListingsWithAggregates({
								env,
								includeDelisted: false,
								limit,
								offset: 0,
								sort,
								category,
							}),
					getCommunityCategoryCounts({ env }),
				])
				return {
					listings: rows.map(toPublicCommunityListing),
					groups: null,
					categoryCounts,
				}
			}),
		request,
	)

	const user = await recordServerTiming(
		'viewer-auth',
		() => viewerPromise,
		request,
	)
	const visibleListings = overview
		? (cached.groups ?? []).flatMap((group) => group.listings)
		: cached.listings
	const listings = await recordServerTiming(
		'viewer-installs',
		() =>
			overlayViewerInstallsOnListings({
				env,
				user,
				listings: visibleListings,
				request,
			}),
		request,
	)
	const listingById = new Map(listings.map((listing) => [listing.id, listing]))
	return {
		ok: true,
		listings,
		groups:
			cached.groups == null
				? null
				: cached.groups.map((group) => ({
						...group,
						listings: group.listings
							.map((listing) => listingById.get(listing.id))
							.filter((listing) => listing != null),
					})),
		categoryCounts: cached.categoryCounts,
		query: query || null,
		sort,
		category,
	}
}

/**
 * Featured starter packages for the onboarding page. Fails open to an empty
 * list: onboarding must render even if the community tables are unavailable.
 */
export async function loadOnboardingFeaturedListings(
	env: Env,
	request: Request,
): Promise<Array<OnboardingFeaturedListing>> {
	const cacheKey = buildCommunityFeaturedCacheKey(
		onboardingFeaturedListingLimit,
	)
	const viewerPromise = readOptionalAuthenticatedViewer(request, env)
	try {
		const listings = await loadWithCommunityCache(
			env,
			request,
			cacheKey,
			async () => {
				const rows = await listFeaturedCommunityListingsWithAggregates({
					env,
					limit: onboardingFeaturedListingLimit,
				})
				return rows.map(toOnboardingFeaturedListing)
			},
		)
		const user = await viewerPromise
		return overlayViewerInstallsOnListings({
			env,
			user,
			listings,
		})
	} catch (error) {
		console.error('Failed to load onboarding featured listings:', error)
		return []
	}
}

/**
 * Official `@kody/*-mcp` listings paired with the Step 2 chooser. Loaded by
 * pinned listing id so they appear even when an admin has not featured them.
 * Fails open to an empty list. Connect auto-forks these helpers; do not load
 * official API packages here for live person-account invoke.
 */
export async function loadOnboardingMcpChooserListings(
	env: Env,
	request: Request,
): Promise<Array<OnboardingFeaturedListing>> {
	const listingIds = listOnboardingFeaturedMcpListingIds()
	const viewerPromise = readOptionalAuthenticatedViewer(request, env)
	try {
		const listings = await loadWithCommunityCache(
			env,
			request,
			buildCommunityOnboardingMcpPackagesCacheKey(),
			async () => {
				const rows = await getCommunityListingsByIds(env.APP_DB, listingIds, {
					includeDelisted: false,
				})
				return rows.map(toOnboardingFeaturedListing)
			},
		)
		const user = await viewerPromise
		return overlayViewerInstallsOnListings({
			env,
			user,
			listings,
		})
	} catch (error) {
		console.error('Failed to load onboarding MCP chooser listings:', error)
		return []
	}
}

// One SSR request loads detail data twice: once in the HTML handler for the
// loaderData embed and once in the frame renderer during streaming. Memoize
// per Request so the second call reuses the first load.
const requestDetailDataStore = new WeakMap<
	Request,
	Map<string, Promise<CommunityDetailLoaderData | null>>
>()

export function loadCommunityDetailData(
	env: Env,
	request: Request,
	listingId: string,
): Promise<CommunityDetailLoaderData | null> {
	let byListingId = requestDetailDataStore.get(request)
	if (!byListingId) {
		byListingId = new Map()
		requestDetailDataStore.set(request, byListingId)
	}
	let pending = byListingId.get(listingId)
	if (!pending) {
		pending = loadCommunityDetailDataUncached(env, request, listingId)
		byListingId.set(listingId, pending)
	}
	return pending
}

/**
 * The public listing with aggregates, the Artifacts repo behind it, and the
 * package runtime pin. Cached as one unit so a warm isolate answers the
 * listing half of a page without touching D1. The owner's profile visibility
 * is deliberately not in here: it is a privacy control and stays a fresh
 * read on every request.
 */
type CommunityDetailPublicData = {
	listing: PublicCommunityListing
	sourceRepoId: string | null
	publishedCommit: string | null
}

function loadCommunityDetailPublicData(
	env: Env,
	request: Request,
	listingId: string,
): Promise<CommunityDetailPublicData | null> {
	return loadWithCommunityCache(
		env,
		request,
		buildCommunityDetailListingCacheKey(listingId),
		() =>
			recordServerTiming(
				'listing',
				async () => {
					const row = await getCommunityListingWithAggregates({
						env,
						listingId,
						includeDelisted: false,
					})
					if (!row) return null
					const source = await getEntitySourceById(env.APP_DB, row.sourceId)
					return {
						listing: toPublicCommunityListing(row),
						sourceRepoId: source?.repo_id ?? null,
						publishedCommit: source?.published_commit ?? null,
					}
				},
				request,
			),
	)
}

/**
 * Overlay the repo's current default-branch HEAD on the listing. HEAD is
 * best-effort: a failed lookup still renders the page with the fallback
 * branch name, and a listing without a source row is returned untouched.
 *
 * Compare HEAD to the package runtime pin, not `listing.pinnedCommit`. The
 * catalog snapshot only moves on community republish; `published_commit`
 * moves on every package publish. Mixing those made the Repo tab claim
 * HEAD was unpublished after Publish HEAD already showed no changes.
 */
async function withSourceHead(
	env: Env,
	request: Request,
	listing: PublicCommunityListing,
	sourceRepoId: string | null,
	publishedCommit: string | null,
): Promise<PublicCommunityListing> {
	if (!sourceRepoId) return listing
	try {
		const head = await resolveCachedArtifactSourceHead(env, sourceRepoId, {
			request,
		})
		const defaultBranch = head.branch?.trim() || fallbackDefaultBranchName
		const headCommit = head.commit
		const publishedPin = publishedCommit?.trim() || listing.pinnedCommit
		return {
			...listing,
			defaultBranch,
			...(headCommit && headCommit !== publishedPin
				? { headCommit, sourceAhead: true }
				: {}),
		}
	} catch {
		return { ...listing, defaultBranch: fallbackDefaultBranchName }
	}
}

async function loadCommunityDetailDataUncached(
	env: Env,
	request: Request,
	listingId: string,
): Promise<CommunityDetailLoaderData | null> {
	const publicData = await loadCommunityDetailPublicData(
		env,
		request,
		listingId,
	)
	if (!publicData) return null
	const { listing, sourceRepoId, publishedCommit } = publicData

	// HEAD lives in Artifacts, the owner row in D1, and the viewer in the
	// session cookie; none of the three reads needs another.
	const [sourceAheadListing, ownerRow, user] = await Promise.all([
		withSourceHead(env, request, listing, sourceRepoId, publishedCommit),
		getUserSocialRowByUsername(env.APP_DB, listing.ownerUsername),
		readOptionalAuthenticatedAppUser(request, env),
	])
	const ownerProfilePublic = ownerRow?.profile_visibility === 'public'
	const ownerUserId = ownerRow
		? ownerIdFromStored(ownerRow.stable_user_id)
		: null
	const viewerUserId = user?.request.org.id ?? null
	const viewerIsOwner =
		viewerUserId != null && ownerUserId != null && viewerUserId === ownerUserId
	const viewerInstalls = await loadViewerListingInstalls({
		env,
		user: user?.mcpUser ?? null,
		listings: [
			{
				id: listing.id,
				kodyId: listing.kodyId,
				name: listing.name,
				pinnedCommit: listing.pinnedCommit,
			},
		],
	})
	const viewerInstall = viewerInstalls.get(listing.id) ?? null
	const listingWithHead = viewerInstall
		? { ...sourceAheadListing, viewerInstall }
		: sourceAheadListing
	// listingBehind is overlaid on the package-page frame from the owner's
	// fresh AccountPackageDetail.listingNeedsRepublish (not this public cache).
	return composeCommunityDetailLoaderData({
		listing: listingWithHead,
		loggedIn: Boolean(user),
		viewerIsAdmin: user?.roles.includes('admin') ?? false,
		ownerProfilePublic,
		viewerIsOwner,
		viewerInstall,
	})
}

export function composeCommunityDetailLoaderData(input: {
	listing: PublicCommunityListing
	loggedIn: boolean
	viewerIsAdmin?: boolean
	ownerProfilePublic?: boolean
	viewerIsOwner?: boolean
	viewerInstall?: ViewerListingInstall | null
}): CommunityDetailLoaderData {
	return {
		ok: true,
		listing: input.listing,
		ownerProfilePublic: input.ownerProfilePublic ?? false,
		viewerIsOwner: input.viewerIsOwner ?? false,
		viewerCanManage: input.viewerIsOwner ?? false,
		loggedIn: input.loggedIn,
		viewerIsAdmin: input.viewerIsAdmin ?? false,
		forkPrompt: buildForkPrompt({
			name: input.listing.name,
			listingId: input.listing.id,
		}),
		viewerInstall: input.viewerInstall ?? null,
		ownerPackage: null,
		username: input.listing.ownerUsername,
		invocationUrlOrigin: '',
	}
}

/**
 * Public listing pages stay up when session parsing or user lookup fails.
 * Viewer overlays are optional; anonymous listings are the safe fallback.
 */
async function readOptionalAuthenticatedAppUser(request: Request, env: Env) {
	try {
		return await readAuthenticatedAppUser(request, env)
	} catch (error) {
		console.error('Failed to resolve authenticated viewer for listings:', error)
		return null
	}
}

async function readOptionalAuthenticatedViewer(request: Request, env: Env) {
	return (await readOptionalAuthenticatedAppUser(request, env))?.mcpUser ?? null
}

async function overlayViewerInstallsOnListings<
	T extends { id: string; kodyId: string },
>(input: {
	env: Env
	user: McpUserContext | null
	listings: Array<T>
	request?: Request
}): Promise<Array<T>> {
	if (input.user == null || input.listings.length === 0) {
		return input.listings
	}
	const viewerInstalls = await loadViewerListingInstalls({
		env: input.env,
		user: input.user,
		listings: input.listings,
		request: input.request,
	})
	if (viewerInstalls.size === 0) return input.listings
	return input.listings.map((listing) => {
		const viewerInstall = viewerInstalls.get(listing.id)
		return viewerInstall ? { ...listing, viewerInstall } : listing
	})
}

/**
 * Viewer overlay is per-request and never written into the public listing
 * cache. Failures stay empty so a fork/package lookup blip cannot take down
 * onboarding or community browse.
 */
async function loadViewerListingInstalls(input: {
	env: Env
	user: McpUserContext | null
	listings: Array<{
		id: string
		kodyId: string
		name?: string
		pinnedCommit?: string
	}>
	request?: Request
}): Promise<Map<string, ViewerListingInstall>> {
	if (input.user == null || input.listings.length === 0) {
		return new Map()
	}
	try {
		const listingIds = input.listings.map((listing) => listing.id)
		const slugs = input.listings.map((listing) => listing.kodyId)
		const [packageScope, forks, savedByKody] = await Promise.all([
			getMcpUserPackageScope(input.env.APP_DB, input.user),
			listCommunityForksByListingIdsAndUser(input.env.APP_DB, {
				listingIds,
				userId: input.user.userId,
			}),
			listSavedPackagesBySlugs(input.env.APP_DB, {
				userId: input.user.userId,
				slugs,
			}),
		])
		const missingPackageIds = [
			...new Set(
				forks
					.map((fork) => fork.forkedPackageId)
					.filter(
						(packageId) =>
							!savedByKody.some(
								(savedPackage) => savedPackage.id === packageId,
							),
					),
			),
		]
		const savedByForkId =
			missingPackageIds.length === 0
				? []
				: await listSavedPackagesByIds(input.env.APP_DB, {
						userId: input.user.userId,
						packageIds: missingPackageIds,
					})
		const listingPinIsAncestorByListingId = await recordServerTiming(
			'fork-ancestry',
			() =>
				resolveViewerListingAncestry({
					env: input.env,
					listings: input.listings,
					packageScope,
					savedPackages: [...savedByKody, ...savedByForkId],
					forks,
				}),
			input.request,
		)
		const resolved = resolveViewerListingInstalls({
			listings: input.listings,
			packageScope,
			savedPackages: [...savedByKody, ...savedByForkId],
			forks,
			listingPinIsAncestorByListingId,
		})
		const listingById = new Map(
			input.listings.map((listing) => [listing.id, listing]),
		)
		const viewerInstalls = new Map<string, ViewerListingInstall>()
		for (const [listingId, install] of resolved) {
			const listing = listingById.get(listingId)
			viewerInstalls.set(
				listingId,
				toViewerListingInstall({
					...install,
					listingId,
					listingName: listing?.name,
					listingKodyId: listing?.kodyId,
				}),
			)
		}
		return viewerInstalls
	} catch (error) {
		console.error('Failed to load viewer listing installs:', error)
		return new Map()
	}
}

async function resolveViewerListingAncestry(input: {
	env: Env
	listings: Array<{
		id: string
		kodyId: string
		name?: string
		pinnedCommit?: string
	}>
	packageScope: string
	savedPackages: Array<{
		id: string
		kodyId: string
		name: string
		sourceId: string
	}>
	forks: Array<{
		listingId: string
		targetKodyId: string
		forkedPackageId: string
		forkedSourceId: string
		createdAt: string
		originCommit?: string
	}>
}) {
	const draft = resolveViewerListingInstalls(input)
	const listingPinIsAncestorByListingId = new Map<string, boolean | null>()
	await Promise.all(
		[...draft.entries()].map(async ([listingId, install]) => {
			if (
				install.originCommit == null ||
				install.listingPinnedCommit == null ||
				install.originCommit === install.listingPinnedCommit
			) {
				return
			}
			listingPinIsAncestorByListingId.set(
				listingId,
				await resolveListingPinAncestry({
					env: input.env,
					listingId,
					listingPinnedCommit: install.listingPinnedCommit,
					originCommit: install.originCommit,
				}),
			)
		}),
	)
	return listingPinIsAncestorByListingId
}
