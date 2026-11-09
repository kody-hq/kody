import { expect, test } from 'vitest'
import { twoFactorVerifyState } from './two-factor-verify-state.ts'

test('two_factor_verify.form pins submission and retry transitions', () => {
	expect(twoFactorVerifyState.initial).toEqual(['idle'])
	expect(twoFactorVerifyState.transitions).toEqual({
		idle: ['submitting', 'error'],
		submitting: ['error'],
		error: ['submitting', 'error'],
	})
	expect(twoFactorVerifyState.can('submitting', 'submitting')).toBe(false)
})
