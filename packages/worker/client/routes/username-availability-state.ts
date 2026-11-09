import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'
export const usernameAvailabilityState = defineStateMachine({
	name: 'username.availability_ui',
	description:
		'Editing resets or checks a candidate; only the current check may publish a result, and empty or invalid drafts cannot receive old results.',
	initial: 'idle',
	transitions: {
		idle: ['idle', 'checking', 'invalid'],
		checking: [
			'idle',
			'checking',
			'available',
			'taken',
			'reserved',
			'invalid',
			'unknown',
		],
		available: ['idle', 'checking', 'invalid'],
		taken: ['idle', 'checking', 'invalid'],
		reserved: ['idle', 'checking', 'invalid'],
		invalid: ['idle', 'checking', 'invalid'],
		unknown: ['idle', 'checking', 'invalid'],
	},
})
type Status = StateOf<typeof usernameAvailabilityState>
export type UsernameAvailabilityView =
	| { status: 'idle' | 'checking' }
	| {
			status: Exclude<Status, 'idle' | 'checking'>
			username: string
			reason: string | null
			suggestions: Array<string>
	  }
