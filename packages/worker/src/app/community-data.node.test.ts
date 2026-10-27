import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import {
	emptyCommunityCategoryCounts,
	type CommunityCategoryCounts,
} from '#universal/community-categories.ts'
import type * as forkListingRelation from '#worker/community/fork-listing-relation.ts'
import { type CommunityListingWithAggregates } from '#worker/community/types.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { invalidateCommunityPublicCache } from './data-cache.ts'
import {
	loadCommunityDetailData,
	loadCommunityIndexData,
} from './community-data.ts'

const mockModule = vi.hoisted(() => ({
	getPackageScopeByUserId: vi.fn(),
	resolveCommunityInstallOwner: vi.fn(),
	readAuthenticatedAppUser: vi.fn(),
	listCommunityIndexOverview: vi.fn(),
	getCommunityCategoryCounts: vi.fn(),
	listCommunityListingsWithAggregates: vi.fn(),
	searchCommunityListings: vi.fn(),
	listFeaturedCommunityListingsWithAggregates: vi.fn(),
	getCommunityListingWithAggregates: vi.fn(),
	getCommunityListingsByIds: vi.fn(),
	listCommunityForksByListingIdsAndUser: vi.fn(),
	getCommunityListingById: vi.fn(),
	getEntitySourceById: vi.fn(),
	resolveCachedArtifactSourceHead: vi.fn(),
	listSavedPackagesBySlugs: vi.fn(),
	listSavedPackagesByIds: vi.fn(),
	getMcpUserPackageScope: vi.fn(),
	getUserSocialRowByUsername: vi.fn(),
	resolveListingPinAncestry: vi.fn<
		typeof forkListingRelation.resolveListingPinAncestry
	>(async () => null),
	loadViewerPrivateCommunityForks: vi.fn(async () => [] as Array<unknown>),
	countCommunityForksByListingIds: vi.fn(
		async () => ({}) as Record<string, number>,
	),
}))

vi.mock('#app/community-forks-data.ts', () => ({
	loadViewerPrivateCommunityForks: mockModule.loadViewerPrivateCommunityForks,
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: mockModule.readAuthenticatedAppUser,
}))

vi.mock('#worker/community/service.ts', () => ({
	listCommunityIndexOverview: mockModule.listCommunityIndexOverview,
	getCommunityCategoryCounts: mockModule.getCommunityCategoryCounts,
	listCommunityListingsWithAggregates:
		mockModule.listCommunityListingsWithAggregates,
	searchCommunityListings: mockModule.searchCommunityListings,
	listFeaturedCommunityListingsWithAggregates:
		mockModule.listFeaturedCommunityListingsWithAggregates,
	getCommunityListingWithAggregates:
		mockModule.getCommunityListingWithAggregates,
	getCommunityListingsByIds: mockModule.getCommunityListingsByIds,
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingById: mockModule.getCommunityListingById,
	countCommunityForksByListingIds: mockModule.countCommunityForksByListingIds,
	listCommunityForksByListingIdsAndUser:
		mockModule.listCommunityForksByListingIdsAndUser,
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: mockModule.getEntitySourceById,
}))

vi.mock('#worker/repo/artifact-head-cache.ts', () => ({
	resolveCachedArtifactSourceHead: mockModule.resolveCachedArtifactSourceHead,
}))

vi.mock('#worker/community/profile-repo.ts', () => ({
	getUserSocialRowByUsername: mockModule.getUserSocialRowByUsername,
}))

vi.mock('#worker/community/fork-listing-relation.ts', () => ({
	resolveListingPinAncestry: mockModule.resolveListingPinAncestry,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesBySlugs: mockModule.listSavedPackagesBySlugs,
	listSavedPackagesByIds: mockModule.listSavedPackagesByIds,
}))

vi.mock('#worker/package-registry/user-scope.ts', () => ({
	getMcpUserPackageScope: mockModule.getMcpUserPackageScope,
	getPackageScopeByUserId: mockModule.getPackageScopeByUserId,
}))

vi.mock('#app/community-install-org.ts', () => ({
	resolveCommunityInstallOwner: mockModule.resolveCommunityInstallOwner,
}))

