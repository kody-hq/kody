import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { applySavedPackageForkListingAncestry } from './fork-listing-relation.ts'
import type { SavedPackageWithCommunityProvenanceRecord } from '#worker/package-registry/types.ts'

const mocks = vi.hoisted(() => ({
	getCommunityListingById: vi.fn(),
	getEntitySourceById: vi.fn(),
	listingPinIsAncestorOfForkTip: vi.fn(),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingById: (...args: Array<unknown>) =>
		mocks.getCommunityListingById(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mocks.getEntitySourceById(...args),
}))

vi.mock('#worker/community/fork-listing-ancestry.ts', () => ({
	listingPinIsAncestorOfForkTip: (...args: Array<unknown>) =>
		mocks.listingPinIsAncestorOfForkTip(...args),
}))

function forkRecord(
	overrides: Partial<SavedPackageWithCommunityProvenanceRecord> = {},
): SavedPackageWithCommunityProvenanceRecord {
	return {
		id: 'pkg-1',
		userId: ownerIdFromStored('user-1'),
		name: '@me/github',
		kodyId: 'github',
		description: 'Fork',
		tags: [],
		searchText: null,
		sourceId: 'src-1',
		hasApp: false,
		hasSkills: false,
		hidden: false,
		isPrivate: true,
		isInternetVisible: false,
		lockedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		sourceListingId: 'listing-1',
		listingCurrent: true,
		listingKodyId: 'github',
		listingName: '@kentcdodds/github',
		originCommit: 'commit-old',
		listingPinnedCommit: 'commit-new',
		listingPublishedAt: '2026-01-02T00:00:00.000Z',
		listingAhead: false,
		forkListingRelation: 'ahead',
		...overrides,
	}
}

test('package provenance enrichment marks outdated only when the pin is not an ancestor', async () => {
	const synced = await applySavedPackageForkListingAncestry({
		env: { APP_DB: {} } as Env,
		records: [
			forkRecord({
				originCommit: 'commit-same',
				listingPinnedCommit: 'commit-same',
			}),
		],
	})
	expect(synced[0]).toMatchObject({
		listingAhead: false,
		forkListingRelation: 'synced',
	})
	expect(mocks.getEntitySourceById).not.toHaveBeenCalled()
	expect(mocks.getCommunityListingById).not.toHaveBeenCalled()

	mocks.getCommunityListingById.mockResolvedValue({
		id: 'listing-1',
		sourceId: 'listing-source-1',
	})
	mocks.getEntitySourceById.mockResolvedValue({
		repo_id: 'listing-origin-repo',
		published_commit: 'unrelated-fork-sha',
	})
	const resolvedRepoIds: Array<string | null> = []
	mocks.listingPinIsAncestorOfForkTip.mockImplementation(
		async (input: { resolveOriginRepoId: () => Promise<string | null> }) => {
			resolvedRepoIds.push(await input.resolveOriginRepoId())
			return true
		},
	)
	const ahead = await applySavedPackageForkListingAncestry({
		env: { APP_DB: {} } as Env,
		records: [forkRecord({ originCommit: 'commit-tip' })],
	})
	expect(ahead[0]).toMatchObject({
		listingAhead: false,
		forkListingRelation: 'ahead',
	})
	expect(mocks.getCommunityListingById).toHaveBeenCalledWith(
		expect.anything(),
		{
			listingId: 'listing-1',
			includeDelisted: false,
		},
	)
	expect(mocks.getEntitySourceById).toHaveBeenCalledWith(
		expect.anything(),
		'listing-source-1',
	)
	expect(mocks.listingPinIsAncestorOfForkTip).toHaveBeenCalledWith({
		env: expect.anything(),
		listingPinnedCommit: 'commit-new',
		forkTip: 'commit-tip',
		resolveOriginRepoId: expect.any(Function),
	})
	expect(resolvedRepoIds).toEqual(['listing-origin-repo'])

	mocks.listingPinIsAncestorOfForkTip.mockReset()
	mocks.listingPinIsAncestorOfForkTip.mockResolvedValue(false)
	const outdated = await applySavedPackageForkListingAncestry({
		env: { APP_DB: {} } as Env,
		records: [forkRecord()],
	})
	expect(outdated[0]).toMatchObject({
		listingAhead: true,
		forkListingRelation: 'outdated',
	})
})
