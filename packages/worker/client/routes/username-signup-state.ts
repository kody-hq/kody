import { setup, types } from 'xstate'
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
	schemas: {
		context: types<UiContext<UsernameSignupState>>(),
		events: {
			CONFIRM_USERNAME: types<{
				data: UiPayload<UsernameSignupState, 'confirming'>
				requestId?: unknown
			}>(),
			SUBMIT: types<{
				data: UiPayload<UsernameSignupState, 'submitting'>
				requestId?: unknown
			}>(),
			VALIDATION_ERROR: types<{
				data: UiPayload<UsernameSignupState, 'error'>
				requestId?: unknown
			}>(),
			RESPONSE_ERROR: types<{
				data: UiPayload<UsernameSignupState, 'error'>
				requestId?: unknown
			}>(),
			RESET: types<{
				data: UiPayload<UsernameSignupState, 'idle'>
				requestId?: unknown
			}>(),
		},
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
				CONFIRM_USERNAME: {
					target: 'confirming',
					context: ({ event }) => ({ data: event.data }),
				},
				VALIDATION_ERROR: {
					target: 'error',
					context: ({ event }) => ({ data: event.data }),
				},
			},
		},
		confirming: {
			on: {
				CONFIRM_USERNAME: {
					target: 'confirming',
					context: ({ event }) => ({ data: event.data }),
				},
				SUBMIT: {
					target: 'submitting',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				VALIDATION_ERROR: {
					target: 'error',
					context: ({ event }) => ({ data: event.data }),
				},
				RESET: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
		submitting: {
			on: {
				RESPONSE_ERROR: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<UsernameSignupState>
						event: { type: 'RESPONSE_ERROR' } & {
							data: UiPayload<UsernameSignupState, 'error'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'error', context: { data: event.data } }
					},
				},
			},
		},
		error: {
			on: {
				CONFIRM_USERNAME: {
					target: 'confirming',
					context: ({ event }) => ({ data: event.data }),
				},
				SUBMIT: {
					target: 'submitting',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				VALIDATION_ERROR: {
					target: 'error',
					context: ({ event }) => ({ data: event.data }),
				},
				RESET: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
	},
})
