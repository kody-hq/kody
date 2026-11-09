import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'
import type { FormFlowState } from '#client/state-machine-store.ts'
export const emailVerificationState = defineStateMachine({
	name: 'email_verification.feedback',
	description:
		'Resending and checking email verification are exclusive requests; each retry clears the previous feedback.',
	initial: 'idle',
	transitions: {
		idle: ['sending', 'checking'],
		sending: ['idle', 'success', 'error'],
		checking: ['idle', 'success', 'error'],
		success: ['sending', 'checking'],
		error: ['sending', 'checking'],
	},
})
export type EmailVerificationState = FormFlowState<
	StateOf<typeof emailVerificationState>
>
