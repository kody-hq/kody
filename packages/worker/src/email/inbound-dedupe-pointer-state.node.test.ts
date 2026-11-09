import { expect, test } from 'vitest'
import { inboundDedupePointerState } from './inbound-dedupe-pointer-state.ts'

test('dedupe pointers tombstone, reset after expiry, and repeat tombstones stay rejected', () => {
	expect(inboundDedupePointerState.initial).toEqual(['pending'])
	expect(inboundDedupePointerState.can('pending', 'rejected')).toBe(true)
	expect(inboundDedupePointerState.can('rejected', 'pending')).toBe(true)
	expect(inboundDedupePointerState.can('rejected', 'rejected')).toBe(true)
	expect(inboundDedupePointerState.isTerminal('rejected')).toBe(false)
})
