import { setup, assign } from 'xstate'
import type {
	UiContext,
	UiData,
	UiPayload,
	FormFlowState,
} from '#client/ui-actor.ts'
export type AuthFormState = FormFlowState<
	'idle' | 'confirming' | 'submitting' | 'success' | 'error'
>

export const loginState = setup({
	types: {
		context: {} as UiContext<AuthFormState>,
		events: {} as
			| {
					type: 'SUBMIT'
					data: UiPayload<AuthFormState, 'submitting'>
					requestId?: unknown
			  }
			| {
					type: 'CONFIRM_USERNAME'
					data: UiPayload<AuthFormState, 'confirming'>
					requestId?: unknown
			  }
			| {
					type: 'VALIDATION_ERROR'
					data: UiPayload<AuthFormState, 'error'>
					requestId?: unknown
			  }
			| {
					type: 'RESPONSE_ERROR'
					data: UiPayload<AuthFormState, 'error'>
					requestId?: unknown
			  }
			| {
					type: 'RESPONSE_OK'
					data: UiPayload<AuthFormState, 'success'>
					requestId?: unknown
			  }
			| {
					type: 'RESET'
					data: UiPayload<AuthFormState, 'idle'>
					requestId?: unknown
			  }
			| {
					type: 'CANCEL'
					data: UiPayload<AuthFormState, 'idle'>
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
	id: 'login.form',
	description:
		'Password, provider and passkey sign-in share one submission fence, retryable errors and username-confirmation feedback.',
	initial: 'idle',
	context: { data: {} as UiData<AuthFormState>, requestId: undefined },
	states: {
		idle: {
			on: {
				SUBMIT: { target: 'submitting', actions: 'start' },
				CONFIRM_USERNAME: { target: 'confirming', actions: 'update' },
				VALIDATION_ERROR: { target: 'error', actions: 'update' },
			},
		},
		confirming: {
			on: {
				SUBMIT: { target: 'submitting', actions: 'start' },
				CONFIRM_USERNAME: { target: 'confirming', actions: 'update' },
				VALIDATION_ERROR: { target: 'error', actions: 'update' },
				RESET: { target: 'idle', actions: 'reset' },
			},
		},
		submitting: {
			on: {
				RESPONSE_ERROR: {
					target: 'error',
					guard: 'currentRequest',
					actions: 'update',
				},
				RESPONSE_OK: {
					target: 'success',
					guard: 'currentRequest',
					actions: 'update',
				},
				CANCEL: { target: 'idle', actions: 'reset' },
			},
		},
		success: {
			on: {
				SUBMIT: { target: 'submitting', actions: 'start' },
				VALIDATION_ERROR: { target: 'error', actions: 'update' },
				RESET: { target: 'idle', actions: 'reset' },
			},
		},
		error: {
			on: {
				SUBMIT: { target: 'submitting', actions: 'start' },
				CONFIRM_USERNAME: { target: 'confirming', actions: 'update' },
				VALIDATION_ERROR: { target: 'error', actions: 'update' },
				RESET: { target: 'idle', actions: 'reset' },
			},
		},
	},
})
