import { defineStatusEnum } from '@kody-internal/shared/state-machine.ts'

export const communityListingState = defineStatusEnum({
	name: 'community_listings.status',
	description:
		'Listings can be published, delisted or republished; status updates may repeat the current value.',
	values: ['active', 'delisted'],
})

export type CommunityListingStatus =
	(typeof communityListingState.values)[number]
