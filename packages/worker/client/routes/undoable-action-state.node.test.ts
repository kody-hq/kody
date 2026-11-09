import { expect, test } from 'vitest'
import { createStateMachineStore } from '#client/state-machine-store.ts'
import {
	undoableActionState,
	type UndoableActionStatus,
} from './undoable-action-state.ts'

test('one deferred action commits or undoes exactly once', () => {
	expect(undoableActionState.can('idle', 'committing')).toBe(false)
	expect(undoableActionState.can('committing', 'undoing')).toBe(false)

	const store = createStateMachineStore<{ status: UndoableActionStatus }>(
		undoableActionState,
		{ status: 'idle' },
	)
	expect(store.transition({ status: 'committing' })).toBe(false)
	expect(store.transition({ status: 'waiting' })).toBe(true)
	expect(store.transition({ status: 'waiting' })).toBe(false)
	expect(store.transition({ status: 'committing' })).toBe(true)
	expect(store.transition({ status: 'undoing' })).toBe(false)
	expect(store.transition({ status: 'idle' })).toBe(true)
	expect(store.transition({ status: 'undoing' })).toBe(false)
})
