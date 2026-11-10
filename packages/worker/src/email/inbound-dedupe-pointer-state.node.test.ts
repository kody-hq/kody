import { nextState } from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { inboundDedupePointerState } from './inbound-dedupe-pointer-state.ts'

test('a live pending window can refresh without tombstoning', () => {
	expect(
		nextState(inboundDedupePointerState, 'pending', { type: 'RESET_WINDOW' }),
	).toBe('pending')
})
