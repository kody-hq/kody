import { expect, test } from 'vitest'
import { inboundDedupePointerState } from './inbound-dedupe-pointer-state.ts'

test('email_inbound_dedupe_pointer.state pins claim, reclaim and completion edges', () => {
	expect(inboundDedupePointerState.initial).toEqual(['pending'])
	expect(inboundDedupePointerState.transitions).toEqual({
		pending: ['pending', 'rejected'],
		rejected: ['pending', 'rejected'],
	})
	expect(inboundDedupePointerState.terminal).toEqual([])
})
