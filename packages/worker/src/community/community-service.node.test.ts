import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import { CommunityActionError } from './errors.ts'
import type * as CommunityRepo from './repo.ts'
import type * as PackageUrl from './package-url.ts'
import type { CommunityListingRecord } from './types.ts'

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
		getCommunityRatingAggregatesByListingIds: vi.fn(),
		countCommunityForksByListingIds: vi.fn(),
		insertCommunityActivityEvent: vi.fn(),
		deleteCommunityActivityEventsByListingId: vi.fn(),
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
		isAppStarterPackage: vi.fn(async () => false),
		resolveArtifactSourceHead: vi.fn(async () => ({
			commit: null as string | null,
			branch: 'main',
		})),
		readArtifactTreeAtCommit: vi.fn(
			async () => null as Record<string, string> | null,
		),
		readArtifactSourceSnapshot: vi.fn(async () => null),
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
vi.mock('#worker/app-starters/repo.ts', () => pickMocks('isAppStarterPackage'))
vi.mock('#worker/repo/entity-sources.ts', () =>
	pickMocks('deleteEntitySource', 'getEntitySourceById'),
)
vi.mock('#worker/repo/artifact-repo-cleanup.ts', () =>
	pickMocks('cleanupArtifactReposForPackage', 'deleteUserScopedArtifactRepo'),
)
vi.mock('#worker/repo/artifacts.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#worker/repo/artifacts.ts')>()
	return {
		...actual,
		resolveArtifactSourceHead: mockModule.resolveArtifactSourceHead,
	}
})
vi.mock('#worker/repo/artifact-file.ts', () =>
	pickMocks('readArtifactTreeAtCommit'),
)
vi.mock('#worker/repo/artifact-source-snapshot.ts', () =>
	pickMocks('readArtifactSourceSnapshot'),
)
vi.mock('./repo.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof CommunityRepo>()
	return {
		// Pure helper; keep the real implementation.
		extractCommunityListingLikeTokens: actual.extractCommunityListingLikeTokens,
		...pickMocks(
			'getCommunityBan',
			'getCommunityListingByOwnerAndPackage',
			'getCommunityListingByOwnerAndKodyId',
			'getCommunityListingById',
			'listCommunityListingCandidates',
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
vi.mock('./snapshot.ts', () => pickMocks('deleteCommunitySnapshot'))
vi.mock('./profile-repo.ts', () =>
	pickMocks(
		'insertCommunityActivityEvent',
		'deleteCommunityActivityEventsByListingId',
	),
)

const {
	publishCommunityListing,
	unpublishCommunityListing,
	resolveCommunityReport,
	rateCommunityListing,
	forkCommunityListing,
	adoptCommunityFork,
	inspectCommunityForkAdoption,
	absorbCommunityForkUpstream,
} = await import('./service.ts')

const testBundleArtifactsKvGet = vi.fn<(key: string) => Promise<unknown>>(
	async () => null,
)
const testBundleArtifactsKv = {
	get: testBundleArtifactsKvGet,
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

/**
 * Repo reads/writes are mocked; only `community_fork_claims` (the
 * idempotency guard) runs real SQL so concurrent forks race for real.
 */
function createClaimsDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`CREATE TABLE community_fork_claims (
		owner_id TEXT NOT NULL,
		listing_id TEXT NOT NULL,
		claim_id TEXT NOT NULL,
		requested_kody_id TEXT,
		started_at TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		PRIMARY KEY (owner_id, listing_id)
	)`)
	return createD1FromSqlite(sqlite)
}

const sharedClaimsDb = createClaimsDb()

function createEnv() {
	return {
		APP_DB: sharedClaimsDb,
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
	testBundleArtifactsKvGet.mockImplementation(async (key: string) =>
		key === 'source-snapshot:v1:source-1:commit-1'
			? {
					version: 1,
					sourceId: 'source-1',
					publishedCommit: 'commit-1',
					files,
				}
			: null,
	)
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

test('unpublish and hard delete keep the listing row when the legacy snapshot delete fails', async () => {
	// The row is the only handle a retry or account export has on the key.
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing())
	mockModule.getCommunityReportById.mockResolvedValue({
		id: 'report-1',
		listingId: 'listing-1',
		status: 'open',
	})
	mockModule.deleteCommunityListing.mockResolvedValue(true)
	mockModule.resolveCommunityReportRow.mockResolvedValue(true)
	mockModule.deleteCommunitySnapshot.mockRejectedValue(new Error('kv down'))
	const unpublish = () =>
		unpublishCommunityListing({
			env: createEnv(),
			userId: ownerIdFromStored('owner-1'),
			listingId: 'listing-1',
		})
	const hardDelete = () =>
		resolveCommunityReport({
			env: createEnv(),
			adminUserId: 'admin-1',
			reportId: 'report-1',
			action: 'delete',
		})

	await expect(unpublish()).rejects.toThrow('kv down')
	await expect(hardDelete()).rejects.toThrow('kv down')
	expect(mockModule.deleteCommunityListing).not.toHaveBeenCalled()
	expect(mockModule.resolveCommunityReportRow).not.toHaveBeenCalled()
	expect(mockModule.deleteCommunityRatingsByListingId).not.toHaveBeenCalled()

	mockModule.deleteCommunitySnapshot.mockReset()
	await unpublish()
	await hardDelete()
	expect(
		mockModule.deleteCommunitySnapshot.mock.calls.map((call) => call[1]),
	).toEqual(['listing-1', 'listing-1'])
	const [unpublishSnapshot, deleteSnapshot] =
		mockModule.deleteCommunitySnapshot.mock.invocationCallOrder
	const [unpublishRow, deleteRow] =
		mockModule.deleteCommunityListing.mock.invocationCallOrder
	expect(unpublishSnapshot).toBeLessThan(unpublishRow ?? 0)
	expect(deleteSnapshot).toBeLessThan(deleteRow ?? 0)
	expect(mockModule.resolveCommunityReportRow).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ reportId: 'report-1', status: 'resolved' }),
	)
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

test('forkCommunityListing returns the existing fork for a repeat fork and still allows a different kody_id', async () => {
	mockForkable()
	mockModule.listCommunityForksByListingAndUser.mockResolvedValue([
		forkRecord({ targetKodyId: 'discord-gateway' }),
	])

	const repeat = await fork()
	expect(repeat).toMatchObject({
		alreadyForked: true,
		forkId: 'fork-1',
		packageId: 'package-fork-1',
		sourceId: 'fork-source-1',
		targetKodyId: 'discord-gateway',
		targetName: '@jane/discord-gateway',
	})
	expect(repeat.message).toContain(
		'You already forked this listing as "@jane/discord-gateway"',
	)
	expect(repeat.message).toContain('instead of creating a duplicate')
	// Same leaf passed explicitly is the same fork, not a new one.
	expect(await fork({ kodyId: 'discord-gateway' })).toMatchObject({
		alreadyForked: true,
		forkId: 'fork-1',
	})
	expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()
	expect(mockModule.insertCommunityFork).not.toHaveBeenCalled()

	// A deliberately different name is still a new fork.
	const result = await fork({ kodyId: 'my-second-fork' })
	expect(result.alreadyForked).toBeUndefined()
	expect(result.targetKodyId).toBe('my-second-fork')
	expect(mockModule.insertCommunityFork).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ target_kody_id: 'my-second-fork' }),
	)
})

