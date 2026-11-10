import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const deadLetterMessageState = setup({
	schemas: { events: { PARK: types<{}>(), CLAIM_REPLAY: types<{}>() } },
}).createMachine({
	id: 'dead_letter_messages.status',
	description:
		'Messages park, claim or reclaim replay, and return to parked on release; successful replay deletes the row.',
	initial: 'parked',
	states: {
		parked: {
			on: { PARK: { target: 'parked' }, CLAIM_REPLAY: { target: 'replaying' } },
		},
		replaying: {
			on: { PARK: { target: 'parked' }, CLAIM_REPLAY: { target: 'replaying' } },
		},
	},
})

export type DeadLetterMessageStatus = LifecycleStateOf<
	typeof deadLetterMessageState
>
