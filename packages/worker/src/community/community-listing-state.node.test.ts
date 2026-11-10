import { expect, test } from 'vitest'
import { communityListingState } from './community-listing-state.ts'

test('community_listings.status can delist, republish, and repeat the current value', () => {
	const statuses = ['active', 'delisted'] as const
	expect(communityListingState.values).toEqual([...statuses])
	for (const value of statuses)
		expect(communityListingState.parse(value)).toBe(value)
	expect(communityListingState.sql(['active'])).toBe("('active')")
	expect(communityListingState.is('missing')).toBe(false)
	expect(() => communityListingState.parse('missing')).toThrow(
		'community_listings.status',
	)
})
