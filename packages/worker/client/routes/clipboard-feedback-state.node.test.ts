import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { createActor } from 'xstate'
import { expect, test } from 'vitest'
import {
	clipboardFeedbackState,
	type ClipboardFeedbackState,
} from './clipboard-feedback-state.ts'
test('clipboard-feedback pins legal UI transitions', () => {
	expect([...clipboardFeedbackState.events].sort()).toEqual([
		'COPY',
		'RESET',
		'RESPONSE_ERROR',
		'RESPONSE_OK',
	])
})

test('one clipboard operation owns feedback through failure and retry', () => {
	const store = createActor(clipboardFeedbackState).start()
	expect(
		sendUiEvent(store, {
			type: 'COPY',
			data: uiContext({ status: 'copying' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'COPY',
			data: uiContext({ status: 'copying' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(false)
	sendUiEvent(store, {
		type: 'RESPONSE_ERROR',
		data: uiContext({ status: 'error' }).data,
	} as Parameters<typeof store.send>[0])
	sendUiEvent(store, {
		type: 'COPY',
		data: uiContext({ status: 'copying' }).data,
	} as Parameters<typeof store.send>[0])
	sendUiEvent(store, {
		type: 'RESPONSE_OK',
		data: uiContext({ status: 'copied' }).data,
	} as Parameters<typeof store.send>[0])
	sendUiEvent(store, {
		type: 'RESET',
		data: uiContext({ status: 'idle' }).data,
	} as Parameters<typeof store.send>[0])
	expect(uiState<ClipboardFeedbackState>(store.getSnapshot())).toEqual({
		status: 'idle',
	})
})
