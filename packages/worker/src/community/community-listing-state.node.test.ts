import { expect, test } from 'vitest'
import { communityListingState } from './community-listing-state.ts'

test('community_listings.status preserves the lifecycle graph', () => {
	expect(communityListingState.initial).toEqual(['active'])
	expect(communityListingState.transitions).toEqual({
		active: ['active', 'delisted'],
		delisted: ['active', 'delisted'],
	})
	expect(communityListingState.terminal).toEqual([])
})
