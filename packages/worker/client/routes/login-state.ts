import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'
import type { FormFlowState } from '#client/state-machine-store.ts'

export const loginState = defineStateMachine({
	name: 'login.form',
	description:
		'Password, provider and passkey sign-in share one submission fence, retryable errors and username-confirmation feedback.',
	initial: 'idle',
	transitions: {
		idle: ['idle', 'confirming', 'submitting', 'error'],
		confirming: ['idle', 'confirming', 'submitting', 'error'],
		submitting: ['idle', 'success', 'error'],
		success: ['idle', 'submitting', 'error'],
		error: ['idle', 'confirming', 'submitting', 'error'],
	},
})
export type AuthFormState = FormFlowState<StateOf<typeof loginState>>
