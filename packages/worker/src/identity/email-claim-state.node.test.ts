import {
	canHandle,
	finalStatesOf,
} from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { emailClaimState } from './email-claim-state.ts'

test('email claims insert as claimed or released and can flip either way', () => {
	expect([emailClaimState.config.initial]).toEqual(['claimed'])
	expect(emailClaimState.config.description).toContain(
		'either state may be inserted',
	)
	expect(canHandle(emailClaimState, 'claimed', 'RELEASE')).toBe(true)
	expect(canHandle(emailClaimState, 'released', 'CLAIM')).toBe(true)
	expect(canHandle(emailClaimState, 'claimed', 'CLAIM')).toBe(false)
	expect(finalStatesOf(emailClaimState).includes('released')).toBe(false)
})
