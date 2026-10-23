import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { communityIndexOverviewCandidateLimitPerCategory } from '#universal/community-categories.ts'
import { durableObjectIsolateMemoryResetMessage } from '#worker/sentry-options.ts'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import {
	CommunityActionError,
	CommunityForkResourceLimitError,
} from './errors.ts'
import type * as CommunityRepo from './repo.ts'
import type * as PackageUrl from './package-url.ts'
import { type CommunityListingRecord } from './types.ts'

const { mockModule, pickMocks } = vi.hoisted(() => {
	const mockModule = {
		enqueueCommunityActivityDispatch: vi.fn(),
		enqueueCommunityListingPublishedDispatch: vi.fn(),
		notifyFollowsOfPublishedPackage: vi.fn(async () => undefined),
		ensureFollowForCommunityFork: vi.fn(async () => undefined),
		getSavedPackageById: vi.fn(),
		loadPackageSourceBySourceId: vi.fn(),
		getCommunityBan: vi.fn(),
		getCommunityListingByOwnerAndPackage: vi.fn(),
		getCommunityListingByOwnerAndKodyId: vi.fn(),
		getCommunityListingById: vi.fn(),
		listCommunityListingCandidates: vi.fn(),
		listCommunityIndexOverviewCandidates: vi.fn(),
		countActiveCommunityListingsByCategory: vi.fn(),
		getCommunityRatingAggregatesByListingIds: vi.fn(),
		countCommunityForksByListingIds: vi.fn(),
		insertCommunityActivityEvent: vi.fn(),
		deleteCommunityActivityEventsByListingId: vi.fn(),
		writeCommunitySnapshot: vi.fn(),
		insertCommunityListing: vi.fn(),
		repointOrphanedCommunityForksToListing: vi.fn(),
		updateCommunityListing: vi.fn(),
		getCommunityForkByListingAndUser: vi.fn(),
		getCommunityForkByForkedPackageId: vi.fn(),
		listCommunityForksByListingAndUser: vi.fn(),
		markCommunityForkAdopted: vi.fn(),
		updateCommunityForkOriginCommit: vi.fn(),
		upsertCommunityRating: vi.fn(),
		insertCommunityReport: vi.fn(),
		getCommunityReportById: vi.fn(),
		readCommunitySnapshot: vi.fn(),
		resolveSavedPackageRef: vi.fn(),
		getSavedPackageByName: vi.fn(),
		updateSavedPackage: vi.fn(),
		ensureEntitySource: vi.fn(),
		getEntitySourceById: vi.fn(),
		syncArtifactSourceSnapshot: vi.fn(),
		forkArtifactRepo: vi.fn(),
		persistForkedArtifactRepoContents: vi.fn(),
		resolveCommunityForkArtifactsGitFallbackTree: vi.fn(
			async (input: {
				preparedFiles: Record<string, string>
				preparedOriginCommit: string
			}) => ({
				files: input.preparedFiles,
				originCommit: input.preparedOriginCommit,
			}),
		),
		deleteEntitySource: vi.fn(),
		cleanupArtifactReposForPackage: vi.fn(),
		deleteUserScopedArtifactRepo: vi.fn(async () => false),
		insertCommunityFork: vi.fn(),
		deleteCommunityForksForPackage: vi.fn(async () => 0),
		deletePackageSlugRedirects: vi.fn(async () => undefined),
		invalidateCommunityPublicCache: vi.fn(),
		deleteCommunityListing: vi.fn(),
		deleteCommunityRatingsByListingId: vi.fn(),
		deleteCommunitySnapshot: vi.fn(),
		setCommunityListingStatus: vi.fn(),
		resolveCommunityReportRow: vi.fn(),
	}
	const pickMocks = (...names: Array<keyof typeof mockModule>) =>
		Object.fromEntries(names.map((name) => [name, mockModule[name]]))
	return { mockModule, pickMocks }
})

vi.mock('./activity-dispatch-queue-producer.ts', () =>
	pickMocks('enqueueCommunityActivityDispatch'),
)
vi.mock('./listing-published-dispatch-queue-producer.ts', () =>
	pickMocks('enqueueCommunityListingPublishedDispatch'),
)
vi.mock('#worker/follow/notify.ts', () =>
	pickMocks('notifyFollowsOfPublishedPackage'),
)
vi.mock('#worker/follow/fork-follow.ts', () =>
	pickMocks('ensureFollowForCommunityFork'),
)
vi.mock('#worker/package-registry/repo.ts', () =>
	pickMocks(
		'getSavedPackageById',
		'resolveSavedPackageRef',
		'getSavedPackageByName',
		'updateSavedPackage',
	),
)
vi.mock('#worker/package-registry/source.ts', () =>
	pickMocks('loadPackageSourceBySourceId'),
)
vi.mock('#worker/repo/source-service.ts', () => pickMocks('ensureEntitySource'))
vi.mock('#worker/repo/source-sync.ts', () =>
	pickMocks('syncArtifactSourceSnapshot'),
)
vi.mock('#worker/repo/artifact-repo-fork.ts', () => ({
	...pickMocks(
		'forkArtifactRepo',
		'persistForkedArtifactRepoContents',
		'resolveCommunityForkArtifactsGitFallbackTree',
	),
	shouldFallbackFromArtifactFork: (error: unknown) =>
		error instanceof Error && /not found/i.test(error.message),
	shouldFallbackFromForkedArtifactPersist: (error: unknown) =>
		error instanceof Error &&
		/Artifacts (?:listServerRefs|git fetch|git clone) failed/i.test(
			error.message,
		),
}))
vi.mock('#worker/repo/entity-sources.ts', () =>
	pickMocks('deleteEntitySource', 'getEntitySourceById'),
)
vi.mock('#worker/repo/artifact-repo-cleanup.ts', () =>
	pickMocks('cleanupArtifactReposForPackage', 'deleteUserScopedArtifactRepo'),
)
vi.mock('./repo.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof CommunityRepo>()
	return {
		// Pure helper used by the service to decide whether the SQL LIKE
		// pre-filter was applied; keep the real implementation.
		extractCommunityListingLikeTokens: actual.extractCommunityListingLikeTokens,
		...pickMocks(
			'getCommunityBan',
			'getCommunityListingByOwnerAndPackage',
			'getCommunityListingByOwnerAndKodyId',
			'getCommunityListingById',
			'listCommunityListingCandidates',
			'listCommunityIndexOverviewCandidates',
			'countActiveCommunityListingsByCategory',
			'getCommunityRatingAggregatesByListingIds',
			'countCommunityForksByListingIds',
			'insertCommunityListing',
			'repointOrphanedCommunityForksToListing',
			'updateCommunityListing',
			'getCommunityForkByListingAndUser',
			'getCommunityForkByForkedPackageId',
			'listCommunityForksByListingAndUser',
			'markCommunityForkAdopted',
			'updateCommunityForkOriginCommit',
			'upsertCommunityRating',
			'insertCommunityReport',
			'getCommunityReportById',
			'insertCommunityFork',
			'deleteCommunityForksForPackage',
			'deleteCommunityListing',
			'deleteCommunityRatingsByListingId',
			'resolveCommunityReportRow',
			'setCommunityListingStatus',
		),
	}
})
vi.mock('./package-url.ts', async (importOriginal) => ({
	...(await importOriginal<typeof PackageUrl>()),
	...pickMocks('deletePackageSlugRedirects'),
}))
vi.mock('#app/data-cache.ts', () => pickMocks('invalidateCommunityPublicCache'))
vi.mock('./snapshot.ts', () =>
	pickMocks(
		'writeCommunitySnapshot',
		'readCommunitySnapshot',
		'deleteCommunitySnapshot',
	),
)
vi.mock('./profile-repo.ts', () =>
	pickMocks(
		'insertCommunityActivityEvent',
		'deleteCommunityActivityEventsByListingId',
	),
)

