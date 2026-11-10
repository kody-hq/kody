import { setup, types } from 'xstate'
import {
	resetUi,
	startUi,
	updateUi,
	type UiContext,
	type UiEvent,
	type FormFlowState,
} from '#client/ui-actor.ts'
export type UsernameSignupState = FormFlowState<
	'idle' | 'confirming' | 'submitting' | 'error'
>

export const usernameSignupState = setup({
	schemas: {
		context: types<UiContext<UsernameSignupState>>(),
		events: {
			CONFIRM_USERNAME: types<UiEvent<UsernameSignupState, 'confirming'>>(),
			SUBMIT: types<UiEvent<UsernameSignupState, 'submitting'>>(),
			VALIDATION_ERROR: types<UiEvent<UsernameSignupState, 'error'>>(),
			RESPONSE_ERROR: types<UiEvent<UsernameSignupState, 'error'>>(),
			RESET: types<UiEvent<UsernameSignupState, 'idle'>>(),
		},
	},
	guards: { currentRequest: (a: unknown, b: unknown) => a === b },
}).createMachine({
	id: 'username_signup.form',
	description:
		'A chosen username is confirmed before account creation, with failed submissions retryable without losing the confirmed draft.',
	initial: 'idle',
	context: { data: {}, requestId: undefined },
	states: {
		idle: {
			on: {
				CONFIRM_USERNAME: { target: 'confirming', context: updateUi },
				VALIDATION_ERROR: { target: 'error', context: updateUi },
			},
		},
		confirming: {
			on: {
				CONFIRM_USERNAME: { target: 'confirming', context: updateUi },
				SUBMIT: { target: 'submitting', context: startUi },
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
			},
		},
		error: {
			on: {
				CONFIRM_USERNAME: { target: 'confirming', context: updateUi },
				SUBMIT: { target: 'submitting', context: startUi },
				VALIDATION_ERROR: { target: 'error', context: updateUi },
				RESET: { target: 'idle', context: resetUi },
			},
		},
	},
})
