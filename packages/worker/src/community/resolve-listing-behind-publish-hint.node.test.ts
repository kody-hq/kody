import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const mockModule = vi.hoisted(() => ({
	getCommunityListingByOwnerAndPackage: vi.fn(),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingByOwnerAndPackage: (...args: Array<unknown>) =>
		mockModule.getCommunityListingByOwnerAndPackage(...args),
}))

const { resolveListingBehindPublishHint } =
	await import('./resolve-listing-behind-publish-hint.ts')

test('resolveListingBehindPublishHint builds the update hint for a lagging listing', async () => {
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue({
		id: 'listing-1',
		status: 'active',
		pinnedCommit: 'commit-old',
		version: '1.4.0',
	})
	await expect(
		resolveListingBehindPublishHint({
			db: {} as D1Database,
			ownerUserId: 'user-1',
			packageId: 'pkg-1',
			ownerUsername: 'danj',
			kodyId: 'hey-email',
			promotedCommit: 'commit-new',
			promotedVersion: '1.5.0',
		}),
	).resolves.toEqual({
		pinnedVersion: '1.4.0',
		promotedVersion: '1.5.0',
		behind: true,
		updateHint: expect.stringContaining('automatically'),
		updateUrl: '/@danj/hey-email/settings#update-public-listing',
	})
})

test('resolveListingBehindPublishHint returns null when the catalog lookup rejects', async () => {
	consoleWarn.mockImplementation(() => {})
	mockModule.getCommunityListingByOwnerAndPackage.mockRejectedValue(
		new Error('D1 unavailable'),
	)
	expect(
		await resolveListingBehindPublishHint({
			db: {} as D1Database,
			ownerUserId: 'user-1',
			packageId: 'pkg-1',
			ownerUsername: 'danj',
			kodyId: 'hey-email',
			promotedCommit: 'commit-new',
			promotedVersion: '1.5.0',
		}),
	).toBeNull()
	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining('listing-behind-hint'),
		'D1 unavailable',
	)
})
