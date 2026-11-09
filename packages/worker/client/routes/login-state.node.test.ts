import { expect, test } from 'vitest'
import { loginState } from './login-state.ts'

test('login.form pins submission and retry transitions', () => {
	expect(loginState.initial).toEqual(['idle'])
	expect(loginState.transitions).toEqual({
		idle: ['idle', 'confirming', 'submitting', 'error'],
		confirming: ['idle', 'confirming', 'submitting', 'error'],
		submitting: ['idle', 'success', 'error'],
		success: ['idle', 'submitting', 'error'],
		error: ['idle', 'confirming', 'submitting', 'error'],
	})
	expect(loginState.can('submitting', 'submitting')).toBe(false)
})
