import { IllegalStateTransitionError } from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { credentialInventoryRunState } from './credential-inventory-run-state.ts'

test('credential_inventory_runs.status heartbeats while scanning and completes once', () => {
	expect(credentialInventoryRunState.can('scanning', 'scanning')).toBe(true)
	expect(credentialInventoryRunState.can('scanning', 'complete')).toBe(true)
	expect(credentialInventoryRunState.can('complete', 'scanning')).toBe(false)
	expect(credentialInventoryRunState.isTerminal('complete')).toBe(true)
	expect(() =>
		credentialInventoryRunState.assert('complete', 'scanning'),
	).toThrow(IllegalStateTransitionError)
})
