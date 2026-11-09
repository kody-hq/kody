import { setup, assign } from 'xstate'
import type { UiContext, UiData, UiPayload } from '#client/ui-actor.ts'
export type PasskeyCeremonyState =
	| { status: 'idle' }
	| {
			status: Exclude<'idle' | 'requesting' | 'ceremony', 'idle'>
			controller: AbortController
	  }

export const passkeyCeremonyState = setup({
	types: {
		context: {} as UiContext<PasskeyCeremonyState>,
		events: {} as
			| {
					type: 'SUBMIT'
					data: UiPayload<PasskeyCeremonyState, 'requesting'>
					requestId?: unknown
			  }
			| {
					type: 'OPTIONS_OK'
					data: UiPayload<PasskeyCeremonyState, 'ceremony'>
					requestId?: unknown
			  }
			| {
					type: 'SETTLED'
					data: UiPayload<PasskeyCeremonyState, 'idle'>
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
	id: 'passkey.registration_ui',
	description:
		'A registration owns options and its browser ceremony through server confirmation; other passkey mutations retain native Query state.',
	initial: 'idle',
	context: { data: {} as UiData<PasskeyCeremonyState>, requestId: undefined },
	states: {
		idle: { on: { SUBMIT: { target: 'requesting', actions: 'start' } } },
		requesting: {
			on: {
				OPTIONS_OK: {
					target: 'ceremony',
					guard: 'currentRequest',
					actions: 'update',
				},
				SETTLED: { target: 'idle', guard: 'currentRequest', actions: 'reset' },
			},
		},
		ceremony: {
			on: {
				SETTLED: { target: 'idle', guard: 'currentRequest', actions: 'reset' },
			},
		},
	},
})