const {
	publishCommunityListing,
	unpublishCommunityListing,
	rateCommunityListing,
	reportCommunityListing,
	searchCommunityListings,
	listCommunityIndexOverview,
	forkCommunityListing,
	adoptCommunityFork,
	inspectCommunityForkAdoption,
	absorbCommunityForkUpstream,
} = await import('./service.ts')

const testBundleArtifactsKv = {
	get: vi.fn(async () => null),
	delete: vi.fn(async () => undefined),
	list: vi.fn(async () => ({
		keys: [{ name: 'derived-cache:v1:community-icon:v1:listing-1:commit-1' }],
		list_complete: true,
	})),
} as unknown as KVNamespace
const testCommunityAssetsDelete = vi.fn<R2Bucket['delete']>(
	async () => undefined,
)
const testCommunityAssets = {
	delete: testCommunityAssetsDelete,
	list: vi.fn(async () => ({
		objects: [
			{ key: 'community-icon:v1/listing-1/commit-1/asset' },
			{ key: 'community-icon:v1/listing-1/commit-2/asset' },
		],
		truncated: false,
	})),
} as unknown as R2Bucket
const testCommunityActivityQueue = {
	send: vi.fn(),
} as unknown as Queue
const testCommunityListingPublishedQueue = {
	send: vi.fn(),
} as unknown as Queue

function createEnv() {
	return {
		APP_DB: {} as D1Database,
		BUNDLE_ARTIFACTS_KV: testBundleArtifactsKv,
		COMMUNITY_ASSETS: testCommunityAssets,
		COMMUNITY_ACTIVITY_DISPATCH_QUEUE: testCommunityActivityQueue,
		COMMUNITY_LISTING_PUBLISHED_DISPATCH_QUEUE:
			testCommunityListingPublishedQueue,
	} as Env
}

function createEnvWithUsername(username: string) {
	return {
		...createEnv(),
		APP_DB: {
			prepare: () => ({
				bind: () => ({
					first: async () => ({ username }),
				}),
			}),
		} as unknown as D1Database,
	} as Env
}

function sampleListing(
	overrides: Partial<CommunityListingRecord> = {},
): CommunityListingRecord {
	return {
		id: 'listing-1',
		ownerUserId: ownerIdFromStored('owner-1'),
		packageId: 'package-1',
		sourceId: 'source-1',
		kodyId: 'discord-gateway',
		name: '@owner/discord-gateway',
		description: 'Discord gateway helpers',
		tags: ['discord', 'gateway'],
		category: 'integrations',
		searchText: 'websocket bot',
		readmeContent: '# Discord Gateway\n\n## Intent\n\nBridge Discord events.',
		license: 'MIT',
		pinnedCommit: 'commit-1',
		iconCommit: 'commit-1',
		status: 'active',
		trustedCommit: null,
		trustedAt: null,
		trusted: false,
		featuredAt: null,
		featured: false,
		createdAt: '2026-07-01T00:00:00.000Z',
		updatedAt: '2026-07-01T00:00:00.000Z',
		publishedAt: '2026-07-01T00:00:00.000Z',
		...overrides,
	}
}

function validPublishSource() {
	return {
		source: {
			id: 'source-1',
			published_commit: 'commit-1',
		},
		manifest: {
			name: '@owner/discord-gateway',
			exports: { '.': './src/index.ts' },
			kody: {
				id: 'discord-gateway',
				description: 'Discord helpers',
			},
		},
		files: {
			'package.json': JSON.stringify({
				name: '@owner/discord-gateway',
				version: '1.0.4',
				license: 'MIT',
				exports: { '.': './src/index.ts' },
				kody: {
					id: 'discord-gateway',
					description: 'Discord helpers',
				},
			}),
			'README.md': '# Discord Gateway\n\n## Intent\n\nBridge Discord events.',
		} as Record<string, string>,
	}
}

function validSavedPackage() {
	return {
		id: 'package-1',
		userId: ownerIdFromStored('user-1'),
		name: '@owner/discord-gateway',
		kodyId: 'discord-gateway',
		description: 'Discord helpers',
		tags: ['discord'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		createdAt: '2026-07-01T00:00:00.000Z',
		updatedAt: '2026-07-01T00:00:00.000Z',
	}
}

function forkedSavedPackage() {
	return {
		...validSavedPackage(),
		id: 'package-fork-1',
		userId: ownerIdFromStored('user-2'),
		kodyId: 'discord-gateway-fork',
		name: '@jane/discord-gateway-fork',
	}
}

function forkRecord(overrides: Record<string, unknown> = {}) {
	return {
		id: 'fork-1',
		listingId: 'listing-1',
		forkerUserId: 'user-2',
		originCommit: 'commit-1',
		forkedPackageId: 'package-fork-1',
		forkedSourceId: 'fork-source-1',
		targetKodyId: 'discord-gateway-fork',
		createdAt: '2026-07-01T00:00:00.000Z',
		adoptedAt: null,
		adoptionNote: null,
		...overrides,
	}
}

function mockPublishable() {
	mockModule.getCommunityBan.mockResolvedValue(null)
	mockModule.getSavedPackageById.mockResolvedValue(validSavedPackage())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(validPublishSource())
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue(null)
	mockModule.insertCommunityListing.mockResolvedValue(undefined)
	mockModule.writeCommunitySnapshot.mockResolvedValue(undefined)
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())
}

function publish(overrides: Record<string, unknown> = {}) {
	return publishCommunityListing({
		env: createEnv(),
		baseUrl: 'https://heykody.dev',
		userId: ownerIdFromStored('user-1'),
		packageId: 'package-1',
		...overrides,
	})
}

function mockForkable(
	files: Record<string, string> = validPublishSource().files,
) {
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())
	mockModule.readCommunitySnapshot.mockResolvedValue({
		version: 1,
		listingId: 'listing-1',
		pinnedCommit: 'commit-1',
		createdAt: '2026-07-01T00:00:00.000Z',
		files,
	})
	mockModule.resolveSavedPackageRef.mockResolvedValue(null)
	mockModule.getSavedPackageByName.mockResolvedValue(null)
	mockModule.listCommunityForksByListingAndUser.mockResolvedValue([])
	mockModule.ensureEntitySource.mockResolvedValue({
		id: 'fork-source-1',
		bootstrapAccess: { token: 'bootstrap' },
	})
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue('commit-fork-1')
	mockModule.cleanupArtifactReposForPackage.mockResolvedValue(0)
	mockModule.deleteEntitySource.mockResolvedValue(true)
}

function fork(overrides: Record<string, unknown> = {}) {
	return forkCommunityListing({
		env: createEnv(),
		baseUrl: 'https://heykody.dev',
		userId: ownerIdFromStored('user-2'),
		expectedPackageScope: 'jane',
		listingId: 'listing-1',
		...overrides,
	})
}

function forkSnapshotFiles(dependencies: unknown, indexSource: string) {
	return {
		'package.json': JSON.stringify(
			{
				name: '@owner/discord-gateway',
				license: 'MIT',
				exports: { '.': './src/index.ts' },
				kody: {
					id: 'discord-gateway',
					description: 'Discord helpers',
					dependencies,
				},
			},
			null,
			'\t',
		),
		'src/index.ts': indexSource,
		'README.md': '# Discord Gateway\n\n## Intent\n\nBridge events.',
	}
}

function isActionError(message: string | RegExp) {
	return (error: unknown) =>
		error instanceof CommunityActionError &&
		(typeof message === 'string'
			? error.message.includes(message)
			: message.test(error.message))
}

