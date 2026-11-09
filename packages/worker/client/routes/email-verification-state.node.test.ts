import { expect, test } from 'vitest'
import { createStateMachineStore } from '#client/state-machine-store.ts'
import {
	emailVerificationState,
	type EmailVerificationState,
} from './email-verification-state.ts'

test('email verification excludes concurrent resends and checks', () => {
	expect(emailVerificationState.can('sending', 'checking')).toBe(false)
	expect(emailVerificationState.can('checking', 'sending')).toBe(false)

	const store = createStateMachineStore<EmailVerificationState>(
		emailVerificationState,
		{ status: 'idle' },
	)
	expect(store.transition({ status: 'sending' })).toBe(true)
	expect(store.transition({ status: 'checking' })).toBe(false)
	expect(store.transition({ status: 'success', message: 'Sent.' })).toBe(true)
	expect(store.getSnapshot()).toEqual({
		status: 'success',
		message: 'Sent.',
	})
	expect(store.transition({ status: 'checking' })).toBe(true)
	expect(store.getSnapshot()).toEqual({ status: 'checking' })
	expect(store.transition({ status: 'sending' })).toBe(false)
})
