import { setup, types } from 'xstate'
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
	schemas: {
		context: types<UiContext<EmailVerificationState>>(),
		events: {
			RESEND: types<{
				data: UiPayload<EmailVerificationState, 'sending'>
				requestId?: unknown
			}>(),
			CHECK: types<{
				data: UiPayload<EmailVerificationState, 'checking'>
				requestId?: unknown
			}>(),
			RESPONSE_OK: types<{
				data: UiPayload<EmailVerificationState, 'success'>
				requestId?: unknown
			}>(),
			RESPONSE_ERROR: types<{
				data: UiPayload<EmailVerificationState, 'error'>
				requestId?: unknown
			}>(),
			CANCEL: types<{
				data: UiPayload<EmailVerificationState, 'idle'>
				requestId?: unknown
			}>(),
		},
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
				RESEND: {
					target: 'sending',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				CHECK: {
					target: 'checking',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
			},
		},
		sending: {
			on: {
				RESPONSE_OK: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<EmailVerificationState>
						event: { type: 'RESPONSE_OK' } & {
							data: UiPayload<EmailVerificationState, 'success'>
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
						context: UiContext<EmailVerificationState>
						event: { type: 'RESPONSE_ERROR' } & {
							data: UiPayload<EmailVerificationState, 'error'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'error', context: { data: event.data } }
					},
				},
				CANCEL: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
		checking: {
			on: {
				RESPONSE_OK: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<EmailVerificationState>
						event: { type: 'RESPONSE_OK' } & {
							data: UiPayload<EmailVerificationState, 'success'>
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
						context: UiContext<EmailVerificationState>
						event: { type: 'RESPONSE_ERROR' } & {
							data: UiPayload<EmailVerificationState, 'error'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'error', context: { data: event.data } }
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
				RESEND: {
					target: 'sending',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				CHECK: {
					target: 'checking',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
			},
		},
		error: {
			on: {
				RESEND: {
					target: 'sending',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				CHECK: {
					target: 'checking',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
			},
		},
	},
})
