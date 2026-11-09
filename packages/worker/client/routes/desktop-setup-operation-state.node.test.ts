import { expect, test } from 'vitest'
import { desktopSetupOperationState } from './desktop-setup-operation-state.ts'
test('desktop.setup_operation graph', () => {
	expect(desktopSetupOperationState.transitions).toEqual({
		idle: ['running'],
		running: ['idle', 'error'],
		error: ['idle', 'running'],
	})
})
