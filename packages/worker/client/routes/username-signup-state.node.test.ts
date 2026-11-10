import { canHandle } from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { usernameSignupState } from './username-signup-state.ts'
test('username_signup.form pins submission and retry transitions', () => {
	expect(
		usernameSignupState.root.initial.target?.map((state) => state.key),
	).toEqual(['idle'])
	expect([...usernameSignupState.events].sort()).toEqual([
		'CONFIRM_USERNAME',
		'RESET',
		'RESPONSE_ERROR',
		'SUBMIT',
		'VALIDATION_ERROR',
	])
	expect(canHandle(usernameSignupState, 'submitting', 'SUBMIT')).toBe(false)
})
