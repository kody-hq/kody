import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const enablementState = defineStateMachine({
	name: 'enablements.state',
	description:
		'Enablements start on, pause or rewrite a pause cause, resume after access recovers, and turn off permanently.',
	initial: 'on',
	transitions: {
		on: ['paused', 'off'],
		paused: ['paused', 'on', 'off'],
		off: [],
	},
})
export type EnablementState = StateOf<typeof enablementState>
