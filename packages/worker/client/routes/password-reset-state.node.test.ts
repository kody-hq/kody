import { canHandle } from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { passwordResetState } from './password-reset-state.ts'
test('password_reset.form pins submission and retry transitions', () => {
	expect(
		passwordResetState.root.initial.target?.map((state) => state.key),
	).toEqual(['idle'])
	expect([...passwordResetState.events].sort()).toEqual([
		'RESPONSE_ERROR',
		'RESPONSE_OK',
		'SUBMIT',
		'VALIDATION_ERROR',
	])
	expect(canHandle(passwordResetState, 'submitting', 'SUBMIT')).toBe(false)
})