test('community operations reject banned users', async () => {
	const ban = {
		userId: ownerIdFromStored('user-1'),
		bannedByUserId: 'admin-1',
		reason: 'spam',
		createdAt: '2026-07-01T00:00:00.000Z',
	}
	mockModule.getCommunityBan.mockResolvedValue(ban)

	await expect(publish()).rejects.toThrow(/banned from community participation/)
	await expect(fork()).rejects.toThrow(/banned from community participation/)

	// Org-owned publishes bind bans to the acting person too: the owning org
	// is not banned, but the banned actor must still be rejected.
	mockModule.getCommunityBan.mockImplementation(
		async (_db: unknown, userId: unknown) => (userId === 'user-1' ? ban : null),
	)
	await expect(
		publish({
			userId: ownerIdFromStored('org-owner-1'),
			actorUserId: 'user-1',
		}),
	).rejects.toThrow(/banned from community participation/)
	// communityFork keys the fork by the bound org; the banned person
	// acting for that org must still be rejected.
	await expect(
		fork({
			userId: ownerIdFromStored('org-owner-1'),
			creatorUserId: 'user-1',
		}),
	).rejects.toThrow(/banned from community participation/)
	await expect(
		unpublishCommunityListing({
			env: createEnv(),
			userId: ownerIdFromStored('org-owner-1'),
			actorUserId: 'user-1',
			listingId: 'listing-1',
		}),
	).rejects.toThrow(/banned from community participation/)
})

test('publishCommunityListing rolls back D1 when KV snapshot write fails', async () => {
	mockPublishable()
	mockModule.deleteCommunityListing.mockResolvedValue(true)
	const insertCallOrder: Array<string> = []
	mockModule.insertCommunityListing.mockImplementation(async () => {
		insertCallOrder.push('insert')
	})
	mockModule.writeCommunitySnapshot.mockImplementation(async () => {
		insertCallOrder.push('snapshot')
		throw new Error('kv down')
	})

	await expect(publish()).rejects.toThrow('kv down')
	expect(insertCallOrder).toEqual(['insert', 'snapshot'])
	expect(mockModule.deleteCommunityListing).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ ownerUserId: ownerIdFromStored('user-1') }),
	)

	const existingListing = sampleListing({ version: '1.0.3' })
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue(
		existingListing,
	)
	mockModule.updateCommunityListing.mockResolvedValue(true)

	await expect(publish()).rejects.toThrow('kv down')
	expect(mockModule.updateCommunityListing).toHaveBeenCalledTimes(2)
	expect(mockModule.updateCommunityListing).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.objectContaining({
			listingId: existingListing.id,
			packageVersion: '1.0.3',
			pinnedCommit: existingListing.pinnedCommit,
			publishedAt: existingListing.publishedAt,
		}),
	)
})

test('a failed publish gives the listing it displaced its page back', async () => {
	mockPublishable()
	mockModule.getSavedPackageById.mockImplementation(
		async (_db: unknown, input: { packageId: string }) =>
			input.packageId === 'package-1' ? validSavedPackage() : null,
	)
	// A stranded listing (its package is gone) holds the pair being published.
	mockModule.getCommunityListingByOwnerAndKodyId.mockResolvedValue(
		sampleListing({ id: 'listing-stranded', packageId: 'package-gone' }),
	)
	mockModule.updateCommunityListing.mockResolvedValue(true)
	mockModule.insertCommunityListing.mockRejectedValue(new Error('d1 down'))

	await expect(publish()).rejects.toThrow('d1 down')

	// Delisted to free the pair, then relisted -- nothing else can relist it.
	expect(
		mockModule.updateCommunityListing.mock.calls.map((call) => call[1]),
	).toEqual([
		expect.objectContaining({
			listingId: 'listing-stranded',
			status: 'delisted',
		}),
		expect.objectContaining({
			listingId: 'listing-stranded',
			status: 'active',
		}),
	])
})

test('unpublishCommunityListing refuses delisted, missing, and unowned listings without deleting anything', async () => {
	const unpublish = (listingId = 'listing-1') =>
		unpublishCommunityListing({
			env: createEnv(),
			userId: ownerIdFromStored('owner-1'),
			listingId,
		})

	mockModule.getCommunityListingById.mockResolvedValue(
		sampleListing({ status: 'delisted' }),
	)
	await expect(unpublish()).rejects.toBeInstanceOf(CommunityActionError)

	mockModule.getCommunityListingById.mockResolvedValue(null)
	await expect(unpublish('missing-listing')).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof CommunityActionError &&
			error.message === 'Catalog entry "missing-listing" was not found.',
	)

	mockModule.getCommunityListingById.mockResolvedValue(
		sampleListing({ ownerUserId: ownerIdFromStored('other-owner') }),
	)
	await expect(unpublish()).rejects.toBeInstanceOf(CommunityActionError)

	expect(mockModule.deleteCommunityListing).not.toHaveBeenCalled()
	expect(mockModule.deleteCommunityRatingsByListingId).not.toHaveBeenCalled()
	expect(mockModule.deleteCommunitySnapshot).not.toHaveBeenCalled()
})

test('publish and adopt treat missing packages as CommunityActionError', async () => {
	mockModule.getCommunityBan.mockResolvedValue(null)
	mockModule.getSavedPackageById.mockResolvedValue(null)
	const notFound = isActionError(
		'Saved package "missing-package" was not found',
	)

	await expect(
		publish({
			userId: ownerIdFromStored('owner-1'),
			packageId: 'missing-package',
		}),
	).rejects.toSatisfy(notFound)
	expect(mockModule.loadPackageSourceBySourceId).not.toHaveBeenCalled()

	await expect(
		adoptCommunityFork({
			env: createEnv(),
			userId: ownerIdFromStored('owner-1'),
			packageId: 'missing-package',
			reviewSummary: 'Reviewed the fork source and trust the upstream listing.',
		}),
	).rejects.toSatisfy(notFound)
	expect(mockModule.getCommunityForkByForkedPackageId).not.toHaveBeenCalled()
})

test('unpublishCommunityListing deletes active listings and cascades cleanup', async () => {
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())
	mockModule.deleteCommunityListing.mockResolvedValue(true)
	testCommunityAssetsDelete.mockRejectedValue(new Error('r2 unavailable'))
	consoleError.mockImplementation(() => {})

	await unpublishCommunityListing({
		env: createEnv(),
		userId: ownerIdFromStored('owner-1'),
		listingId: 'listing-1',
	})

	expect(mockModule.deleteCommunityListing).toHaveBeenCalledWith(
		expect.anything(),
		{ listingId: 'listing-1', ownerUserId: ownerIdFromStored('owner-1') },
	)
	for (const cascade of [
		mockModule.deleteCommunityRatingsByListingId,
		mockModule.deleteCommunityActivityEventsByListingId,
		mockModule.deleteCommunitySnapshot,
	]) {
		expect(cascade).toHaveBeenCalledWith(expect.anything(), 'listing-1')
	}
	expect(
		mockModule.deleteCommunityListing.mock.invocationCallOrder[0],
	).toBeLessThan(testCommunityAssetsDelete.mock.invocationCallOrder[0] ?? 0)
	expect(consoleError).toHaveBeenCalledWith(
		'community-icon-delete-failed',
		'unpublish',
		'listing-1',
		expect.any(Error),
	)
})

function emptyAggregates(ids: Array<string>) {
	return Object.fromEntries(
		ids.map((listingId) => [
			listingId,
			{
				listingId,
				ratingCount: 0,
				averageStars: null,
				averageAdaptationEffort: null,
			},
		]),
	)
}

test('searchCommunityListings empty query uses publishedAt tiebreaker', async () => {
	mockModule.listCommunityListingCandidates.mockResolvedValue([
		sampleListing({
			id: 'listing-older',
			publishedAt: '2026-07-01T00:00:00.000Z',
		}),
		sampleListing({
			id: 'listing-newer',
			publishedAt: '2026-07-03T00:00:00.000Z',
		}),
	])
	mockModule.getCommunityRatingAggregatesByListingIds.mockResolvedValue(
		emptyAggregates(['listing-older', 'listing-newer']),
	)
	mockModule.countCommunityForksByListingIds.mockResolvedValue({
		'listing-older': 0,
		'listing-newer': 0,
	})

	const results = await searchCommunityListings({
		env: createEnv(),
		query: '',
		limit: 10,
	})

	expect(results.map((listing) => listing.id)).toEqual([
		'listing-newer',
		'listing-older',
	])
})

