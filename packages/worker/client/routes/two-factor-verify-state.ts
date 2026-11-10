import { setup, types } from 'xstate'
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
	schemas: {
		context: types<UiContext<TwoFactorVerifyState>>(),
		events: {
			SUBMIT: types<{
				data: UiPayload<TwoFactorVerifyState, 'submitting'>
				requestId?: unknown
			}>(),
			VALIDATION_ERROR: types<{
				data: UiPayload<TwoFactorVerifyState, 'error'>
				requestId?: unknown
			}>(),
			RESPONSE_ERROR: types<{
				data: UiPayload<TwoFactorVerifyState, 'error'>
				requestId?: unknown
			}>(),
		},
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
				RESPONSE_ERROR: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<TwoFactorVerifyState>
						event: { type: 'RESPONSE_ERROR' } & {
							data: UiPayload<TwoFactorVerifyState, 'error'>
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
