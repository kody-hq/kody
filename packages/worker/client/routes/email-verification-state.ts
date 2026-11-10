import { setup, types } from 'xstate'
import {
	resetUi,
	startUi,
	type UiContext,
	type UiEvent,
	type FormFlowState,
} from '#client/ui-actor.ts'
export type EmailVerificationState = FormFlowState<
	'idle' | 'sending' | 'checking' | 'success' | 'error'
>

export const emailVerificationState = setup({
	schemas: {
		context: types<UiContext<EmailVerificationState>>(),
		events: {
			RESEND: types<UiEvent<EmailVerificationState, 'sending'>>(),
			CHECK: types<UiEvent<EmailVerificationState, 'checking'>>(),
			RESPONSE_OK: types<UiEvent<EmailVerificationState, 'success'>>(),
			RESPONSE_ERROR: types<UiEvent<EmailVerificationState, 'error'>>(),
			CANCEL: types<UiEvent<EmailVerificationState, 'idle'>>(),
		},
	},
	guards: { currentRequest: (a: unknown, b: unknown) => a === b },
}).createMachine({
	id: 'email_verification.feedback',
	description:
		'Resending and checking email verification are exclusive requests; each retry clears the previous feedback.',
	initial: 'idle',
	context: { data: {}, requestId: undefined },
	states: {
		idle: {
			on: {
				RESEND: { target: 'sending', context: startUi },
				CHECK: { target: 'checking', context: startUi },
			},
		},
		sending: {
			on: {
				RESPONSE_OK: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'success', context: { data: event.data } }
				},
				RESPONSE_ERROR: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'error', context: { data: event.data } }
				},
				CANCEL: { target: 'idle', context: resetUi },
			},
		},
		checking: {
			on: {
				RESPONSE_OK: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'success', context: { data: event.data } }
				},
				RESPONSE_ERROR: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'error', context: { data: event.data } }
				},
				CANCEL: { target: 'idle', context: resetUi },
			},
		},
		success: {
			on: {
				RESEND: { target: 'sending', context: startUi },
				CHECK: { target: 'checking', context: startUi },
			},
		},
		error: {
			on: {
				RESEND: { target: 'sending', context: startUi },
				CHECK: { target: 'checking', context: startUi },
			},
		},
	},
})
