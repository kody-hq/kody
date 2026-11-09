import { expect, test } from 'vitest'
import {
	connectOauthDeviceState,
	type ConnectOauthDeviceState,
} from './connect-oauth-device-state.ts'
import { createStateMachineStore } from '../state-machine-store.ts'
test('device poll graph preserves transient retries and authoritative late approval', () => {
	expect(connectOauthDeviceState.transitions).toEqual({
		idle: ['idle', 'starting'],
		starting: ['polling', 'error', 'idle'],
		polling: ['polling', 'error', 'success', 'idle'],
		error: ['idle', 'success'],
		success: ['idle'],
	})
	const store = createStateMachineStore<ConnectOauthDeviceState>(
		connectOauthDeviceState,
		{ status: 'idle' },
	)
	expect(store.transition({ status: 'starting' })).toBe(true)
	expect(store.transition({ status: 'starting' })).toBe(false)
	store.transition({ status: 'error', message: 'Cannot start', view: null })
	expect(store.getSnapshot()).toHaveProperty('message', 'Cannot start')
	store.transition({ status: 'idle' })
	expect(store.getSnapshot()).not.toHaveProperty('message')
})
