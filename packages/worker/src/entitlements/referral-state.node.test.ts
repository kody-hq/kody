import {
	canHandle,
	finalStatesOf,
	nextState,
	IllegalStateTransitionError,
} from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { referralState } from './referral-state.ts'

test('reward preflight rejects rejected snapshots but existing credit retry SQL can resurrect them', () => {
	expect(canHandle(referralState, 'pending', 'REJECT_FRAUD')).toBe(true)
	expect(canHandle(referralState, 'pending', 'REWARD')).toBe(true)
	expect(canHandle(referralState, 'rewarded', 'REWARD')).toBe(true)
	expect(canHandle(referralState, 'rewarded', 'CREATE' as never)).toBe(false)
	expect(finalStatesOf(referralState).includes('rejected')).toBe(false)
	expect(() =>
		nextState(referralState, 'rejected', { type: 'REWARD' }),
	).toThrow(IllegalStateTransitionError)
	expect(
		nextState(referralState, 'rejected', {
			type: 'REWARD',
			creditsPending: true,
		}),
	).toBe('rewarded')
	expect(finalStatesOf(referralState).includes('rewarded')).toBe(false)
})