const sampleListing = {
	id: 'listing-github',
	ownerUserId: ownerIdFromStored('owner-mcp-id'),
	packageId: 'pkg-1',
	sourceId: 'src-1',
	kodyId: 'github',
	name: '@kody/github',
	description: 'GitHub helpers.',
	tags: ['github'],
	category: 'integrations',
	searchText: null,
	readmeContent: '# README',
	license: 'MIT',
	pinnedCommit: 'abc1234567890',
	iconCommit: 'abc1234567890',
	status: 'active',
	trustedCommit: 'abc1234567890',
	trustedAt: '2026-01-02T00:00:00.000Z',
	trusted: true,
	featuredAt: '2026-01-03T00:00:00.000Z',
	featured: true,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	publishedAt: '2026-01-01T00:00:00.000Z',
	averageStars: 4.5,
	ratingCount: 2,
	averageAdaptationEffort: 3,
	forkCount: 1,
} satisfies CommunityListingWithAggregates

const viewerGithubPackage = {
	id: 'pkg-github',
	kodyId: 'github',
	name: '@burhan/github',
	sourceId: 'src-github',
}

function viewerFork(overrides: Record<string, unknown> = {}) {
	return {
		listingId: 'listing-github',
		targetKodyId: 'github',
		forkedPackageId: 'pkg-github',
		forkedSourceId: 'src-github',
		createdAt: '2026-08-01T00:00:00.000Z',
		...overrides,
	}
}

function categoryCounts(
	overrides: Partial<CommunityCategoryCounts> = {},
): CommunityCategoryCounts {
	return { ...emptyCommunityCategoryCounts(), ...overrides }
}

function sampleOverview(listing = sampleListing) {
	return {
		listings: [listing],
		groups: [{ category: listing.category, listings: [listing], total: 1 }],
		categoryCounts: categoryCounts({ [listing.category]: 1 }),
	}
}

function signedInUser() {
	return {
		mcpUser: { userId: ownerIdFromStored('viewer-1'), username: 'burhan' },
		request: sessionRequestContext('viewer-1', 'burhan'),
		roles: [],
	}
}

const request = (path: string) => new Request(`https://example.com${path}`)

test('community index overlays fork installs and ignores same-leaf packages without a fork', async () => {
	invalidateCommunityPublicCache()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(signedInUser())
	mockModule.listCommunityIndexOverview.mockResolvedValue(sampleOverview())
	mockModule.getMcpUserPackageScope.mockResolvedValue('burhan')
	mockModule.listCommunityForksByListingIdsAndUser.mockResolvedValue([])
	mockModule.listSavedPackagesBySlugs.mockResolvedValue([viewerGithubPackage])
	mockModule.listSavedPackagesByIds.mockResolvedValue([])

	const sameLeafOnly = await loadCommunityIndexData(
		{} as Env,
		request('/community'),
		{ query: '', sort: null, category: null, limit: 50 },
	)
	expect(sameLeafOnly.listings).toHaveLength(1)
	expect(sameLeafOnly.listings[0]?.viewerInstall).toBeUndefined()

	invalidateCommunityPublicCache()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(signedInUser())
	mockModule.listCommunityIndexOverview.mockResolvedValue(sampleOverview())
	mockModule.getMcpUserPackageScope.mockResolvedValue('burhan')
	mockModule.listCommunityForksByListingIdsAndUser.mockResolvedValue([
		viewerFork(),
	])
	mockModule.listSavedPackagesBySlugs.mockResolvedValue([viewerGithubPackage])
	mockModule.listSavedPackagesByIds.mockResolvedValue([])

	const data = await loadCommunityIndexData({} as Env, request('/community'), {
		query: '',
		sort: null,
		category: null,
		limit: 50,
	})
	expect(data.listings).toHaveLength(1)
	expect(data.listings[0]?.viewerInstall).toEqual(
		expect.objectContaining({
			status: 'installed',
			targetName: '@burhan/github',
			packageId: 'pkg-github',
		}),
	)
	expect(mockModule.listSavedPackagesBySlugs).toHaveBeenCalledWith(
		undefined,
		expect.objectContaining({ userId: ownerIdFromStored('viewer-1') }),
	)
	expect(mockModule.listCommunityForksByListingIdsAndUser).toHaveBeenCalledWith(
		undefined,
		expect.objectContaining({ userId: ownerIdFromStored('viewer-1') }),
	)
})

