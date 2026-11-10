import { canHandle } from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { loginState } from './login-state.ts'
test('login.form pins submission and retry transitions', () => {
	expect(loginState.root.initial.target?.map((state) => state.key)).toEqual([
		'idle',
	])
	expect([...loginState.events].sort()).toEqual([
		'CANCEL',
		'CONFIRM_USERNAME',
		'RESET',
		'RESPONSE_ERROR',
		'RESPONSE_OK',
		'SUBMIT',
		'VALIDATION_ERROR',
	])
	expect(canHandle(loginState, 'submitting', 'SUBMIT')).toBe(false)
})
