import { setup, types } from 'xstate'
import {
	startUi,
	updateUi,
	type UiContext,
	type UiEvent,
	type FormFlowState,
} from '#client/ui-actor.ts'
export type TwoFactorVerifyState = FormFlowState<
	'idle' | 'submitting' | 'error'
>

export const twoFactorVerifyState = setup({
	schemas: {
		context: types<UiContext<TwoFactorVerifyState>>(),
		events: {
			SUBMIT: types<UiEvent<TwoFactorVerifyState, 'submitting'>>(),
			VALIDATION_ERROR: types<UiEvent<TwoFactorVerifyState, 'error'>>(),
			RESPONSE_ERROR: types<UiEvent<TwoFactorVerifyState, 'error'>>(),
		},
	},
	guards: { currentRequest: (a: unknown, b: unknown) => a === b },
}).createMachine({
	id: 'two_factor_verify.form',
	description:
		'Two-factor verification keeps a single in-flight request, clears failure feedback on retry and stays busy while navigating on success.',
	initial: 'idle',
	context: { data: {}, requestId: undefined },
	states: {
		idle: {
			on: {
				SUBMIT: { target: 'submitting', context: startUi },
				VALIDATION_ERROR: { target: 'error', context: updateUi },
			},
		},
		submitting: {
			on: {
				RESPONSE_ERROR: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'error', context: { data: event.data } }
				},
			},
		},
		error: {
			on: {
				SUBMIT: { target: 'submitting', context: startUi },
				VALIDATION_ERROR: { target: 'error', context: updateUi },
			},
		},
	},
})
