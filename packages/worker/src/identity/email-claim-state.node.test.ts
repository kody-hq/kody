import { expect, test } from 'vitest'
import { emailClaimState } from './email-claim-state.ts'

test('user_email_claims.status preserves the lifecycle graph', () => {
	expect(emailClaimState.initial).toEqual(['claimed', 'released'])
	expect(emailClaimState.transitions).toEqual({
		claimed: ['released'],
		released: ['claimed'],
	})
	expect(emailClaimState.terminal).toEqual([])
})
