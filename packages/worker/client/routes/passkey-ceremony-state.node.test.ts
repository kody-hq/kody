import { canHandle } from '@kody-internal/shared/state-machine.ts'
import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { createActor } from 'xstate'
import { expect, test } from 'vitest'
import {
	passkeyCeremonyState,
	type PasskeyCeremonyState,
} from './passkey-ceremony-state.ts'

test('one registration owns options and the browser ceremony until it settles', () => {
	expect(canHandle(passkeyCeremonyState, 'requesting', 'SUBMIT')).toBe(false)
	expect(canHandle(passkeyCeremonyState, 'ceremony', 'SUBMIT')).toBe(false)
	expect(canHandle(passkeyCeremonyState, 'ceremony', 'OPTIONS_OK')).toBe(false)

	const store = createActor(passkeyCeremonyState).start()
	const controller = new AbortController()
	expect(
		sendUiEvent(store, {
			type: 'SUBMIT',
			data: uiContext({ status: 'requesting', controller }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'SUBMIT',
			data: uiContext({
				status: 'requesting',
				controller: new AbortController(),
			}).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(false)
	expect(
		sendUiEvent(store, {
			type: 'OPTIONS_OK',
			data: uiContext({ status: 'ceremony', controller }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(uiState<PasskeyCeremonyState>(store.getSnapshot())).toEqual({
		status: 'ceremony',
		controller,
	})
	expect(
		sendUiEvent(store, {
			type: 'OPTIONS_OK',
			data: uiContext({
				status: 'ceremony',
				controller: new AbortController(),
			}).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(false)
	expect(
		sendUiEvent(store, {
			type: 'SETTLED',
			data: uiContext({ status: 'idle' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(uiState<PasskeyCeremonyState>(store.getSnapshot())).toEqual({
		status: 'idle',
	})
})
