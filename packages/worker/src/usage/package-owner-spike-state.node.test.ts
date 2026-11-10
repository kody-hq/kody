import { canHandle } from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { packageOwnerSpikeState } from './package-owner-spike-state.ts'

test('spike delivery rearms through ok and never pending from alerted', () => {
	expect(canHandle(packageOwnerSpikeState, 'ok', 'TRIGGER')).toBe(true)
	expect(canHandle(packageOwnerSpikeState, 'ok', 'DELIVER')).toBe(true)
	expect(canHandle(packageOwnerSpikeState, 'pending', 'DELIVER')).toBe(true)
	expect(canHandle(packageOwnerSpikeState, 'pending', 'REARM')).toBe(true)
	expect(canHandle(packageOwnerSpikeState, 'alerted', 'REARM')).toBe(true)
	expect(canHandle(packageOwnerSpikeState, 'alerted', 'TRIGGER')).toBe(false)
})
