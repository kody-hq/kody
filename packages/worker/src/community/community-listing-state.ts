import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const communityListingState = defineStateMachine({
	name: 'community_listings.status',
	description:
		'Listings can be published, delisted or republished; status updates may repeat the current value.',
	initial: 'active',
	transitions: {
		active: ['active', 'delisted'],
		delisted: ['active', 'delisted'],
	},
})

export type CommunityListingStatus = StateOf<typeof communityListingState>
