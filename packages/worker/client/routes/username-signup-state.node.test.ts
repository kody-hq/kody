import { expect, test } from 'vitest'
import { usernameSignupState } from './username-signup-state.ts'

test('username_signup.form pins submission and retry transitions', () => {
	expect(usernameSignupState.initial).toEqual(['idle'])
	expect(usernameSignupState.transitions).toEqual({
		idle: ['idle', 'confirming', 'error'],
		confirming: ['idle', 'confirming', 'submitting', 'error'],
		submitting: ['error'],
		error: ['idle', 'confirming', 'submitting', 'error'],
	})
	expect(usernameSignupState.can('submitting', 'submitting')).toBe(false)
})
