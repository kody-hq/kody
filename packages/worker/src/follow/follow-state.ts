import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const followState = setup({
	types: {
		events: {} as { type: 'PAUSE' } | { type: 'REAUTHORIZE' },
	},
}).createMachine({
	id: 'follows.status',
	description:
		'Active follows pause when delivery access fails and resume after a creator reauthorizes them.',
	initial: 'active',
	states: {
		active: { on: { PAUSE: 'paused' } },
		paused: { on: { REAUTHORIZE: 'active' } },
	},
})

export type FollowStatus = LifecycleStateOf<typeof followState>