test('searchCommunityListings answers a no-match query from the LIKE prefilter alone', async () => {
	// The prefilter can return rows (for example a substring hit deep in the
	// readme) that the term scorer rejects. That is a real no-results answer:
	// no second unfiltered read and no unrelated listings.
	const prefilterOnlyListing = sampleListing({
		id: 'listing-prefilter-only',
		kodyId: 'meal-planner',
		name: '@owner/meal-planner',
		description: 'Plan weekly meals',
		tags: ['meal'],
		searchText: 'meal plan grocery',
		readmeContent: '# Meal Planner\n\n## Intent\n\nPlan meals.',
	})
	mockModule.listCommunityListingCandidates.mockResolvedValueOnce([
		prefilterOnlyListing,
	])
	mockModule.getCommunityRatingAggregatesByListingIds.mockResolvedValue({})
	mockModule.countCommunityForksByListingIds.mockResolvedValue({})

	const results = await searchCommunityListings({
		env: createEnv(),
		query: 'discord',
		limit: 10,
	})

	expect(results).toEqual([])
	expect(mockModule.listCommunityListingCandidates).toHaveBeenCalledTimes(1)
	expect(mockModule.listCommunityListingCandidates).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ query: 'discord' }),
	)
})

test('listCommunityIndexOverview batches populated categories and uses SQL totals', async () => {
	const integrationListings = Array.from({ length: 8 }, (_, index) =>
		sampleListing({
			id: `listing-integration-${index}`,
			kodyId: `integration-${index}`,
			name: `@owner/integration-${index}`,
			publishedAt: `2026-07-0${index + 1}T00:00:00.000Z`,
		}),
	)
	const utilityListing = sampleListing({
		id: 'listing-utility',
		kodyId: 'utility-one',
		name: '@owner/utility-one',
		category: 'utilities',
		tags: ['helper'],
	})
	mockModule.countActiveCommunityListingsByCategory.mockResolvedValue({
		integrations: 40,
		examples: 0,
		productivity: 0,
		apps: 0,
		utilities: 2,
		other: 0,
	})
	mockModule.listCommunityIndexOverviewCandidates.mockResolvedValue([
		...integrationListings,
		utilityListing,
	])
	mockModule.getCommunityRatingAggregatesByListingIds.mockResolvedValue({})
	mockModule.countCommunityForksByListingIds.mockResolvedValue({})

	const overview = await listCommunityIndexOverview({
		env: createEnv(),
		sort: 'newest',
	})

	expect(mockModule.listCommunityListingCandidates).not.toHaveBeenCalled()
	expect(mockModule.listCommunityIndexOverviewCandidates).toHaveBeenCalledTimes(
		1,
	)
	expect(mockModule.listCommunityIndexOverviewCandidates).toHaveBeenCalledWith(
		expect.anything(),
		{
			limitPerCategory: communityIndexOverviewCandidateLimitPerCategory,
			categories: ['integrations', 'utilities'],
		},
	)
	expect(
		mockModule.getCommunityRatingAggregatesByListingIds,
	).toHaveBeenCalledTimes(1)
	expect(mockModule.countCommunityForksByListingIds).toHaveBeenCalledTimes(1)
	expect(overview.groups.map((group) => [group.category, group.total])).toEqual(
		[
			['integrations', 40],
			['utilities', 2],
		],
	)
	expect(overview.groups[0]?.listings).toHaveLength(6)
	expect(overview.listings).toHaveLength(7)
	expect(overview.categoryCounts.integrations).toBe(40)
	expect(overview.categoryCounts.examples).toBe(0)
})

test('publishCommunityListing stores long README content and drops binary icon bytes from snapshots', async () => {
	mockPublishable()
	const source = validPublishSource()
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		...source,
		files: {
			...source.files,
			'README.md': `${'x'.repeat(20_000)}\n\n## Intent\n\nBridge Discord events.`,
			'.kody/icon.svg':
				'<svg xmlns="http://www.w3.org/2000/svg"><circle /></svg>',
			'.kody/icon.png': 'binary bytes decoded as text',
			'community-icon.png': 'binary bytes decoded as text',
			'community-icon.jpg': 'extra binary bytes decoded as text',
			'icons/icon-192.png': 'package-app pwa icon bytes',
		},
	})

	await publish()

	expect(mockModule.insertCommunityListing).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			readme_content: expect.stringContaining('## Intent'),
			category: 'integrations',
			package_version: '1.0.4',
		}),
	)
	expect(mockModule.writeCommunitySnapshot).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			communityIconPath: '.kody/icon.svg',
			files: expect.objectContaining({
				'.kody/icon.svg':
					'<svg xmlns="http://www.w3.org/2000/svg"><circle /></svg>',
				'icons/icon-192.png': 'package-app pwa icon bytes',
			}),
		}),
	)
	expect(mockModule.writeCommunitySnapshot).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			files: expect.not.objectContaining({
				'.kody/icon.png': expect.anything(),
				'community-icon.png': expect.anything(),
				'community-icon.jpg': expect.anything(),
			}),
		}),
	)
})

test('publishCommunityListing enqueues listing.published only on first publish', async () => {
	mockPublishable()
	mockModule.getCommunityListingById.mockImplementation(
		async (_db: unknown, input: { listingId: string }) =>
			sampleListing({ id: input.listingId }),
	)
	mockModule.insertCommunityActivityEvent.mockResolvedValue(undefined)

	await publish()

	const insertedListingId = mockModule.insertCommunityListing.mock.calls[0]?.[1]
		?.id as string
	expect(insertedListingId).toEqual(expect.any(String))
	expect(mockModule.insertCommunityActivityEvent).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			eventType: 'listing_published',
			listingId: insertedListingId,
		}),
	)
	expect(
		mockModule.enqueueCommunityListingPublishedDispatch,
	).toHaveBeenCalledWith({
		queue: expect.anything(),
		listingId: insertedListingId,
	})

	mockModule.enqueueCommunityListingPublishedDispatch.mockClear()
	mockModule.insertCommunityActivityEvent.mockClear()
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue(
		sampleListing({ id: insertedListingId }),
	)
	mockModule.updateCommunityListing.mockResolvedValue(true)
	mockModule.getCommunityListingById.mockResolvedValue(
		sampleListing({ id: insertedListingId, pinnedCommit: 'commit-2' }),
	)
	const republishedSource = validPublishSource()
	republishedSource.source.published_commit = 'commit-2'
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(republishedSource)

	await publish()

	expect(mockModule.insertCommunityActivityEvent).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			eventType: 'listing_updated',
			listingId: insertedListingId,
		}),
	)
	expect(
		mockModule.enqueueCommunityListingPublishedDispatch,
	).not.toHaveBeenCalled()
})

