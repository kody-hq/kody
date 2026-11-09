import { expect, test } from 'vitest'
import { createStateMachineStore } from '../state-machine-store.ts'
import {
	clipboardFeedbackState,
	type ClipboardFeedbackState,
} from './clipboard-feedback-state.ts'
test('clipboard-feedback pins legal UI transitions', () => {
	expect(clipboardFeedbackState.transitions).toEqual({
		idle: ['copying'],
		copying: ['copied', 'error'],
		copied: ['copying', 'idle'],
		error: ['copying', 'idle'],
	})
})

test('one clipboard operation owns feedback through failure and retry', () => {
	const store = createStateMachineStore<ClipboardFeedbackState>(
		clipboardFeedbackState,
		{ status: 'idle' },
	)
	expect(store.transition({ status: 'copying' })).toBe(true)
	expect(store.transition({ status: 'copying' })).toBe(false)
	store.transition({ status: 'error' })
	store.transition({ status: 'copying' })
	store.transition({ status: 'copied' })
	store.transition({ status: 'idle' })
	expect(store.getSnapshot()).toEqual({ status: 'idle' })
})
