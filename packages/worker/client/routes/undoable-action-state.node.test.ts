import { expect, test } from 'vitest'
import { undoableActionState } from './undoable-action-state.ts'
test('ui.undoable_action graph', () => {
	expect(undoableActionState.transitions).toEqual({
		idle: ['waiting'],
		waiting: ['committing', 'undoing'],
		committing: ['idle'],
		undoing: ['idle'],
	})
})
