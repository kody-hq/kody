import {
	canHandle,
	finalStatesOf,
} from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { inboundDedupePointerState } from './inbound-dedupe-pointer-state.ts'

test('dedupe pointers tombstone, reset after expiry, and repeat tombstones stay rejected', () => {
	expect([inboundDedupePointerState.config.initial]).toEqual(['pending'])
	expect(canHandle(inboundDedupePointerState, 'pending', 'TOMBSTONE')).toBe(
		true,
	)
	expect(canHandle(inboundDedupePointerState, 'rejected', 'RESET_WINDOW')).toBe(
		true,
	)
	expect(canHandle(inboundDedupePointerState, 'rejected', 'TOMBSTONE')).toBe(
		true,
	)
	expect(finalStatesOf(inboundDedupePointerState).includes('rejected')).toBe(
		false,
	)
})