test('community detail overlays viewerInstall for forked listings and omits it when not forked', async () => {
	invalidateCommunityPublicCache()
	mockModule.getCommunityListingWithAggregates.mockResolvedValue(sampleListing)
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing)
	mockModule.getEntitySourceById.mockResolvedValue(null)
	mockModule.getUserSocialRowByUsername.mockResolvedValue({
		profile_visibility: 'public',
		stable_user_id: 'owner-mcp-id',
	})
	mockModule.getMcpUserPackageScope.mockResolvedValue('burhan')
	mockModule.listSavedPackagesByIds.mockResolvedValue([])
	mockModule.readAuthenticatedAppUser.mockResolvedValue(signedInUser())
	mockModule.listCommunityForksByListingIdsAndUser.mockResolvedValue([])
	mockModule.listSavedPackagesBySlugs.mockResolvedValue([])
	const loadDetail = (path: string) =>
		loadCommunityDetailData({} as Env, request(path), 'listing-github')

	const notForked = await loadDetail('/community/listing-github')
	expect(notForked?.viewerInstall).toBeNull()
	expect(notForked?.listing?.forkCount).toBe(1)

	invalidateCommunityPublicCache()
	// Fresh public count (0: the cached fork was just hidden) plus 2 private.
	mockModule.countCommunityForksByListingIds.mockResolvedValueOnce({
		'listing-github': 0,
	})
	mockModule.loadViewerPrivateCommunityForks.mockResolvedValueOnce([
		{ forkId: 'private-fork' },
		{ forkId: 'other-private-fork' },
	])
	const withPrivateForks = await loadDetail('/community/listing-github-private')
	expect(withPrivateForks?.listing?.forkCount).toBe(2)

	invalidateCommunityPublicCache()
	mockModule.listCommunityForksByListingIdsAndUser.mockResolvedValue([
		viewerFork(),
	])
	mockModule.listSavedPackagesBySlugs.mockResolvedValue([viewerGithubPackage])
	const forked = await loadDetail('/community/listing-github-forked')
	expect(forked?.viewerInstall).toEqual(
		expect.objectContaining({
			status: 'installed',
			targetName: '@burhan/github',
			packageId: 'pkg-github',
		}),
	)
	const forkedListing = forked?.listing
	if (!forkedListing) throw new Error('Expected forked listing detail')
	expect(forkedListing.viewerInstall?.status).toBe('installed')
	expect(forked?.viewerInstall?.listingAhead).toBe(false)

	invalidateCommunityPublicCache()
	mockModule.getCommunityListingWithAggregates.mockResolvedValue({
		...sampleListing,
		pinnedCommit: 'commit-new',
	})
	mockModule.listCommunityForksByListingIdsAndUser.mockResolvedValue([
		viewerFork({ originCommit: 'abc1234567890' }),
	])
	mockModule.resolveListingPinAncestry.mockResolvedValueOnce(false)
	const outdated = await loadDetail('/community/listing-github-ahead')
	expect(outdated?.viewerInstall).toEqual(
		expect.objectContaining({
			status: 'installed',
			listingAhead: true,
			forkAhead: false,
		}),
	)
	expect(outdated?.viewerInstall?.listingAheadPrompt).toMatch(/\S/)

	invalidateCommunityPublicCache()
	mockModule.getCommunityListingWithAggregates.mockResolvedValue({
		...sampleListing,
		pinnedCommit: 'commit-pin',
	})
	mockModule.listCommunityForksByListingIdsAndUser.mockResolvedValue([
		viewerFork({ originCommit: 'commit-tip' }),
	])
	mockModule.resolveListingPinAncestry.mockResolvedValueOnce(true)
	const forkAhead = await loadDetail('/community/listing-github-fork-ahead')
	expect(forkAhead?.viewerInstall).toEqual(
		expect.objectContaining({
			status: 'installed',
			listingAhead: false,
			forkAhead: true,
		}),
	)
	expect(forkAhead?.viewerInstall?.listingAheadPrompt).toBeNull()
	expect(forkAhead?.viewerInstall?.listingDiffHref).toContain('/tree/')
	expect(mockModule.resolveListingPinAncestry).toHaveBeenCalledWith(
		expect.objectContaining({
			listingId: 'listing-github',
			listingPinnedCommit: 'commit-pin',
			originCommit: 'commit-tip',
		}),
	)
})

