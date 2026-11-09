import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'
import type { FormFlowState } from '#client/state-machine-store.ts'

export const twoFactorVerifyState = defineStateMachine({
	name: 'two_factor_verify.form',
	description:
		'Two-factor verification keeps a single in-flight request, clears failure feedback on retry and stays busy while navigating on success.',
	initial: 'idle',
	transitions: {
		idle: ['submitting', 'error'],
		submitting: ['error'],
		error: ['submitting', 'error'],
	},
})
export type TwoFactorVerifyState = FormFlowState<
	StateOf<typeof twoFactorVerifyState>
>
