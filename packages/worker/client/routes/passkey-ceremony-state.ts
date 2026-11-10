import { setup, types } from 'xstate'
import {
	resetUi,
	startUi,
	type UiContext,
	type UiEvent,
} from '#client/ui-actor.ts'
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
			SUBMIT: types<UiEvent<PasskeyCeremonyState, 'requesting'>>(),
			OPTIONS_OK: types<UiEvent<PasskeyCeremonyState, 'ceremony'>>(),
			SETTLED: types<UiEvent<PasskeyCeremonyState, 'idle'>>(),
		},
	},
	guards: { currentRequest: (a: unknown, b: unknown) => a === b },
}).createMachine({
	id: 'passkey.registration_ui',
	description:
		'A registration owns options and its browser ceremony through server confirmation; other passkey mutations retain native Query state.',
	initial: 'idle',
	context: { data: {}, requestId: undefined },
	states: {
		idle: {
			on: {
				SUBMIT: { target: 'requesting', context: startUi },
			},
		},
		requesting: {
			on: {
				OPTIONS_OK: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'ceremony', context: { data: event.data } }
				},
				SETTLED: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'idle', context: resetUi({ event }) }
				},
			},
		},
		ceremony: {
			on: {
				SETTLED: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'idle', context: resetUi({ event }) }
				},
			},
		},
	},
})
