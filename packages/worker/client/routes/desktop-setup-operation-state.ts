import { setup, types } from 'xstate'
import type { UiContext, UiData, UiPayload } from '#client/ui-actor.ts'
export type DesktopSetupOperation =
	| { status: 'idle' | 'running' }
	| { status: 'error'; message: string }

export const desktopSetupOperationState = setup({
	schemas: {
		context: types<UiContext<DesktopSetupOperation>>(),
		events: {
			SUBMIT: types<{
				data: UiPayload<DesktopSetupOperation, 'running'>
				requestId?: unknown
			}>(),
			RESPONSE_OK: types<{
				data: UiPayload<DesktopSetupOperation, 'idle'>
				requestId?: unknown
			}>(),
			RESPONSE_ERROR: types<{
				data: UiPayload<DesktopSetupOperation, 'error'>
				requestId?: unknown
			}>(),
			DISMISS: types<{
				data: UiPayload<DesktopSetupOperation, 'idle'>
				requestId?: unknown
			}>(),
		},
	},
}).createMachine({
	id: 'desktop.setup_operation',
	description:
		'Bridge actions fence user input through reconciliation; only a failed operation carries an error and retry clears it.',
	initial: 'idle',
	context: { data: {} as UiData<DesktopSetupOperation>, requestId: undefined },
	states: {
		idle: {
			on: {
				SUBMIT: {
					target: 'running',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
			},
		},
		running: {
			on: {
				RESPONSE_OK: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<DesktopSetupOperation>
						event: { type: 'RESPONSE_OK' } & {
							data: UiPayload<DesktopSetupOperation, 'idle'>
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
				RESPONSE_ERROR: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<DesktopSetupOperation>
						event: { type: 'RESPONSE_ERROR' } & {
							data: UiPayload<DesktopSetupOperation, 'error'>
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
					target: 'running',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				DISMISS: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
	},
})