test('publishCommunityListing notifies follows only when a republish moves the pinned commit', async () => {
	mockPublishable()
	mockModule.insertCommunityActivityEvent.mockResolvedValue(undefined)

	await publish()
	expect(mockModule.notifyFollowsOfPublishedPackage).not.toHaveBeenCalled()

	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue(
		sampleListing({ pinnedCommit: 'commit-1', version: '1.0.4' }),
	)
	mockModule.updateCommunityListing.mockResolvedValue(true)
	await publish()
	expect(mockModule.notifyFollowsOfPublishedPackage).not.toHaveBeenCalled()

	const republishedSource = validPublishSource()
	republishedSource.source.published_commit = 'commit-2'
	republishedSource.files['package.json'] = JSON.stringify({
		...JSON.parse(republishedSource.files['package.json'] ?? '{}'),
		version: '1.1.0',
	})
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(republishedSource)
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue(
		sampleListing({ pinnedCommit: 'commit-1', version: null }),
	)
	await publish()

	expect(mockModule.notifyFollowsOfPublishedPackage).toHaveBeenCalledTimes(1)
	expect(mockModule.notifyFollowsOfPublishedPackage).toHaveBeenCalledWith({
		env: expect.anything(),
		ownerId: ownerIdFromStored('user-1'),
		packageId: 'package-1',
		previousCommit: 'commit-1',
		publishedCommit: 'commit-2',
		publishedAt: expect.any(String),
		listing: {
			listingId: 'listing-1',
			previous: { pinnedCommit: 'commit-1', packageVersion: null },
			current: { pinnedCommit: 'commit-2', packageVersion: '1.1.0' },
		},
	})
	expect(
		mockModule.enqueueCommunityListingPublishedDispatch,
	).toHaveBeenCalledTimes(1)
})

test('publishCommunityListing does not fail when follow notify fails', async () => {
	consoleError.mockImplementation(() => {})
	mockPublishable()
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue(
		sampleListing({ pinnedCommit: 'commit-0' }),
	)
	mockModule.updateCommunityListing.mockResolvedValue(true)
	mockModule.notifyFollowsOfPublishedPackage.mockRejectedValueOnce(
		new Error('follow notify failed'),
	)

	await expect(publish()).resolves.toMatchObject({ id: 'listing-1' })
	expect(consoleError).toHaveBeenCalledWith(
		'follow-published-notify-failed',
		'listing-1',
		expect.any(Error),
	)
})

test('publishCommunityListing invalidates old and reused icon revisions', async () => {
	mockPublishable()
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue(
		sampleListing(),
	)
	const republishedSource = validPublishSource()
	republishedSource.source.published_commit = 'commit-2'
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(republishedSource)
	mockModule.updateCommunityListing.mockResolvedValue(true)
	mockModule.getCommunityListingById.mockResolvedValue(
		sampleListing({ pinnedCommit: 'commit-2' }),
	)

	await publish()

	expect(testCommunityAssets.delete).toHaveBeenCalledWith(
		'community-icon:v1/listing-1/commit-1/asset',
	)
	expect(testCommunityAssets.delete).toHaveBeenCalledWith(
		'community-icon:v1/listing-1/commit-2/asset',
	)
})

test('publishCommunityListing does not fail when listing.published enqueue fails', async () => {
	consoleError.mockImplementation(() => {})
	mockPublishable()
	mockModule.enqueueCommunityListingPublishedDispatch.mockRejectedValue(
		new Error('queue unavailable'),
	)

	await expect(publish()).resolves.toMatchObject({ id: 'listing-1' })
	expect(consoleError).toHaveBeenCalledWith(
		'community-listing-published-dispatch-enqueue-failed',
		expect.any(Error),
	)
})

test('rateCommunityListing requires a prior non-owner fork and persists valid ratings', async () => {
	mockModule.getCommunityBan.mockResolvedValue(null)
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())
	mockModule.upsertCommunityRating.mockResolvedValue({
		id: 'rating-1',
		listingId: 'listing-1',
		userId: ownerIdFromStored('user-2'),
		stars: 5,
		adaptationEffort: 2,
		note: null,
		createdAt: '2026-07-01T00:00:00.000Z',
		updatedAt: '2026-07-01T00:00:00.000Z',
	})
	const rate = (userId: string) =>
		rateCommunityListing({
			env: createEnv(),
			userId: ownerIdFromStored(userId),
			listingId: 'listing-1',
			stars: 5,
			adaptationEffort: 2,
		})

	mockModule.getCommunityForkByListingAndUser.mockResolvedValue(null)
	await expect(rate('user-2')).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof CommunityActionError &&
			error.message === 'Fork this public package before rating it.',
	)

	mockModule.getCommunityForkByListingAndUser.mockResolvedValue(
		forkRecord({ forkerUserId: 'owner-1', targetKodyId: 'discord-gateway' }),
	)
	await expect(rate('owner-1')).rejects.toBeInstanceOf(CommunityActionError)
	expect(mockModule.upsertCommunityRating).not.toHaveBeenCalled()

	mockModule.getCommunityForkByListingAndUser.mockResolvedValue(
		forkRecord({ targetKodyId: 'discord-gateway' }),
	)
	await rate('user-2')

	expect(mockModule.upsertCommunityRating).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			listing_id: 'listing-1',
			user_id: ownerIdFromStored('user-2'),
			stars: 5,
			adaptation_effort: 2,
		}),
	)
	expect(mockModule.enqueueCommunityActivityDispatch).toHaveBeenCalledWith({
		queue: expect.anything(),
		kind: 'rating',
		activityId: 'rating-1',
	})
})

test('rateCommunityListing finds a fork owned by the rater org when it differs from the person id', async () => {
	// New signups have a personal org id distinct from their person id
	// (#3053). communityFork keys the fork row by that org; the rating
	// stays person-keyed.
	mockModule.getCommunityBan.mockResolvedValue(null)
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())
	mockModule.upsertCommunityRating.mockResolvedValue({
		id: 'rating-1',
		listingId: 'listing-1',
		userId: ownerIdFromStored('person-2'),
		stars: 4,
		adaptationEffort: 1,
		note: null,
		createdAt: '2026-07-01T00:00:00.000Z',
		updatedAt: '2026-07-01T00:00:00.000Z',
	})
	mockModule.getCommunityForkByListingAndUser.mockImplementation(
		async (_db: unknown, input: { userId: string }) =>
			input.userId === 'org-2'
				? forkRecord({ forkerUserId: 'org-2', targetKodyId: 'discord-gateway' })
				: null,
	)

	await rateCommunityListing({
		env: createEnv(),
		userId: ownerIdFromStored('person-2'),
		forkOwnerId: ownerIdFromStored('org-2'),
		listingId: 'listing-1',
		stars: 4,
		adaptationEffort: 1,
	})

	expect(mockModule.upsertCommunityRating).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			listing_id: 'listing-1',
			user_id: ownerIdFromStored('person-2'),
		}),
	)
})

test('rateCommunityListing rejects rating a listing the rater org owns', async () => {
	mockModule.getCommunityBan.mockResolvedValue(null)
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())
	mockModule.getCommunityForkByListingAndUser.mockResolvedValue(
		forkRecord({ targetKodyId: 'discord-gateway' }),
	)

	await expect(
		rateCommunityListing({
			env: createEnv(),
			userId: ownerIdFromStored('person-1'),
			forkOwnerId: ownerIdFromStored('owner-1'),
			listingId: 'listing-1',
			stars: 5,
			adaptationEffort: 1,
		}),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof CommunityActionError &&
			error.message === 'You cannot rate your own listing.',
	)
	expect(mockModule.upsertCommunityRating).not.toHaveBeenCalled()
})

test('forkCommunityListing follows the upstream package on the forker org', async () => {
	mockForkable()
	mockModule.ensureFollowForCommunityFork.mockClear()
	await fork({
		followerOrgId: ownerIdFromStored('org-personal-2'),
		creatorUserId: 'person-2',
	})
	expect(mockModule.ensureFollowForCommunityFork).toHaveBeenCalledWith({
		env: expect.anything(),
		listingId: 'listing-1',
		followerOrgId: ownerIdFromStored('org-personal-2'),
		creatorUserId: 'person-2',
	})
})

