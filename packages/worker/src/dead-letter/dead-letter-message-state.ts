import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const deadLetterMessageState = defineStateMachine({
	name: 'dead_letter_messages.status',
	description:
		'Messages park, claim or reclaim replay, and return to parked on release; successful replay deletes the row.',
	initial: 'parked',
	transitions: {
		parked: ['parked', 'replaying'],
		replaying: ['parked', 'replaying'],
	},
})

export type DeadLetterMessageStatus = StateOf<typeof deadLetterMessageState>
