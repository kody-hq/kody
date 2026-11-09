import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const followState = defineStateMachine({
	name: 'follows.status',
	description:
		'Active follows pause when delivery access fails and resume after a creator reauthorizes them.',
	initial: 'active',
	transitions: { active: ['paused'], paused: ['active'] },
})

export type FollowStatus = StateOf<typeof followState>
