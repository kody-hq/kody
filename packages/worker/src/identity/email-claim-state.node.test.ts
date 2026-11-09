import { expect, test } from 'vitest'
import { emailClaimState } from './email-claim-state.ts'

test('email claims insert as claimed or released and can flip either way', () => {
	expect(emailClaimState.initial).toEqual(['claimed', 'released'])
	expect(emailClaimState.can('claimed', 'released')).toBe(true)
	expect(emailClaimState.can('released', 'claimed')).toBe(true)
	expect(emailClaimState.can('claimed', 'claimed')).toBe(false)
	expect(emailClaimState.isTerminal('released')).toBe(false)
})
