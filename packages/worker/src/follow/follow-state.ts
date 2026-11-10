import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const followState = setup({
	schemas: { events: { PAUSE: types<{}>(), REAUTHORIZE: types<{}>() } },
}).createMachine({
	id: 'follows.status',
	description:
		'Active follows pause when delivery access fails and resume after a creator reauthorizes them.',
	initial: 'active',
	states: {
		active: { on: { PAUSE: { target: 'paused' } } },
		paused: { on: { REAUTHORIZE: { target: 'active' } } },
	},
})

export type FollowStatus = LifecycleStateOf<typeof followState>