test('sourceAhead compares HEAD to the runtime pin, not the community catalog snapshot', async () => {
	invalidateCommunityPublicCache()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.getCommunityListingWithAggregates.mockResolvedValue(sampleListing)
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing)
	mockModule.getUserSocialRowByUsername.mockResolvedValue({
		profile_visibility: 'public',
		stable_user_id: 'owner-mcp-id',
	})
	mockModule.listCommunityForksByListingIdsAndUser.mockResolvedValue([])
	mockModule.listSavedPackagesBySlugs.mockResolvedValue([])
	mockModule.listSavedPackagesByIds.mockResolvedValue([])
	mockModule.getMcpUserPackageScope.mockResolvedValue('viewer')
	const runtimePin = 'cccccccccccccccccccccccccccccccccccccccc'
	const unpublishedHead = 'dddddddddddddddddddddddddddddddddddddddd'
	mockModule.getEntitySourceById.mockResolvedValue({
		repo_id: 'repo-1',
		published_commit: runtimePin,
	})
	mockModule.resolveCachedArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: runtimePin,
	})

	const published = await loadCommunityDetailData(
		{} as Env,
		request('/community/listing-github-published'),
		'listing-github',
	)
	const publishedListing = published?.listing
	if (!publishedListing) throw new Error('Expected published listing detail')
	expect(publishedListing.sourceAhead).toBeUndefined()
	expect(publishedListing.headCommit).toBeUndefined()
	expect(publishedListing.pinnedCommit).toBe(sampleListing.pinnedCommit)
	expect(publishedListing.pinnedCommit).not.toBe(runtimePin)

	invalidateCommunityPublicCache()
	mockModule.resolveCachedArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: unpublishedHead,
	})
	const aheadOfRuntime = await loadCommunityDetailData(
		{} as Env,
		request('/community/listing-github-runtime-ahead'),
		'listing-github',
	)
	const aheadListing = aheadOfRuntime?.listing
	if (!aheadListing) throw new Error('Expected runtime-ahead listing detail')
	expect(aheadListing.sourceAhead).toBe(true)
	expect(aheadListing.headCommit).toBe(unpublishedHead)
})

test('community index omits viewerInstall for anonymous viewers and auth failures', async () => {
	invalidateCommunityPublicCache()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.listCommunityIndexOverview.mockResolvedValue(sampleOverview())

	const anonymous = await loadCommunityIndexData(
		{} as Env,
		request('/community'),
		{ query: '', sort: null, category: null, limit: 50 },
	)
	expect(anonymous.listings[0]?.viewerInstall).toBeUndefined()
	expect(mockModule.listSavedPackagesBySlugs).not.toHaveBeenCalled()

	mockModule.readAuthenticatedAppUser.mockRejectedValue(
		new Error('Missing COOKIE_SECRET for session signing.'),
	)
	consoleError.mockImplementation(() => {})
	const failedAuth = await loadCommunityIndexData(
		{} as Env,
		request('/community'),
		{ query: '', sort: null, category: null, limit: 50 },
	)
	expect(failedAuth.ok).toBe(true)
	expect(failedAuth.listings).toHaveLength(1)
	expect(failedAuth.listings[0]?.id).toBe('listing-github')
	expect(failedAuth.listings[0]?.viewerInstall).toBeUndefined()
	expect(mockModule.listSavedPackagesBySlugs).not.toHaveBeenCalled()
	expect(consoleError).toHaveBeenCalled()
})

test('loadCommunityDetailData forgets rejected loads so D1 retries can re-read (KODY-B7)', async () => {
	invalidateCommunityPublicCache()
	const sameRequest = request('/community/listing-github-retry')
	const d1Export = new Error(
		'D1_ERROR: Currently processing a long-running export.',
	)
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.getCommunityListingWithAggregates
		.mockRejectedValueOnce(d1Export)
		.mockResolvedValueOnce(sampleListing)
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing)
	mockModule.getEntitySourceById.mockResolvedValue(null)
	mockModule.getUserSocialRowByUsername.mockResolvedValue({
		profile_visibility: 'public',
		stable_user_id: 'owner-mcp-id',
	})

	await expect(
		loadCommunityDetailData({} as Env, sameRequest, 'listing-github'),
	).rejects.toBe(d1Export)
	const recovered = await loadCommunityDetailData(
		{} as Env,
		sameRequest,
		'listing-github',
	)
	expect(recovered?.listing?.id).toBe('listing-github')
	expect(mockModule.getCommunityListingWithAggregates).toHaveBeenCalledTimes(2)
})

