import { setup, assign } from 'xstate'
import type {
	UiContext,
	UiData,
	UiPayload,
	FormFlowState,
} from '#client/ui-actor.ts'
export type EmailVerificationState = FormFlowState<
	'idle' | 'sending' | 'checking' | 'success' | 'error'
>

export const emailVerificationState = setup({
	types: {
		context: {} as UiContext<EmailVerificationState>,
		events: {} as
			| {
					type: 'RESEND'
					data: UiPayload<EmailVerificationState, 'sending'>
					requestId?: unknown
			  }
			| {
					type: 'CHECK'
					data: UiPayload<EmailVerificationState, 'checking'>
					requestId?: unknown
			  }
			| {
					type: 'RESPONSE_OK'
					data: UiPayload<EmailVerificationState, 'success'>
					requestId?: unknown
			  }
			| {
					type: 'RESPONSE_ERROR'
					data: UiPayload<EmailVerificationState, 'error'>
					requestId?: unknown
			  }
			| {
					type: 'CANCEL'
					data: UiPayload<EmailVerificationState, 'idle'>
					requestId?: unknown
			  },
	},
	guards: {
		currentRequest: ({ context, event }) =>
			context.requestId === event.requestId,
	},
	actions: {
		update: assign({ data: ({ event }) => event.data }),
		start: assign({
			data: ({ event }) => event.data,
			requestId: ({ event }) => event.requestId,
		}),
		reset: assign({ data: ({ event }) => event.data, requestId: undefined }),
	},
}).createMachine({
	id: 'email_verification.feedback',
	description:
		'Resending and checking email verification are exclusive requests; each retry clears the previous feedback.',
	initial: 'idle',
	context: { data: {} as UiData<EmailVerificationState>, requestId: undefined },
	states: {
		idle: {
			on: {
				RESEND: { target: 'sending', actions: 'start' },
				CHECK: { target: 'checking', actions: 'start' },
			},
		},
		sending: {
			on: {
				RESPONSE_OK: {
					target: 'success',
					guard: 'currentRequest',
					actions: 'update',
				},
				RESPONSE_ERROR: {
					target: 'error',
					guard: 'currentRequest',
					actions: 'update',
				},
				CANCEL: { target: 'idle', actions: 'reset' },
			},
		},
		checking: {
			on: {
				RESPONSE_OK: {
					target: 'success',
					guard: 'currentRequest',
					actions: 'update',
				},
				RESPONSE_ERROR: {
					target: 'error',
					guard: 'currentRequest',
					actions: 'update',
				},
				CANCEL: { target: 'idle', actions: 'reset' },
			},
		},
		success: {
			on: {
				RESEND: { target: 'sending', actions: 'start' },
				CHECK: { target: 'checking', actions: 'start' },
			},
		},
		error: {
			on: {
				RESEND: { target: 'sending', actions: 'start' },
				CHECK: { target: 'checking', actions: 'start' },
			},
		},
	},
})
