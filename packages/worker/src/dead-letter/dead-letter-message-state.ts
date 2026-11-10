import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const deadLetterMessageState = setup({
	types: {
		events: {} as { type: 'PARK' } | { type: 'CLAIM_REPLAY' },
	},
}).createMachine({
	id: 'dead_letter_messages.status',
	description:
		'Messages park, claim or reclaim replay, and return to parked on release; successful replay deletes the row.',
	initial: 'parked',
	states: {
		parked: { on: { PARK: 'parked', CLAIM_REPLAY: 'replaying' } },
		replaying: { on: { PARK: 'parked', CLAIM_REPLAY: 'replaying' } },
	},
})

export type DeadLetterMessageStatus = LifecycleStateOf<
	typeof deadLetterMessageState
>
