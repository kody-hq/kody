import { setup, assign } from 'xstate'
import type {
	UiContext,
	UiData,
	UiPayload,
	FormFlowState,
} from '#client/ui-actor.ts'
export type PasswordResetState = FormFlowState<
	'idle' | 'submitting' | 'success' | 'error'
>

export const passwordResetState = setup({
	types: {
		context: {} as UiContext<PasswordResetState>,
		events: {} as
			| {
					type: 'SUBMIT'
					data: UiPayload<PasswordResetState, 'submitting'>
					requestId?: unknown
			  }
			| {
					type: 'VALIDATION_ERROR'
					data: UiPayload<PasswordResetState, 'error'>
					requestId?: unknown
			  }
			| {
					type: 'RESPONSE_OK'
					data: UiPayload<PasswordResetState, 'success'>
					requestId?: unknown
			  }
			| {
					type: 'RESPONSE_ERROR'
					data: UiPayload<PasswordResetState, 'error'>
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
	id: 'password_reset.form',
	description:
		'Password reset requests and confirmations submit once, display their result and clear old feedback on retry.',
	initial: 'idle',
	context: { data: {} as UiData<PasswordResetState>, requestId: undefined },
	states: {
		idle: {
			on: {
				SUBMIT: { target: 'submitting', actions: 'start' },
				VALIDATION_ERROR: { target: 'error', actions: 'update' },
			},
		},
		submitting: {
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
			},
		},
		success: {
			on: {
				SUBMIT: { target: 'submitting', actions: 'start' },
				VALIDATION_ERROR: { target: 'error', actions: 'update' },
			},
		},
		error: {
			on: {
				SUBMIT: { target: 'submitting', actions: 'start' },
				VALIDATION_ERROR: { target: 'error', actions: 'update' },
			},
		},
	},
})
