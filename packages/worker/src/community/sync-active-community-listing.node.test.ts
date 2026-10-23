import { expect, test, vi } from 'vitest'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'

const mockModule = vi.hoisted(() => ({
	getCommunityListingByOwnerAndPackage: vi.fn(),
	publishCommunityListing: vi.fn(),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingByOwnerAndPackage:
		mockModule.getCommunityListingByOwnerAndPackage,
}))

vi.mock('#worker/community/service.ts', () => ({
	publishCommunityListing: mockModule.publishCommunityListing,
}))

const { syncActiveCommunityListingToPublishedCommit } =
	await import('./sync-active-community-listing.ts')

function env() {
	return {
		APP_DB: {
			prepare: () => {
				throw new Error('APP_DB.prepare should be mocked via repo helpers')
			},
		},
	} as unknown as Env
}

test('syncActiveCommunityListingToPublishedCommit skips when the pin already matches', async () => {
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue({
		id: 'listing-1',
		status: 'active',
		pinnedCommit: 'abc1234',
	})
	await expect(
		syncActiveCommunityListingToPublishedCommit({
			env: env(),
			baseUrl: 'https://kody.codes',
			ownerUserId: ownerIdFromStored('user-1'),
			packageId: 'pkg-1',
			publishedCommit: 'abc1234',
		}),
	).resolves.toBe('skipped')
	expect(mockModule.publishCommunityListing).not.toHaveBeenCalled()
})

test('syncActiveCommunityListingToPublishedCommit republishes when the pin lags', async () => {
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue({
		id: 'listing-1',
		status: 'active',
		pinnedCommit: 'old-commit',
	})
	mockModule.publishCommunityListing.mockResolvedValue({ id: 'listing-1' })
	await expect(
		syncActiveCommunityListingToPublishedCommit({
			env: env(),
			baseUrl: 'https://kody.codes',
			ownerUserId: ownerIdFromStored('user-1'),
			packageId: 'pkg-1',
			publishedCommit: 'new-commit',
			actorUserId: 'actor-1',
		}),
	).resolves.toBe('synced')
	expect(mockModule.publishCommunityListing).toHaveBeenCalledWith({
		env: expect.anything(),
		baseUrl: 'https://kody.codes',
		userId: ownerIdFromStored('user-1'),
		actorUserId: 'actor-1',
		packageId: 'pkg-1',
	})
})
