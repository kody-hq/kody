import { setup, types } from 'xstate'
import {
	startUi,
	updateUi,
	type UiContext,
	type UiEvent,
	type FormFlowState,
} from '#client/ui-actor.ts'
export type PasswordResetState = FormFlowState<
	'idle' | 'submitting' | 'success' | 'error'
>

export const passwordResetState = setup({
	schemas: {
		context: types<UiContext<PasswordResetState>>(),
		events: {
			SUBMIT: types<UiEvent<PasswordResetState, 'submitting'>>(),
			VALIDATION_ERROR: types<UiEvent<PasswordResetState, 'error'>>(),
			RESPONSE_OK: types<UiEvent<PasswordResetState, 'success'>>(),
			RESPONSE_ERROR: types<UiEvent<PasswordResetState, 'error'>>(),
		},
	},
	guards: { currentRequest: (a: unknown, b: unknown) => a === b },
}).createMachine({
	id: 'password_reset.form',
	description:
		'Password reset requests and confirmations submit once, display their result and clear old feedback on retry.',
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
				RESPONSE_OK: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'success', context: { data: event.data } }
				},
				RESPONSE_ERROR: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'error', context: { data: event.data } }
				},
			},
		},
		success: {
			on: {
				SUBMIT: { target: 'submitting', context: startUi },
				VALIDATION_ERROR: { target: 'error', context: updateUi },
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
