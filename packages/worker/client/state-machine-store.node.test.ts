import { expect, test } from 'vitest'
import { createStateMachineStore } from './state-machine-store.ts'
import {
	passwordResetState,
	type PasswordResetState,
} from './routes/password-reset-state.ts'

test('guards duplicate submissions synchronously before a render and clears error payloads on retry', () => {
	const store = createStateMachineStore<PasswordResetState>(
		passwordResetState,
		{ status: 'idle' },
	)
	expect(store.getSnapshot()).toEqual({ status: 'idle' })
	const seen: Array<string> = []
	const unsubscribe = store.subscribe(() =>
		seen.push(store.getSnapshot().status),
	)
	expect(store.transition({ status: 'submitting' })).toBe(true)
	expect(store.transition({ status: 'submitting' })).toBe(false)
	expect(seen).toEqual(['submitting'])
	expect(store.transition({ status: 'error', message: 'Network error.' })).toBe(
		true,
	)
	expect(store.getSnapshot()).toEqual({
		status: 'error',
		message: 'Network error.',
	})
	expect(store.transition({ status: 'submitting' })).toBe(true)
	expect(store.getSnapshot()).toEqual({ status: 'submitting' })
	expect(
		store.transition({ status: 'success', message: 'Check your inbox.' }),
	).toBe(true)
	unsubscribe()
	expect(store.transition({ status: 'submitting' })).toBe(true)
	expect(seen).toEqual(['submitting', 'error', 'submitting', 'success'])
})

test('an illegal completion leaves state and subscriptions untouched', () => {
	const store = createStateMachineStore<PasswordResetState>(
		passwordResetState,
		{ status: 'idle' },
	)
	expect(
		store.transition({ status: 'success', message: 'stale response' }),
	).toBe(false)
	expect(store.getSnapshot()).toEqual({ status: 'idle' })
})
