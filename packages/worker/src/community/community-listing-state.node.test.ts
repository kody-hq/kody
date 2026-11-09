import { expect, test } from 'vitest'
import { communityListingState } from './community-listing-state.ts'

test('community_listings.status can delist, republish, and repeat the current value', () => {
	expect(
		communityListingState.is('active') && communityListingState.is('delisted'),
	).toBe(true)
	expect(
		communityListingState.is('delisted') && communityListingState.is('active'),
	).toBe(true)
	expect(
		communityListingState.is('active') && communityListingState.is('active'),
	).toBe(true)
	expect(
		communityListingState.is('delisted') &&
			communityListingState.is('delisted'),
	).toBe(true)
	expect(communityListingState.sql(['active'])).toBe("('active')")
	expect(
		Reflect.ownKeys(communityListingState).filter(
			(key) => key === 'transitions' || key === 'terminal',
		),
	).toEqual([])
})