test('install badges follow the picked org and fall back to personal when it is rejected', async () => {
	const teamOwnerId = ownerIdFromStored('org-example-team')
	const loadIndex = (installOrg: string) =>
		loadCommunityIndexData({} as Env, request(`/community?org=${installOrg}`), {
			query: '',
			sort: null,
			category: null,
			limit: 50,
			installOrg,
		})
	invalidateCommunityPublicCache()
	mockModule.readAuthenticatedAppUser.mockResolvedValue(signedInUser())
	mockModule.listCommunityIndexOverview.mockResolvedValue(sampleOverview())
	mockModule.getMcpUserPackageScope.mockResolvedValue('burhan')
	mockModule.getPackageScopeByUserId.mockResolvedValue('example-team')
	mockModule.listSavedPackagesByIds.mockResolvedValue([])
	// The personal account forked; the picked org has not.
	mockModule.listCommunityForksByListingIdsAndUser.mockImplementation(
		async (_db: unknown, input: { userId: string }) =>
			input.userId === teamOwnerId ? [] : [viewerFork()],
	)
	mockModule.listSavedPackagesBySlugs.mockImplementation(
		async (_db: unknown, input: { userId: string }) =>
			input.userId === teamOwnerId ? [] : [viewerGithubPackage],
	)
	mockModule.resolveCommunityInstallOwner.mockResolvedValue({
		ok: true,
		ownerId: teamOwnerId,
		orgSlug: 'example-team',
	})
	const team = await loadIndex('example-team')
	expect(team.installOrg).toBe('example-team')
	expect(team.listings[0]?.viewerInstall).toBeUndefined()
	expect(mockModule.listCommunityForksByListingIdsAndUser).toHaveBeenCalledWith(
		undefined,
		expect.objectContaining({ userId: teamOwnerId }),
	)

	// A stale or forbidden ?org= renders the personal badges instead.
	mockModule.resolveCommunityInstallOwner.mockResolvedValue({
		ok: false,
		status: 403,
		error: 'nope',
	})
	const rejected = await loadIndex('other-team')
	expect(rejected.installOrg).toBeNull()
	expect(rejected.listings[0]?.viewerInstall?.status).toBe('installed')
})

test('detail outdated badge is relative to the picked org', async () => {
	const teamOwnerId = ownerIdFromStored('org-example-team')
	invalidateCommunityPublicCache()
	mockModule.getCommunityListingWithAggregates.mockResolvedValue({
		...sampleListing,
		pinnedCommit: 'commit-new',
	})
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing)
	mockModule.getEntitySourceById.mockResolvedValue(null)
	mockModule.getUserSocialRowByUsername.mockResolvedValue({
		profile_visibility: 'public',
		stable_user_id: 'owner-mcp-id',
	})
	mockModule.readAuthenticatedAppUser.mockResolvedValue(signedInUser())
	mockModule.getPackageScopeByUserId.mockResolvedValue('example-team')
	mockModule.listSavedPackagesByIds.mockResolvedValue([])
	// Only the picked org holds a fork, and it is behind the listing.
	mockModule.listCommunityForksByListingIdsAndUser.mockImplementation(
		async (_db: unknown, input: { userId: string }) =>
			input.userId === teamOwnerId
				? [viewerFork({ originCommit: 'abc1234567890' })]
				: [],
	)
	mockModule.listSavedPackagesBySlugs.mockImplementation(
		async (_db: unknown, input: { userId: string }) =>
			input.userId === teamOwnerId
				? [{ ...viewerGithubPackage, name: '@example-team/github' }]
				: [],
	)
	mockModule.resolveListingPinAncestry.mockResolvedValue(false)
	mockModule.resolveCommunityInstallOwner.mockResolvedValue({
		ok: true,
		ownerId: teamOwnerId,
		orgSlug: 'example-team',
	})
	const team = await loadCommunityDetailData(
		{} as Env,
		request('/community/listing-github?org=example-team'),
		'listing-github',
		'example-team',
	)
	expect(team?.viewerInstall).toEqual(
		expect.objectContaining({
			targetName: '@example-team/github',
			listingAhead: true,
		}),
	)

	const personal = await loadCommunityDetailData(
		{} as Env,
		request('/community/listing-github'),
		'listing-github',
	)
	expect(personal?.viewerInstall).toBeNull()
})