test('forkCommunityListing concurrent double submit creates one fork and returns it to both callers', async () => {
	mockForkable()
	const forks: Array<ReturnType<typeof forkRecord>> = []
	mockModule.listCommunityForksByListingAndUser.mockImplementation(async () => [
		...forks,
	])
	let releaseSync: () => void = () => {}
	const syncGate = new Promise<void>((resolve) => {
		releaseSync = resolve
	})
	mockModule.syncArtifactSourceSnapshot.mockImplementation(async () => {
		// Hold the first fork mid-flight so the second request overlaps it.
		await syncGate
		return 'commit-fork-1'
	})
	mockModule.insertCommunityFork.mockImplementation(
		async (_db: unknown, row: Record<string, string>) => {
			forks.push(
				forkRecord({
					id: row.id,
					forkedPackageId: row.forked_package_id,
					forkedSourceId: row.forked_source_id,
					targetKodyId: row.target_kody_id,
				}),
			)
		},
	)
	const env = { ...createEnv(), APP_DB: createClaimsDb() } as Env
	const input = {
		env,
		claimPollMs: 5,
		claimWaitMs: 5_000,
	}
	const first = fork(input)
	await vi.waitFor(() =>
		expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenCalledTimes(1),
	)
	const onWaiting = vi.fn()
	const second = fork({ ...input, onWaiting })
	await vi.waitFor(() => expect(onWaiting).toHaveBeenCalledTimes(1))
	releaseSync()
	const [firstResult, secondResult] = await Promise.all([first, second])

	expect(mockModule.insertCommunityFork).toHaveBeenCalledTimes(1)
	expect(mockModule.ensureEntitySource).toHaveBeenCalledTimes(1)
	expect(firstResult.alreadyForked).toBeUndefined()
	expect(secondResult).toMatchObject({
		alreadyForked: true,
		forkId: firstResult.forkId,
		packageId: firstResult.packageId,
		targetKodyId: 'discord-gateway',
	})
	// The claim is released once the fork row exists.
	expect(
		await env.APP_DB.prepare('SELECT COUNT(*) AS n FROM community_fork_claims')
			.bind()
			.first<{ n: number }>(),
	).toEqual({ n: 0 })
})

test('forkCommunityListing reports an in-progress fork instead of starting a second one when the wait runs out', async () => {
	mockForkable()
	const env = { ...createEnv(), APP_DB: createClaimsDb() } as Env
	const { acquireCommunityForkClaim } = await import('./fork-claims.ts')
	expect(
		await acquireCommunityForkClaim(env.APP_DB, {
			ownerId: 'user-2',
			listingId: 'listing-1',
		}),
	).toEqual(expect.any(String))

	await expect(fork({ env, claimPollMs: 5, claimWaitMs: 30 })).rejects.toThrow(
		/already in progress, so a second fork was not started/,
	)
	expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()
	expect(mockModule.insertCommunityFork).not.toHaveBeenCalled()
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

function adopt(reviewSummary: string, overrides: Record<string, unknown> = {}) {
	return adoptCommunityFork({
		env: createEnv(),
		userId: ownerIdFromStored('user-2'),
		packageId: 'package-fork-1',
		reviewSummary,
		...overrides,
	})
}

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

test('forkCommunityListing copies the published revision of a recommended starter, not the branch head', async () => {
	mockForkable()
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		repo_id: null,
		published_commit: 'commit-1',
	})
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		commit: 'commit-unpublished',
		branch: 'main',
	})
	mockModule.isAppStarterPackage.mockResolvedValueOnce(true)

	await fork({ kodyId: 'my-starter' })

	expect(mockModule.isAppStarterPackage).toHaveBeenCalledWith(
		expect.anything(),
		'package-1',
	)
	expect(mockModule.resolveArtifactSourceHead).not.toHaveBeenCalled()
	expect(mockModule.insertCommunityFork).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ origin_commit: 'commit-1' }),
	)
})
