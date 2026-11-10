import { setup, assign } from 'xstate'
import type {
	UiContext,
	UiData,
	UiPayload,
	FormFlowState,
} from '#client/ui-actor.ts'
export type TwoFactorVerifyState = FormFlowState<
	'idle' | 'submitting' | 'error'
>

export const twoFactorVerifyState = setup({
	types: {
		context: {} as UiContext<TwoFactorVerifyState>,
		events: {} as
			| {
					type: 'SUBMIT'
					data: UiPayload<TwoFactorVerifyState, 'submitting'>
					requestId?: unknown
			  }
			| {
					type: 'VALIDATION_ERROR'
					data: UiPayload<TwoFactorVerifyState, 'error'>
					requestId?: unknown
			  }
			| {
					type: 'RESPONSE_ERROR'
					data: UiPayload<TwoFactorVerifyState, 'error'>
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
	id: 'two_factor_verify.form',
	description:
		'Two-factor verification keeps a single in-flight request, clears failure feedback on retry and stays busy while navigating on success.',
	initial: 'idle',
	context: { data: {} as UiData<TwoFactorVerifyState>, requestId: undefined },
	states: {
		idle: {
			on: {
				SUBMIT: { target: 'submitting', actions: 'start' },
				VALIDATION_ERROR: { target: 'error', actions: 'update' },
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
				SUBMIT: { target: 'submitting', actions: 'start' },
				VALIDATION_ERROR: { target: 'error', actions: 'update' },
			},
		},
	},
})
