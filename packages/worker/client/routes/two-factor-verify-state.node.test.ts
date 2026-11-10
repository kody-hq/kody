import { canHandle } from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { twoFactorVerifyState } from './two-factor-verify-state.ts'
test('two_factor_verify.form pins submission and retry transitions', () => {
	expect(
		twoFactorVerifyState.root.initial.target?.map((state) => state.key),
	).toEqual(['idle'])
	expect([...twoFactorVerifyState.events].sort()).toEqual([
		'RESPONSE_ERROR',
		'SUBMIT',
		'VALIDATION_ERROR',
	])
	expect(canHandle(twoFactorVerifyState, 'submitting', 'SUBMIT')).toBe(false)
})
