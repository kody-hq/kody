import {
	canHandle,
	finalStatesOf,
	nextState,
	IllegalStateTransitionError,
} from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { referralState } from './referral-state.ts'

test('rejected referrals are final while incomplete rewards can retry', () => {
	expect(canHandle(referralState, 'pending', 'REJECT_FRAUD')).toBe(true)
	expect(canHandle(referralState, 'pending', 'REWARD')).toBe(true)
	expect(canHandle(referralState, 'rewarded', 'REWARD')).toBe(true)
	expect(canHandle(referralState, 'rewarded', 'CREATE' as never)).toBe(false)
	expect(finalStatesOf(referralState).includes('rejected')).toBe(true)
	expect(() =>
		nextState(referralState, 'rejected', { type: 'REWARD' }),
	).toThrow(IllegalStateTransitionError)
	expect(finalStatesOf(referralState).includes('rewarded')).toBe(false)
})