test('forkCommunityListing creates inert source without saved package row', async () => {
	mockForkable(
		forkSnapshotFiles(
			{ '@owner/shared-utils': '*' },
			`import { x } from 'kody:@owner/shared-utils/x'\n`,
		),
	)

	const result = await fork({ kodyId: 'my-discord-gateway' })

	expect(result.targetKodyId).toBe('my-discord-gateway')
	expect(result.targetName).toBe('@jane/my-discord-gateway')
	expect(result.crossScopeReferences).toEqual([
		{ file: 'package.json', specifier: '@owner/shared-utils' },
		{ file: 'src/index.ts', specifier: 'kody:@owner/' },
	])
	expect(mockModule.ensureEntitySource).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-2'),
			entityKind: 'package',
		}),
	)
	expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenCalled()
	expect(mockModule.insertCommunityFork).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			target_kody_id: 'my-discord-gateway',
			listing_name: '@owner/discord-gateway',
			listing_kody_id: 'discord-gateway',
		}),
	)
	expect(mockModule.enqueueCommunityActivityDispatch).toHaveBeenCalledWith({
		queue: expect.anything(),
		kind: 'fork',
		activityId: expect.any(String),
	})
})

test('forkCommunityListing rejects stale array-shaped kody.dependencies as CommunityActionError', async () => {
	mockForkable(
		forkSnapshotFiles(['@owner/shared-utils'], `export const x = 1\n`),
	)

	await expect(fork()).rejects.toSatisfy(
		isActionError(/kody\.dependencies must be a map/),
	)
	expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()
	expect(mockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()
})

test('forkCommunityListing rejects a repeat fork without a new kody_id and allows one with a different kody_id', async () => {
	mockForkable()
	mockModule.listCommunityForksByListingAndUser.mockResolvedValue([
		forkRecord({ targetKodyId: 'discord-gateway' }),
	])

	await expect(fork()).rejects.toThrow(
		'You already forked this listing as package name "discord-gateway". Resume the existing fork with source_id "fork-source-1" (package_id "package-fork-1") via repoOpenSession, or pass a different package name leaf to fork again.',
	)
	expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()

	const result = await fork({ kodyId: 'my-second-fork' })
	expect(result.targetKodyId).toBe('my-second-fork')
	expect(mockModule.insertCommunityFork).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ target_kody_id: 'my-second-fork' }),
	)
})

test('forkCommunityListing auto-picks a free leaf when an unrelated same-leaf package exists', async () => {
	mockForkable()
	const unrelatedSameLeaf = {
		...validSavedPackage(),
		id: 'package-unrelated',
		userId: ownerIdFromStored('user-2'),
		name: '@jane/discord-gateway',
		kodyId: 'discord-gateway',
		sourceId: 'source-unrelated',
	}
	mockModule.resolveSavedPackageRef.mockImplementation(
		async (_db: unknown, input: { ref: string }) => {
			if (input.ref === 'discord-gateway') return unrelatedSameLeaf
			return null
		},
	)
	mockModule.getSavedPackageByName.mockImplementation(
		async (_db: unknown, input: { name: string }) => {
			if (input.name === '@jane/discord-gateway') return unrelatedSameLeaf
			return null
		},
	)

	const result = await fork()

	expect(result.targetKodyId).toBe('discord-gateway-2')
	expect(result.targetName).toBe('@jane/discord-gateway-2')
	expect(mockModule.insertCommunityFork).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ target_kody_id: 'discord-gateway-2' }),
	)
})

test('forkCommunityListing skips taken alternates and still rejects an explicit colliding leaf', async () => {
	mockForkable()
	const taken = new Map([
		[
			'discord-gateway',
			{
				...validSavedPackage(),
				id: 'package-unrelated',
				userId: ownerIdFromStored('user-2'),
				name: '@jane/discord-gateway',
				kodyId: 'discord-gateway',
			},
		],
		[
			'discord-gateway-2',
			{
				...validSavedPackage(),
				id: 'package-alt',
				userId: ownerIdFromStored('user-2'),
				name: '@jane/discord-gateway-2',
				kodyId: 'discord-gateway-2',
			},
		],
	])
	mockModule.resolveSavedPackageRef.mockImplementation(
		async (_db: unknown, input: { ref: string }) =>
			taken.get(input.ref) ?? null,
	)
	mockModule.getSavedPackageByName.mockImplementation(
		async (_db: unknown, input: { name: string }) => {
			const leaf = input.name.split('/')[1]
			return leaf ? (taken.get(leaf) ?? null) : null
		},
	)

	const result = await fork()
	expect(result.targetKodyId).toBe('discord-gateway-3')

	await expect(fork({ kodyId: 'discord-gateway' })).rejects.toThrow(
		'You already have a saved package named "discord-gateway". Pass a different package name leaf to fork this listing.',
	)
})

test('forkCommunityListing does not auto-pick past a real fork of the listing', async () => {
	mockForkable()
	mockModule.listCommunityForksByListingAndUser.mockResolvedValue([
		forkRecord({ targetKodyId: 'discord-gateway' }),
	])
	const publishedFork = {
		...forkedSavedPackage(),
		kodyId: 'discord-gateway',
		name: '@jane/discord-gateway',
	}
	mockModule.resolveSavedPackageRef.mockResolvedValue(publishedFork)
	mockModule.getSavedPackageByName.mockResolvedValue(publishedFork)

	await expect(fork()).rejects.toThrow(
		'You already have a saved package named "discord-gateway". Pass a different package name leaf to fork this listing.',
	)
	expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()
})

test('forkCommunityListing rejects a repeat default fork after an alternate leaf was used', async () => {
	mockForkable()
	const unrelatedSameLeaf = {
		...validSavedPackage(),
		id: 'package-unrelated',
		userId: ownerIdFromStored('user-2'),
		name: '@jane/discord-gateway',
		kodyId: 'discord-gateway',
		sourceId: 'source-unrelated',
	}
	mockModule.resolveSavedPackageRef.mockImplementation(
		async (_db: unknown, input: { ref: string }) => {
			if (input.ref === 'discord-gateway') return unrelatedSameLeaf
			return null
		},
	)
	mockModule.getSavedPackageByName.mockImplementation(
		async (_db: unknown, input: { name: string }) => {
			if (input.name === '@jane/discord-gateway') return unrelatedSameLeaf
			return null
		},
	)
	mockModule.listCommunityForksByListingAndUser.mockResolvedValue([
		forkRecord({
			targetKodyId: 'discord-gateway-2',
			forkedSourceId: 'fork-source-alt',
			forkedPackageId: 'package-fork-alt',
		}),
	])

	await expect(fork()).rejects.toThrow(
		'You already forked this listing as package name "discord-gateway-2". Resume the existing fork with source_id "fork-source-alt" (package_id "package-fork-alt") via repoOpenSession, or pass a different package name leaf to fork again.',
	)
	expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()

	const explicit = await fork({ kodyId: 'discord-gateway-3' })
	expect(explicit.targetKodyId).toBe('discord-gateway-3')
})

test('forkCommunityListing cleans up entity source when snapshot sync fails', async () => {
	mockForkable()
	mockModule.syncArtifactSourceSnapshot.mockRejectedValue(
		new Error('sync failed'),
	)
	consoleWarn.mockImplementation(() => {})

	await expect(fork({ kodyId: 'my-discord-gateway' })).rejects.toThrow(
		'sync failed',
	)

	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining('community fork dest artifact repo cleanup failed'),
	)
	expect(mockModule.deleteUserScopedArtifactRepo).toHaveBeenCalledWith({
		env: createEnv(),
		userId: ownerIdFromStored('user-2'),
		repoName: expect.stringMatching(/^package-/),
	})
	expect(mockModule.cleanupArtifactReposForPackage).toHaveBeenCalledWith({
		env: createEnv(),
		userId: ownerIdFromStored('user-2'),
		sourceId: 'fork-source-1',
	})
	expect(mockModule.deleteEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		{ id: 'fork-source-1', userId: ownerIdFromStored('user-2') },
	)
	expect(mockModule.deleteCommunityForksForPackage).toHaveBeenCalledWith(
		expect.anything(),
		{
			userId: ownerIdFromStored('user-2'),
			packageId: expect.any(String),
			sourceId: 'fork-source-1',
		},
	)
	expect(mockModule.deletePackageSlugRedirects).toHaveBeenCalledWith({
		db: expect.anything(),
		userId: ownerIdFromStored('user-2'),
		packageId: expect.any(String),
	})
	expect(mockModule.insertCommunityFork).not.toHaveBeenCalled()
})

