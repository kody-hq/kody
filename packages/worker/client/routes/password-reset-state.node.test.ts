import { expect, test } from 'vitest'
import { passwordResetState } from './password-reset-state.ts'

test('password_reset.form pins submission and retry transitions', () => {
	expect(passwordResetState.initial).toEqual(['idle'])
	expect(passwordResetState.transitions).toEqual({
		idle: ['submitting', 'error'],
		submitting: ['success', 'error'],
		success: ['submitting', 'error'],
		error: ['submitting', 'error'],
	})
	expect(passwordResetState.can('submitting', 'submitting')).toBe(false)
})
