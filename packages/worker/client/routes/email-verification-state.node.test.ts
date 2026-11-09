import { expect, test } from 'vitest'
import { emailVerificationState } from './email-verification-state.ts'
test('email verification excludes concurrent resends and checks', () => {
	expect(emailVerificationState.transitions).toEqual({
		idle: ['sending', 'checking'],
		sending: ['idle', 'success', 'error'],
		checking: ['idle', 'success', 'error'],
		success: ['sending', 'checking'],
		error: ['sending', 'checking'],
	})
	expect(emailVerificationState.terminal).toEqual([])
})
