import { expect, test } from 'vitest'
import { packageOwnerSpikeState } from './package-owner-spike-state.ts'

test('package_owner_error_spike.status preserves the lifecycle graph', () => {
	expect(packageOwnerSpikeState.initial).toEqual(['ok'])
	expect(packageOwnerSpikeState.transitions).toEqual({
		ok: ['ok', 'pending', 'alerted'],
		pending: ['pending', 'ok', 'alerted'],
		alerted: ['alerted', 'ok'],
	})
	expect(packageOwnerSpikeState.terminal).toEqual([])
})
