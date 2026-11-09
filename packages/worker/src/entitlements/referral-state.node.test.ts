import { expect, test } from 'vitest'
import { referralState } from './referral-state.ts'

test('referrals.status preserves the lifecycle graph', () => {
	expect(referralState.initial).toEqual(['pending'])
	expect(referralState.transitions).toEqual({
		pending: ['rejected', 'rewarded'],
		rewarded: ['rewarded'],
		rejected: [],
	})
	expect(referralState.terminal).toEqual(['rejected'])
})
