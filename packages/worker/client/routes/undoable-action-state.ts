import { setup, assign } from 'xstate'
import type { UiContext, UiData, UiPayload } from '#client/ui-actor.ts'
export type UndoableActionStatus = 'idle' | 'waiting' | 'committing' | 'undoing'

type UndoableActionInput = {
	message: string
	undoLabel?: string
	onCommit: () => void | Promise<void>
	onUndo?: () => void | Promise<void>
}
export type UndoableActionView =
	| { status: 'idle' }
	| { status: 'waiting'; action: UndoableActionInput }
	| { status: 'committing' | 'undoing'; promise: Promise<void> }
export const undoableActionState = setup({
	types: {
		context: {} as UiContext<UndoableActionView>,
		events: {} as
			| {
					type: 'SCHEDULE'
					data: UiPayload<UndoableActionView, 'waiting'>
					requestId?: unknown
			  }
			| {
					type: 'COMMIT'
					data: UiPayload<UndoableActionView, 'committing'>
					requestId?: unknown
			  }
			| {
					type: 'UNDO'
					data: UiPayload<UndoableActionView, 'undoing'>
					requestId?: unknown
			  }
			| {
					type: 'SETTLED'
					data: UiPayload<UndoableActionView, 'idle'>
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
	id: 'ui.undoable_action',
	description:
		'One deferred action can be undone or committed exactly once; replacements serialize behind any previous settlement.',
	initial: 'idle',
	context: { data: {} as UiData<UndoableActionView>, requestId: undefined },
	states: {
		idle: { on: { SCHEDULE: { target: 'waiting', actions: 'update' } } },
		waiting: {
			on: {
				COMMIT: { target: 'committing', actions: 'update' },
				UNDO: { target: 'undoing', actions: 'update' },
			},
		},
		committing: { on: { SETTLED: { target: 'idle', actions: 'reset' } } },
		undoing: { on: { SETTLED: { target: 'idle', actions: 'reset' } } },
	},
})
