import { expect, test } from 'vitest'
import { communityListingState } from './community-listing-state.ts'

test('community_listings.status can delist, republish, and repeat the current value', () => {
	expect(communityListingState.can('active', 'delisted')).toBe(true)
	expect(communityListingState.can('delisted', 'active')).toBe(true)
	expect(communityListingState.can('active', 'active')).toBe(true)
	expect(communityListingState.can('delisted', 'delisted')).toBe(true)
	expect(communityListingState.sql(['active'])).toBe("('active')")
	expect(communityListingState.terminal).toEqual([])
})
