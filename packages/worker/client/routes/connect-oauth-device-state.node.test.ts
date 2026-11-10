import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { createActor } from 'xstate'
import { expect, test } from 'vitest'
import {
	connectOauthDeviceState,
	type ConnectOauthDeviceState,
} from './connect-oauth-device-state.ts'
test('device poll graph preserves transient retries and authoritative late approval', () => {
	expect(
		[
			...new Set(
				Object.values(connectOauthDeviceState.states).flatMap((state) => [
					...state.transitions.keys(),
				]),
			),
		].sort(),
	).toEqual([
		'POLL_PENDING',
		'RESET',
		'RESPONSE_ERROR',
		'RESPONSE_OK',
		'SESSION_OK',
		'START',
		'TICK',
	])
	const store = createActor(connectOauthDeviceState).start()
	expect(
		sendUiEvent(store, {
			type: 'START',
			data: uiContext({ status: 'starting' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'START',
			data: uiContext({ status: 'starting' }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(false)
	sendUiEvent(store, {
		type: 'RESPONSE_ERROR',
		data: uiContext({ status: 'error', message: 'Cannot start', view: null })
			.data,
	} as Parameters<typeof store.send>[0])
	expect(uiState<ConnectOauthDeviceState>(store.getSnapshot())).toHaveProperty(
		'message',
		'Cannot start',
	)
	sendUiEvent(store, {
		type: 'RESET',
		data: uiContext({ status: 'idle' }).data,
	} as Parameters<typeof store.send>[0])
	expect(
		uiState<ConnectOauthDeviceState>(store.getSnapshot()),
	).not.toHaveProperty('message')
})
