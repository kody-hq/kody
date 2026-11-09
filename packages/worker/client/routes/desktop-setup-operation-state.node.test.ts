import { expect, test } from 'vitest'
import { createStateMachineStore } from '#client/state-machine-store.ts'
import {
	desktopSetupOperationState,
	type DesktopSetupOperation,
} from './desktop-setup-operation-state.ts'

test('desktop setup fences input and only a failed operation carries an error', () => {
	expect(desktopSetupOperationState.can('idle', 'error')).toBe(false)
	expect(desktopSetupOperationState.can('running', 'running')).toBe(false)

	const store = createStateMachineStore<DesktopSetupOperation>(
		desktopSetupOperationState,
		{ status: 'idle' },
	)
	expect(store.transition({ status: 'error', message: 'Bridge failed.' })).toBe(
		false,
	)
	expect(store.transition({ status: 'running' })).toBe(true)
	expect(store.transition({ status: 'running' })).toBe(false)
	expect(store.transition({ status: 'error', message: 'Bridge failed.' })).toBe(
		true,
	)
	expect(store.getSnapshot()).toEqual({
		status: 'error',
		message: 'Bridge failed.',
	})
	expect(store.transition({ status: 'running' })).toBe(true)
	expect(store.getSnapshot()).toEqual({ status: 'running' })
})
