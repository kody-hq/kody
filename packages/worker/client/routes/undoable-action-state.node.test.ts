import { canHandle } from '@kody-internal/shared/state-machine.ts'
import { uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { createActor } from 'xstate'
import { expect, test } from 'vitest'
import { undoableActionState } from './undoable-action-state.ts'
test('one deferred action commits or undoes exactly once', () => {
	expect(canHandle(undoableActionState, 'idle', 'COMMIT')).toBe(false)
	expect(canHandle(undoableActionState, 'committing', 'UNDO')).toBe(false)

	const store = createActor(undoableActionState, {
		snapshot: (() => {
			const initialView = { status: 'idle' }
			return undoableActionState.resolveState({
				value: initialView.status,
				context: uiContext(initialView),
			})
		})(),
	}).start()
	expect(
		sendUiEvent(store, {
			type: 'COMMIT',
			data: uiContext({ status: 'committing' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(false)
	expect(
		sendUiEvent(store, {
			type: 'SCHEDULE',
			data: uiContext({ status: 'waiting' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'SCHEDULE',
			data: uiContext({ status: 'waiting' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(false)
	expect(
		sendUiEvent(store, {
			type: 'COMMIT',
			data: uiContext({ status: 'committing' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'UNDO',
			data: uiContext({ status: 'undoing' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(false)
	expect(
		sendUiEvent(store, {
			type: 'SETTLED',
			data: uiContext({ status: 'idle' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'UNDO',
			data: uiContext({ status: 'undoing' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(false)
})
