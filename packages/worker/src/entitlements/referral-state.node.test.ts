import { expect, test } from 'vitest'
import { referralState } from './referral-state.ts'

test('pending referrals reject or reward; rewards retry in place and rejects stay terminal', () => {
	expect(referralState.can('pending', 'rejected')).toBe(true)
	expect(referralState.can('pending', 'rewarded')).toBe(true)
	expect(referralState.can('rewarded', 'rewarded')).toBe(true)
	expect(referralState.can('rewarded', 'pending')).toBe(false)
	expect(referralState.isTerminal('rejected')).toBe(true)
	expect(referralState.isTerminal('rewarded')).toBe(false)
})