test('forkCommunityListing removes the community_forks row when persist fails after writing it', async () => {
	mockForkable()
	mockModule.insertCommunityFork.mockResolvedValue(undefined)
	mockModule.invalidateCommunityPublicCache.mockImplementationOnce(() => {
		throw new Error('cache invalidate failed')
	})
	mockModule.deleteCommunityForksForPackage.mockResolvedValue(1)
	mockModule.deleteUserScopedArtifactRepo.mockResolvedValueOnce(true)
	consoleWarn.mockImplementation(() => {})

	await expect(fork({ kodyId: 'my-discord-gateway' })).rejects.toThrow(
		'cache invalidate failed',
	)

	expect(mockModule.insertCommunityFork).toHaveBeenCalled()
	expect(mockModule.deleteCommunityForksForPackage).toHaveBeenCalledWith(
		expect.anything(),
		{
			userId: ownerIdFromStored('user-2'),
			packageId: expect.any(String),
			sourceId: 'fork-source-1',
		},
	)
	expect(mockModule.deletePackageSlugRedirects).toHaveBeenCalledWith({
		db: expect.anything(),
		userId: ownerIdFromStored('user-2'),
		packageId: expect.any(String),
	})
})

test('forkCommunityListing copies at the Artifacts layer when the origin repo exists', async () => {
	mockForkable()
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'origin-source-1',
		repo_id: 'package-origin-1',
		published_commit: 'commit-1',
	})
	mockModule.forkArtifactRepo.mockResolvedValue({
		id: 'repo-fork',
		name: 'package-dest',
	})
	mockModule.ensureEntitySource.mockResolvedValue({
		id: 'fork-source-1',
		repo_id: 'package-dest',
		user_id: ownerIdFromStored('user-2'),
	})
	mockModule.persistForkedArtifactRepoContents.mockResolvedValue({
		copiedOriginCommit: 'commit-head',
		destCommit: 'commit-rewritten',
	})

	const result = await fork({ kodyId: 'my-discord-gateway' })

	expect(result.filesCount).toBeGreaterThan(0)
	expect(mockModule.forkArtifactRepo).toHaveBeenCalledWith(
		expect.objectContaining({ sourceRepoId: 'package-origin-1' }),
	)
	expect(mockModule.persistForkedArtifactRepoContents).toHaveBeenCalledWith(
		expect.objectContaining({
			originCommit: 'commit-1',
			expectedPackageScope: 'jane',
			targetKodyId: 'my-discord-gateway',
			changedFiles: expect.objectContaining({
				'package.json': expect.any(String),
			}),
		}),
	)
	expect(mockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()
	expect(mockModule.insertCommunityFork).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ origin_commit: 'commit-head' }),
	)
	expect(result.originCommit).toBe('commit-head')
})

test('forkCommunityListing falls back to full-tree sync when forked dest git clone fails', async () => {
	mockForkable()
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'origin-source-1',
		repo_id: 'package-origin-1',
		published_commit: 'commit-1',
	})
	mockModule.forkArtifactRepo.mockResolvedValue({
		id: 'repo-fork',
		name: 'package-dest',
	})
	mockModule.ensureEntitySource
		.mockResolvedValueOnce({
			id: 'fork-source-1',
			repo_id: 'package-dest',
			user_id: ownerIdFromStored('user-2'),
		})
		.mockResolvedValueOnce({
			id: 'fork-source-1',
			repo_id: 'package-dest',
			user_id: ownerIdFromStored('user-2'),
			bootstrapAccess: {
				remote: 'https://example.test/dest.git',
				token: 'bootstrap',
				defaultBranch: 'main',
				expiresAt: '2099-01-01T00:00:00.000Z',
			},
		})
	mockModule.persistForkedArtifactRepoContents.mockRejectedValue(
		new Error(
			'Artifacts git clone failed for https://example.test/dest.git: HTTP Error: 500 Internal Server Error',
		),
	)
	mockModule.deleteUserScopedArtifactRepo.mockResolvedValueOnce(true)
	const fallbackFiles = {
		'package.json':
			'{"name":"@jane/my-discord-gateway","version":"1.0.0","type":"module","kody":{"id":"my-discord-gateway"}}',
		'README.md': '# newer dest HEAD',
		'src/index.ts': 'export default async function main() {}',
	}
	mockModule.resolveCommunityForkArtifactsGitFallbackTree.mockResolvedValueOnce(
		{
			files: fallbackFiles,
			originCommit: 'commit-dest-head',
		},
	)
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue('commit-fallback')

	const result = await fork({ kodyId: 'my-discord-gateway' })

	expect(mockModule.persistForkedArtifactRepoContents).toHaveBeenCalled()
	expect(mockModule.deleteUserScopedArtifactRepo).toHaveBeenCalledWith({
		env: createEnv(),
		userId: ownerIdFromStored('user-2'),
		repoName: expect.stringMatching(/^package-/),
		waitUntilAbsent: true,
	})
	expect(mockModule.ensureEntitySource).toHaveBeenCalledTimes(2)
	expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'fork-source-1',
			bootstrapAccess: expect.objectContaining({ token: 'bootstrap' }),
			runPublishChecks: false,
			files: fallbackFiles,
		}),
	)
	expect(mockModule.insertCommunityFork).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ origin_commit: 'commit-dest-head' }),
	)
	expect(result.originCommit).toBe('commit-dest-head')
	expect(result.files).toBe(fallbackFiles)
	expect(result.filesCount).toBe(Object.keys(fallbackFiles).length)
})

test('forkCommunityListing does not insert a fork when fallback snapshot sync returns null', async () => {
	mockForkable()
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'origin-source-1',
		repo_id: 'package-origin-1',
		published_commit: 'commit-1',
	})
	mockModule.forkArtifactRepo.mockResolvedValue({
		id: 'repo-fork',
		name: 'package-dest',
	})
	mockModule.ensureEntitySource
		.mockResolvedValueOnce({
			id: 'fork-source-1',
			repo_id: 'package-dest',
			user_id: ownerIdFromStored('user-2'),
		})
		.mockResolvedValueOnce({
			id: 'fork-source-1',
			repo_id: 'package-dest',
			user_id: ownerIdFromStored('user-2'),
			bootstrapAccess: {
				remote: 'https://example.test/dest.git',
				token: 'bootstrap',
				defaultBranch: 'main',
				expiresAt: '2099-01-01T00:00:00.000Z',
			},
		})
	const destCloneError = new Error(
		'Artifacts git clone failed for https://example.test/dest.git: HTTP Error: 500 Internal Server Error',
	)
	mockModule.persistForkedArtifactRepoContents.mockRejectedValue(destCloneError)
	mockModule.deleteUserScopedArtifactRepo.mockResolvedValueOnce(true)
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue(null)
	consoleWarn.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})

	await expect(fork({ kodyId: 'my-discord-gateway' })).rejects.toThrow(
		/^The package source could not be read after retries \(HTTP 5xx\)\. Report id: /,
	)

	expect(mockModule.insertCommunityFork).not.toHaveBeenCalled()
	expect(mockModule.deleteUserScopedArtifactRepo).toHaveBeenCalledWith({
		env: createEnv(),
		userId: ownerIdFromStored('user-2'),
		repoName: expect.stringMatching(/^package-/),
		waitUntilAbsent: true,
	})
})

