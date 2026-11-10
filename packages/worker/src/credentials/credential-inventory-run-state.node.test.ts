import {
	canHandle,
	finalStatesOf,
	nextState,
	IllegalStateTransitionError,
} from '@kody-internal/shared/state-machine.ts'

import { expect, test } from 'vitest'
import { credentialInventoryRunState } from './credential-inventory-run-state.ts'

test('credential_inventory_runs.status heartbeats while scanning and completes once', () => {
	expect(canHandle(credentialInventoryRunState, 'scanning', 'SCAN_PAGE')).toBe(
		true,
	)
	expect(canHandle(credentialInventoryRunState, 'scanning', 'COMPLETE')).toBe(
		true,
	)
	expect(canHandle(credentialInventoryRunState, 'complete', 'SCAN_PAGE')).toBe(
		false,
	)
	expect(finalStatesOf(credentialInventoryRunState).includes('complete')).toBe(
		true,
	)
	expect(() =>
		nextState(credentialInventoryRunState, 'complete', { type: 'SCAN_PAGE' }),
	).toThrow(IllegalStateTransitionError)
})
