import { setup, types } from 'xstate'
import {
	resetUi,
	startUi,
	updateUi,
	type UiContext,
	type UiEvent,
	type FormFlowState,
} from '#client/ui-actor.ts'
export type AuthFormState = FormFlowState<
	'idle' | 'confirming' | 'submitting' | 'success' | 'error'
>

export const loginState = setup({
	schemas: {
		context: types<UiContext<AuthFormState>>(),
		events: {
			SUBMIT: types<UiEvent<AuthFormState, 'submitting'>>(),
			CONFIRM_USERNAME: types<UiEvent<AuthFormState, 'confirming'>>(),
			VALIDATION_ERROR: types<UiEvent<AuthFormState, 'error'>>(),
			RESPONSE_ERROR: types<UiEvent<AuthFormState, 'error'>>(),
			RESPONSE_OK: types<UiEvent<AuthFormState, 'success'>>(),
			RESET: types<UiEvent<AuthFormState, 'idle'>>(),
			CANCEL: types<UiEvent<AuthFormState, 'idle'>>(),
		},
	},
	guards: { currentRequest: (a: unknown, b: unknown) => a === b },
}).createMachine({
	id: 'login.form',
	description:
		'Password, provider and passkey sign-in share one submission fence, retryable errors and username-confirmation feedback.',
	initial: 'idle',
	context: { data: {}, requestId: undefined },
	states: {
		idle: {
			on: {
				SUBMIT: { target: 'submitting', context: startUi },
				CONFIRM_USERNAME: { target: 'confirming', context: updateUi },
				VALIDATION_ERROR: { target: 'error', context: updateUi },
			},
		},
		confirming: {
			on: {
				SUBMIT: { target: 'submitting', context: startUi },
				CONFIRM_USERNAME: { target: 'confirming', context: updateUi },
				VALIDATION_ERROR: { target: 'error', context: updateUi },
				RESET: { target: 'idle', context: resetUi },
			},
		},
		submitting: {
			on: {
				RESPONSE_ERROR: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'error', context: { data: event.data } }
				},
				RESPONSE_OK: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'success', context: { data: event.data } }
				},
				CANCEL: { target: 'idle', context: resetUi },
			},
		},
		success: {
			on: {
				SUBMIT: { target: 'submitting', context: startUi },
				VALIDATION_ERROR: { target: 'error', context: updateUi },
				RESET: { target: 'idle', context: resetUi },
			},
		},
		error: {
			on: {
				SUBMIT: { target: 'submitting', context: startUi },
				CONFIRM_USERNAME: { target: 'confirming', context: updateUi },
				VALIDATION_ERROR: { target: 'error', context: updateUi },
				RESET: { target: 'idle', context: resetUi },
			},
		},
	},
})