test('forkCommunityListing maps isolate memory resets to CommunityForkResourceLimitError', async () => {
	mockForkable()
	mockModule.syncArtifactSourceSnapshot.mockRejectedValue(
		new Error(durableObjectIsolateMemoryResetMessage),
	)
	consoleWarn.mockImplementation(() => {})

	await expect(fork({ kodyId: 'my-discord-gateway' })).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof CommunityForkResourceLimitError &&
			/too large to finish forking/.test(error.message) &&
			!/isolate exceeded/.test(error.message),
	)
	expect(mockModule.insertCommunityFork).not.toHaveBeenCalled()
})

test('reportCommunityListing inserts denormalized listing metadata', async () => {
	mockModule.getCommunityBan.mockResolvedValue(null)
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())
	mockModule.getCommunityReportById.mockResolvedValue({
		id: 'report-1',
		listingId: 'listing-1',
		listingName: '@owner/discord-gateway',
		listingOwnerUserId: 'owner-1',
		reporterUserId: 'user-2',
		reason: 'spam content',
		status: 'open',
		resolvedByUserId: null,
		resolvedAt: null,
		resolutionNote: null,
		createdAt: '2026-07-02T00:00:00.000Z',
		updatedAt: '2026-07-02T00:00:00.000Z',
	})

	const report = await reportCommunityListing({
		env: createEnv(),
		userId: ownerIdFromStored('user-2'),
		listingId: 'listing-1',
		reason: '  spam content  ',
	})

	expect(mockModule.insertCommunityReport).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			listing_name: '@owner/discord-gateway',
			listing_owner_user_id: 'owner-1',
			reporter_user_id: 'user-2',
			reason: 'spam content',
		}),
	)
	expect(report.listingName).toBe('@owner/discord-gateway')
})

function adopt(reviewSummary: string, overrides: Record<string, unknown> = {}) {
	return adoptCommunityFork({
		env: createEnv(),
		userId: ownerIdFromStored('user-2'),
		packageId: 'package-fork-1',
		reviewSummary,
		...overrides,
	})
}

test('adoptCommunityFork marks a fork adopted with review note', async () => {
	const note = 'Reviewed gateway auth and host allowlists.'
	mockModule.getSavedPackageById.mockResolvedValue(forkedSavedPackage())
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValue(forkRecord())
	mockModule.markCommunityForkAdopted.mockResolvedValue(
		forkRecord({ adoptedAt: '2026-07-21T00:00:00.000Z', adoptionNote: note }),
	)

	await expect(adopt(note)).resolves.toMatchObject({
		packageId: 'package-fork-1',
		kodyId: 'discord-gateway-fork',
		listingId: 'listing-1',
		originCommit: 'commit-1',
		alreadyAdopted: false,
	})
	expect(mockModule.markCommunityForkAdopted).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			forkerUserId: 'user-2',
			forkedPackageId: 'package-fork-1',
			adoptionNote: note,
		}),
	)
})

test('adoptCommunityFork rejects self-authored packages and short review summaries', async () => {
	mockModule.getSavedPackageById.mockResolvedValue(validSavedPackage())
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValue(null)
	const own = { userId: ownerIdFromStored('user-1'), packageId: 'package-1' }

	await expect(adopt('Looks fine', own)).rejects.toThrow(
		/already self-authored/,
	)
	await expect(adopt('short', own)).rejects.toThrow(/review note/)
})

test('adoptCommunityFork is idempotent when already adopted and isolates by user', async () => {
	mockModule.getSavedPackageById.mockResolvedValue(forkedSavedPackage())
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValue(
		forkRecord({
			adoptedAt: '2026-07-10T00:00:00.000Z',
			adoptionNote: 'Earlier review.',
		}),
	)

	const result = await adopt('Reviewed again after more edits.')
	expect(result.alreadyAdopted).toBe(true)
	expect(result.adoptedAt).toBe('2026-07-10T00:00:00.000Z')
	expect(mockModule.markCommunityForkAdopted).not.toHaveBeenCalled()

	mockModule.getSavedPackageById.mockResolvedValue(null)
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValue(null)
	await expect(
		adopt('Trying to adopt someone else fork.', {
			userId: ownerIdFromStored('user-b'),
		}),
	).rejects.toThrow(/was not found/)
	expect(mockModule.markCommunityForkAdopted).not.toHaveBeenCalled()
})

test('adoptCommunityFork keeps the first adoption when a concurrent adopt wins', async () => {
	mockModule.getSavedPackageById.mockResolvedValue(forkedSavedPackage())
	mockModule.getCommunityForkByForkedPackageId
		.mockResolvedValueOnce(forkRecord())
		.mockResolvedValueOnce(
			forkRecord({
				adoptedAt: '2026-07-10T00:00:00.000Z',
				adoptionNote: 'First tab review note.',
			}),
		)
	mockModule.markCommunityForkAdopted.mockResolvedValue(null)

	await expect(adopt('Second tab review note.')).resolves.toMatchObject({
		alreadyAdopted: true,
		adoptedAt: '2026-07-10T00:00:00.000Z',
	})
	expect(mockModule.markCommunityForkAdopted).toHaveBeenCalledOnce()
})

test('inspectCommunityForkAdoption reports adoption state without writing and rejects foreign scopes before lookup', async () => {
	const inspect = (kodyId: string) =>
		inspectCommunityForkAdoption({
			env: createEnvWithUsername('jane'),
			userId: ownerIdFromStored('user-2'),
			kodyId,
		})

	await expect(inspect('@other/discord-gateway-fork')).rejects.toSatisfy(
		isActionError('does not match the acting owner "@jane"'),
	)
	expect(mockModule.resolveSavedPackageRef).not.toHaveBeenCalled()

	mockModule.resolveSavedPackageRef.mockResolvedValue(forkedSavedPackage())
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValue(forkRecord())
	await expect(inspect('discord-gateway-fork')).resolves.toEqual({
		packageId: 'package-fork-1',
		kodyId: 'discord-gateway-fork',
		ownerScope: 'jane',
		listingId: 'listing-1',
		originCommit: 'commit-1',
		adoptedAt: null,
	})
	expect(mockModule.markCommunityForkAdopted).not.toHaveBeenCalled()
})

test('absorbCommunityForkUpstream records the current listing pin and is idempotent', async () => {
	const absorb = () =>
		absorbCommunityForkUpstream({
			env: createEnv(),
			userId: ownerIdFromStored('user-2'),
			packageId: 'package-fork-1',
		})
	mockModule.getSavedPackageById.mockResolvedValue(forkedSavedPackage())
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValue(forkRecord())
	mockModule.getCommunityListingById.mockResolvedValue(
		sampleListing({ pinnedCommit: 'commit-2' }),
	)
	mockModule.updateCommunityForkOriginCommit.mockResolvedValue(
		forkRecord({ originCommit: 'commit-2' }),
	)

	await expect(absorb()).resolves.toEqual({
		packageId: 'package-fork-1',
		kodyId: 'discord-gateway-fork',
		listingId: 'listing-1',
		originCommit: 'commit-2',
		listingPinnedCommit: 'commit-2',
		alreadyAbsorbed: false,
	})
	expect(mockModule.updateCommunityForkOriginCommit).toHaveBeenCalledWith(
		expect.anything(),
		{
			forkerUserId: 'user-2',
			forkedPackageId: 'package-fork-1',
			originCommit: 'commit-2',
		},
	)

	mockModule.getCommunityForkByForkedPackageId.mockResolvedValue(
		forkRecord({ originCommit: 'commit-2' }),
	)
	mockModule.updateCommunityForkOriginCommit.mockClear()
	expect((await absorb()).alreadyAbsorbed).toBe(true)
	expect(mockModule.updateCommunityForkOriginCommit).not.toHaveBeenCalled()

	mockModule.getCommunityForkByForkedPackageId.mockResolvedValue(null)
	await expect(absorb()).rejects.toThrow(/self-authored/)
})
