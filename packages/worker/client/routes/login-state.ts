import { setup, types } from 'xstate'
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
	schemas: {
		context: types<UiContext<AuthFormState>>(),
		events: {
			SUBMIT: types<{
				data: UiPayload<AuthFormState, 'submitting'>
				requestId?: unknown
			}>(),
			CONFIRM_USERNAME: types<{
				data: UiPayload<AuthFormState, 'confirming'>
				requestId?: unknown
			}>(),
			VALIDATION_ERROR: types<{
				data: UiPayload<AuthFormState, 'error'>
				requestId?: unknown
			}>(),
			RESPONSE_ERROR: types<{
				data: UiPayload<AuthFormState, 'error'>
				requestId?: unknown
			}>(),
			RESPONSE_OK: types<{
				data: UiPayload<AuthFormState, 'success'>
				requestId?: unknown
			}>(),
			RESET: types<{
				data: UiPayload<AuthFormState, 'idle'>
				requestId?: unknown
			}>(),
			CANCEL: types<{
				data: UiPayload<AuthFormState, 'idle'>
				requestId?: unknown
			}>(),
		},
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
				SUBMIT: {
					target: 'submitting',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
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
				SUBMIT: {
					target: 'submitting',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				CONFIRM_USERNAME: {
					target: 'confirming',
					context: ({ event }) => ({ data: event.data }),
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
						context: UiContext<AuthFormState>
						event: { type: 'RESPONSE_ERROR' } & {
							data: UiPayload<AuthFormState, 'error'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'error', context: { data: event.data } }
					},
				},
				RESPONSE_OK: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<AuthFormState>
						event: { type: 'RESPONSE_OK' } & {
							data: UiPayload<AuthFormState, 'success'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'success', context: { data: event.data } }
					},
				},
				CANCEL: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
		success: {
			on: {
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
		error: {
			on: {
				SUBMIT: {
					target: 'submitting',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				CONFIRM_USERNAME: {
					target: 'confirming',
					context: ({ event }) => ({ data: event.data }),
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
