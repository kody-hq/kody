import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'
import type { FormFlowState } from '#client/state-machine-store.ts'

export const usernameSignupState = defineStateMachine({
	name: 'username_signup.form',
	description:
		'A chosen username is confirmed before account creation, with failed submissions retryable without losing the confirmed draft.',
	initial: 'idle',
	transitions: {
		idle: ['idle', 'confirming', 'error'],
		confirming: ['idle', 'confirming', 'submitting', 'error'],
		submitting: ['error'],
		error: ['idle', 'confirming', 'submitting', 'error'],
	},
})
export type UsernameSignupState = FormFlowState<
	StateOf<typeof usernameSignupState>
>
