import {
	canHandle,
	finalStatesOf,
	sqlSourcesOf,
	IllegalStateTransitionError,
} from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { emailClaimState } from './email-claim-state.ts'

test('email claims insert as claimed or released and can flip either way', () => {
	expect(canHandle(emailClaimState, 'claimed', 'RELEASE')).toBe(true)
	expect(canHandle(emailClaimState, 'released', 'CLAIM')).toBe(true)
	expect(canHandle(emailClaimState, 'claimed', 'CLAIM')).toBe(false)
	expect(canHandle(emailClaimState, 'released', 'RELEASE')).toBe(false)
	expect(finalStatesOf(emailClaimState)).toEqual([])
	expect(sqlSourcesOf(emailClaimState, 'RELEASE', ['claimed'])).toBe(
		"('claimed')",
	)
	expect(() => sqlSourcesOf(emailClaimState, 'RELEASE', ['released'])).toThrow(
		IllegalStateTransitionError,
	)
})
