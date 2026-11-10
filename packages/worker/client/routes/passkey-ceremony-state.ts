import { setup, types } from 'xstate'
import type { UiContext, UiData, UiPayload } from '#client/ui-actor.ts'
export type PasskeyCeremonyState =
	| { status: 'idle' }
	| {
			status: Exclude<'idle' | 'requesting' | 'ceremony', 'idle'>
			controller: AbortController
	  }

export const passkeyCeremonyState = setup({
	schemas: {
		context: types<UiContext<PasskeyCeremonyState>>(),
		events: {
			SUBMIT: types<{
				data: UiPayload<PasskeyCeremonyState, 'requesting'>
				requestId?: unknown
			}>(),
			OPTIONS_OK: types<{
				data: UiPayload<PasskeyCeremonyState, 'ceremony'>
				requestId?: unknown
			}>(),
			SETTLED: types<{
				data: UiPayload<PasskeyCeremonyState, 'idle'>
				requestId?: unknown
			}>(),
		},
	},
}).createMachine({
	id: 'passkey.registration_ui',
	description:
		'A registration owns options and its browser ceremony through server confirmation; other passkey mutations retain native Query state.',
	initial: 'idle',
	context: { data: {} as UiData<PasskeyCeremonyState>, requestId: undefined },
	states: {
		idle: {
			on: {
				SUBMIT: {
					target: 'requesting',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
			},
		},
		requesting: {
			on: {
				OPTIONS_OK: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<PasskeyCeremonyState>
						event: { type: 'OPTIONS_OK' } & {
							data: UiPayload<PasskeyCeremonyState, 'ceremony'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'ceremony', context: { data: event.data } }
					},
				},
				SETTLED: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<PasskeyCeremonyState>
						event: { type: 'SETTLED' } & {
							data: UiPayload<PasskeyCeremonyState, 'idle'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return {
							target: 'idle',
							context: { data: event.data, requestId: undefined },
						}
					},
				},
			},
		},
		ceremony: {
			on: {
				SETTLED: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<PasskeyCeremonyState>
						event: { type: 'SETTLED' } & {
							data: UiPayload<PasskeyCeremonyState, 'idle'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return {
							target: 'idle',
							context: { data: event.data, requestId: undefined },
						}
					},
				},
			},
		},
	},
})
