import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'
import type { FormFlowState } from '#client/state-machine-store.ts'

export const passwordResetState = defineStateMachine({
	name: 'password_reset.form',
	description:
		'Password reset requests and confirmations submit once, display their result and clear old feedback on retry.',
	initial: 'idle',
	transitions: {
		idle: ['submitting', 'error'],
		submitting: ['success', 'error'],
		success: ['submitting', 'error'],
		error: ['submitting', 'error'],
	},
})
export type PasswordResetState = FormFlowState<
	StateOf<typeof passwordResetState>
>
