import { setup, assign } from 'xstate'
import type { UiContext, UiData, UiPayload } from '#client/ui-actor.ts'
export type DesktopSetupOperation =
	| { status: 'idle' | 'running' }
	| { status: 'error'; message: string }

export const desktopSetupOperationState = setup({
	types: {
		context: {} as UiContext<DesktopSetupOperation>,
		events: {} as
			| {
					type: 'SUBMIT'
					data: UiPayload<DesktopSetupOperation, 'running'>
					requestId?: unknown
			  }
			| {
					type: 'RESPONSE_OK'
					data: UiPayload<DesktopSetupOperation, 'idle'>
					requestId?: unknown
			  }
			| {
					type: 'RESPONSE_ERROR'
					data: UiPayload<DesktopSetupOperation, 'error'>
					requestId?: unknown
			  }
			| {
					type: 'DISMISS'
					data: UiPayload<DesktopSetupOperation, 'idle'>
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
	id: 'desktop.setup_operation',
	description:
		'Bridge actions fence user input through reconciliation; only a failed operation carries an error and retry clears it.',
	initial: 'idle',
	context: { data: {} as UiData<DesktopSetupOperation>, requestId: undefined },
	states: {
		idle: { on: { SUBMIT: { target: 'running', actions: 'start' } } },
		running: {
			on: {
				RESPONSE_OK: {
					target: 'idle',
					guard: 'currentRequest',
					actions: 'reset',
				},
				RESPONSE_ERROR: {
					target: 'error',
					guard: 'currentRequest',
					actions: 'update',
				},
			},
		},
		error: {
			on: {
				SUBMIT: { target: 'running', actions: 'start' },
				DISMISS: { target: 'idle', actions: 'reset' },
			},
		},
	},
})
