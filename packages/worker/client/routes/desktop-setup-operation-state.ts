import { setup, types } from 'xstate'
import {
	resetUi,
	startUi,
	type UiContext,
	type UiEvent,
} from '#client/ui-actor.ts'
export type DesktopSetupOperation =
	| { status: 'idle' | 'running' }
	| { status: 'error'; message: string }

export const desktopSetupOperationState = setup({
	schemas: {
		context: types<UiContext<DesktopSetupOperation>>(),
		events: {
			SUBMIT: types<UiEvent<DesktopSetupOperation, 'running'>>(),
			RESPONSE_OK: types<UiEvent<DesktopSetupOperation, 'idle'>>(),
			RESPONSE_ERROR: types<UiEvent<DesktopSetupOperation, 'error'>>(),
			DISMISS: types<UiEvent<DesktopSetupOperation, 'idle'>>(),
		},
	},
	guards: { currentRequest: (a: unknown, b: unknown) => a === b },
}).createMachine({
	id: 'desktop.setup_operation',
	description:
		'Bridge actions fence user input through reconciliation; only a failed operation carries an error and retry clears it.',
	initial: 'idle',
	context: { data: {}, requestId: undefined },
	states: {
		idle: {
			on: {
				SUBMIT: { target: 'running', context: startUi },
			},
		},
		running: {
			on: {
				RESPONSE_OK: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'idle', context: resetUi({ event }) }
				},
				RESPONSE_ERROR: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'error', context: { data: event.data } }
				},
			},
		},
		error: {
			on: {
				SUBMIT: { target: 'running', context: startUi },
				DISMISS: { target: 'idle', context: resetUi },
			},
		},
	},
})
