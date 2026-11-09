import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'
export const undoableActionState = defineStateMachine({
	name: 'ui.undoable_action',
	description:
		'One deferred action can be undone or committed exactly once; replacements serialize behind any previous settlement.',
	initial: 'idle',
	transitions: {
		idle: ['waiting'],
		waiting: ['committing', 'undoing'],
		committing: ['idle'],
		undoing: ['idle'],
	},
})
export type UndoableActionStatus = StateOf<typeof undoableActionState>
