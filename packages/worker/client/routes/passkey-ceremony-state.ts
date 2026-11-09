import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'
export const passkeyCeremonyState = defineStateMachine({
	name: 'passkey.registration_ui',
	description:
		'A registration owns options and its browser ceremony through server confirmation; other passkey mutations retain native Query state.',
	initial: 'idle',
	transitions: {
		idle: ['requesting'],
		requesting: ['ceremony', 'idle'],
		ceremony: ['idle'],
	},
})
export type PasskeyCeremonyState =
	| { status: 'idle' }
	| {
			status: Exclude<StateOf<typeof passkeyCeremonyState>, 'idle'>
			controller: AbortController
	  }
