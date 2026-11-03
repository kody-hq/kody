import { expect, test, vi } from 'vitest'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const mockModule = vi.hoisted(() => ({
	listActiveCommunityListingsBehindPublished: vi.fn(),
	updateCommunityListing: vi.fn(),
	syncActiveCommunityListingToPublishedCommit: vi.fn(),
	getAppBaseUrl: vi.fn(() => 'https://kody.codes'),
}))

vi.mock('#worker/community/repo.ts', () => ({
	listActiveCommunityListingsBehindPublished:
		mockModule.listActiveCommunityListingsBehindPublished,
	updateCommunityListing: mockModule.updateCommunityListing,
}))

vi.mock('#worker/community/sync-active-community-listing.ts', () => ({
	syncActiveCommunityListingToPublishedCommit:
		mockModule.syncActiveCommunityListingToPublishedCommit,
}))

vi.mock('#worker/app-base-url.ts', () => ({
	getAppBaseUrl: mockModule.getAppBaseUrl,
}))

const { backfillCommunityListingsBehindPublished } =
	await import('./listing-behind-backfill.ts')

test('backfillCommunityListingsBehindPublished syncs each behind listing', async () => {
	consoleWarn.mockImplementation(() => {})
	mockModule.listActiveCommunityListingsBehindPublished.mockResolvedValue([
		{
			listing: {
				id: 'listing-1',
				ownerUserId: ownerIdFromStored('user-1'),
				packageId: 'pkg-1',
			},
			publishedCommit: 'new-1',
			publisherPersonId: null,
		},
		{
			listing: {
				id: 'listing-2',
				ownerUserId: ownerIdFromStored('user-2'),
				packageId: 'pkg-2',
			},
			publishedCommit: 'new-2',
			publisherPersonId: 'publisher-2',
		},
	])
	mockModule.syncActiveCommunityListingToPublishedCommit
		.mockResolvedValueOnce('synced')
		.mockRejectedValueOnce(new Error('kv down'))

	await expect(
		backfillCommunityListingsBehindPublished({
			env: { APP_DB: {} } as Env,
		}),
	).resolves.toEqual({ scanned: 2, synced: 1, failed: 1 })
	expect(consoleWarn).toHaveBeenCalled()

	expect(
		mockModule.syncActiveCommunityListingToPublishedCommit,
	).toHaveBeenCalledTimes(2)
	expect(
		mockModule.syncActiveCommunityListingToPublishedCommit,
	).toHaveBeenNthCalledWith(1, {
		env: expect.anything(),
		baseUrl: 'https://kody.codes',
		ownerUserId: ownerIdFromStored('user-1'),
		packageId: 'pkg-1',
		publishedCommit: 'new-1',
	})
	expect(
		mockModule.syncActiveCommunityListingToPublishedCommit,
	).toHaveBeenNthCalledWith(2, {
		env: expect.anything(),
		baseUrl: 'https://kody.codes',
		ownerUserId: ownerIdFromStored('user-2'),
		packageId: 'pkg-2',
		publishedCommit: 'new-2',
		actorUserId: 'publisher-2',
	})
	expect(mockModule.updateCommunityListing).toHaveBeenCalledTimes(1)
	expect(mockModule.updateCommunityListing).toHaveBeenCalledWith(
		expect.anything(),
		{
			listingId: 'listing-2',
			ownerUserId: ownerIdFromStored('user-2'),
		},
	)
})

test('backfillCommunityListingsBehindPublished soft-fails when the scan query rejects', async () => {
	consoleWarn.mockImplementation(() => {})
	mockModule.listActiveCommunityListingsBehindPublished.mockRejectedValue(
		new Error('no such table: community_listings'),
	)

	await expect(
		backfillCommunityListingsBehindPublished({
			env: { APP_DB: {} } as Env,
		}),
	).resolves.toEqual({ scanned: 0, synced: 0, failed: 0 })
	expect(consoleWarn).toHaveBeenCalled()
	expect(
		mockModule.syncActiveCommunityListingToPublishedCommit,
	).not.toHaveBeenCalled()
})
