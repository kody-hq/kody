import { setup, assign } from 'xstate'
import type {
	UiContext,
	UiData,
	UiPayload,
	FormFlowState,
} from '#client/ui-actor.ts'
export type UsernameSignupState = FormFlowState<
	'idle' | 'confirming' | 'submitting' | 'error'
>

export const usernameSignupState = setup({
	types: {
		context: {} as UiContext<UsernameSignupState>,
		events: {} as
			| {
					type: 'CONFIRM_USERNAME'
					data: UiPayload<UsernameSignupState, 'confirming'>
					requestId?: unknown
			  }
			| {
					type: 'SUBMIT'
					data: UiPayload<UsernameSignupState, 'submitting'>
					requestId?: unknown
			  }
			| {
					type: 'VALIDATION_ERROR'
					data: UiPayload<UsernameSignupState, 'error'>
					requestId?: unknown
			  }
			| {
					type: 'RESPONSE_ERROR'
					data: UiPayload<UsernameSignupState, 'error'>
					requestId?: unknown
			  }
			| {
					type: 'RESET'
					data: UiPayload<UsernameSignupState, 'idle'>
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
	id: 'username_signup.form',
	description:
		'A chosen username is confirmed before account creation, with failed submissions retryable without losing the confirmed draft.',
	initial: 'idle',
	context: { data: {} as UiData<UsernameSignupState>, requestId: undefined },
	states: {
		idle: {
			on: {
				CONFIRM_USERNAME: { target: 'confirming', actions: 'update' },
				VALIDATION_ERROR: { target: 'error', actions: 'update' },
			},
		},
		confirming: {
			on: {
				CONFIRM_USERNAME: { target: 'confirming', actions: 'update' },
				SUBMIT: { target: 'submitting', actions: 'start' },
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
			},
		},
		error: {
			on: {
				CONFIRM_USERNAME: { target: 'confirming', actions: 'update' },
				SUBMIT: { target: 'submitting', actions: 'start' },
				VALIDATION_ERROR: { target: 'error', actions: 'update' },
				RESET: { target: 'idle', actions: 'reset' },
			},
		},
	},
})
