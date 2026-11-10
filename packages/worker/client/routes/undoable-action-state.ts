import { setup, types } from 'xstate'
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
	schemas: {
		context: types<UiContext<UndoableActionView>>(),
		events: {
			SCHEDULE: types<{
				data: UiPayload<UndoableActionView, 'waiting'>
				requestId?: unknown
			}>(),
			COMMIT: types<{
				data: UiPayload<UndoableActionView, 'committing'>
				requestId?: unknown
			}>(),
			UNDO: types<{
				data: UiPayload<UndoableActionView, 'undoing'>
				requestId?: unknown
			}>(),
			SETTLED: types<{
				data: UiPayload<UndoableActionView, 'idle'>
				requestId?: unknown
			}>(),
		},
	},
}).createMachine({
	id: 'ui.undoable_action',
	description:
		'One deferred action can be undone or committed exactly once; replacements serialize behind any previous settlement.',
	initial: 'idle',
	context: { data: {} as UiData<UndoableActionView>, requestId: undefined },
	states: {
		idle: {
			on: {
				SCHEDULE: {
					target: 'waiting',
					context: ({ event }) => ({ data: event.data }),
				},
			},
		},
		waiting: {
			on: {
				COMMIT: {
					target: 'committing',
					context: ({ event }) => ({ data: event.data }),
				},
				UNDO: {
					target: 'undoing',
					context: ({ event }) => ({ data: event.data }),
				},
			},
		},
		committing: {
			on: {
				SETTLED: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
		undoing: {
			on: {
				SETTLED: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
	},
})
