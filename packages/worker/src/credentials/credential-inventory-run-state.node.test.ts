import { expect, test } from 'vitest'
import { credentialInventoryRunState } from './credential-inventory-run-state.ts'

test('credential_inventory_runs.status preserves the lifecycle graph', () => {
	expect(credentialInventoryRunState.initial).toEqual(['scanning'])
	expect(credentialInventoryRunState.transitions).toEqual({
		scanning: ['scanning', 'complete'],
		complete: [],
	})
	expect(credentialInventoryRunState.terminal).toEqual(['complete'])
})
