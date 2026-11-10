import { setup, types } from 'xstate'
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
	schemas: {
		context: types<UiContext<PasswordResetState>>(),
		events: {
			SUBMIT: types<{
				data: UiPayload<PasswordResetState, 'submitting'>
				requestId?: unknown
			}>(),
			VALIDATION_ERROR: types<{
				data: UiPayload<PasswordResetState, 'error'>
				requestId?: unknown
			}>(),
			RESPONSE_OK: types<{
				data: UiPayload<PasswordResetState, 'success'>
				requestId?: unknown
			}>(),
			RESPONSE_ERROR: types<{
				data: UiPayload<PasswordResetState, 'error'>
				requestId?: unknown
			}>(),
		},
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
			},
		},
		submitting: {
			on: {
				RESPONSE_OK: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<PasswordResetState>
						event: { type: 'RESPONSE_OK' } & {
							data: UiPayload<PasswordResetState, 'success'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'success', context: { data: event.data } }
					},
				},
				RESPONSE_ERROR: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<PasswordResetState>
						event: { type: 'RESPONSE_ERROR' } & {
							data: UiPayload<PasswordResetState, 'error'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'error', context: { data: event.data } }
					},
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
				VALIDATION_ERROR: {
					target: 'error',
					context: ({ event }) => ({ data: event.data }),
				},
			},
		},
	},
})
