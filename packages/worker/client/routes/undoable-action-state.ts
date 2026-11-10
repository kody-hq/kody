import { setup, types } from 'xstate'
import {
	resetUi,
	updateUi,
	type UiContext,
	type UiEvent,
} from '#client/ui-actor.ts'
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
			SCHEDULE: types<UiEvent<UndoableActionView, 'waiting'>>(),
			COMMIT: types<UiEvent<UndoableActionView, 'committing'>>(),
			UNDO: types<UiEvent<UndoableActionView, 'undoing'>>(),
			SETTLED: types<UiEvent<UndoableActionView, 'idle'>>(),
		},
	},
}).createMachine({
	id: 'ui.undoable_action',
	description:
		'One deferred action can be undone or committed exactly once; replacements serialize behind any previous settlement.',
	initial: 'idle',
	context: { data: {}, requestId: undefined },
	states: {
		idle: {
			on: {
				SCHEDULE: { target: 'waiting', context: updateUi },
			},
		},
		waiting: {
			on: {
				COMMIT: { target: 'committing', context: updateUi },
				UNDO: { target: 'undoing', context: updateUi },
			},
		},
		committing: {
			on: {
				SETTLED: { target: 'idle', context: resetUi },
			},
		},
		undoing: {
			on: {
				SETTLED: { target: 'idle', context: resetUi },
			},
		},
	},
})
