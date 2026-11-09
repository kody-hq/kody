import { expect, test } from 'vitest'
import { packageOwnerSpikeState } from './package-owner-spike-state.ts'

test('spike delivery rearms through ok and never pending from alerted', () => {
	expect(packageOwnerSpikeState.can('ok', 'pending')).toBe(true)
	expect(packageOwnerSpikeState.can('ok', 'alerted')).toBe(true)
	expect(packageOwnerSpikeState.can('pending', 'alerted')).toBe(true)
	expect(packageOwnerSpikeState.can('pending', 'ok')).toBe(true)
	expect(packageOwnerSpikeState.can('alerted', 'ok')).toBe(true)
	expect(packageOwnerSpikeState.can('alerted', 'pending')).toBe(false)
})
