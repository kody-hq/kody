import { canHandle } from '@kody-internal/shared/state-machine.ts'
import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { createActor } from 'xstate'
import { expect, test } from 'vitest'
import {
	desktopSetupOperationState,
	type DesktopSetupOperation,
} from './desktop-setup-operation-state.ts'
test('desktop setup fences input and only a failed operation carries an error', () => {
	expect(canHandle(desktopSetupOperationState, 'idle', 'RESPONSE_ERROR')).toBe(
		false,
	)
	expect(canHandle(desktopSetupOperationState, 'running', 'SUBMIT')).toBe(false)

	const store = createActor(desktopSetupOperationState).start()
	expect(
		sendUiEvent(store, {
			type: 'RESPONSE_ERROR',
			data: uiContext({ status: 'error', message: 'Bridge failed.' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(false)
	expect(
		sendUiEvent(store, {
			type: 'SUBMIT',
			data: uiContext({ status: 'running' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'SUBMIT',
			data: uiContext({ status: 'running' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(false)
	expect(
		sendUiEvent(store, {
			type: 'RESPONSE_ERROR',
			data: uiContext({ status: 'error', message: 'Bridge failed.' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(uiState<DesktopSetupOperation>(store.getSnapshot())).toEqual({
		status: 'error',
		message: 'Bridge failed.',
	})
	expect(
		sendUiEvent(store, {
			type: 'SUBMIT',
			data: uiContext({ status: 'running' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(uiState<DesktopSetupOperation>(store.getSnapshot())).toEqual({
		status: 'running',
	})
})
