import { expect, test } from 'vitest'
import { createStateMachineStore } from '../state-machine-store.ts'
import {
	usernameAvailabilityState,
	type UsernameAvailabilityView,
} from './username-availability-state.ts'
test('username-availability pins legal UI transitions', () => {
	expect(usernameAvailabilityState.transitions).toEqual({
		idle: ['idle', 'checking', 'invalid'],
		checking: [
			'idle',
			'checking',
			'available',
			'taken',
			'reserved',
			'invalid',
			'unknown',
		],
		available: ['idle', 'checking', 'invalid'],
		taken: ['idle', 'checking', 'invalid'],
		reserved: ['idle', 'checking', 'invalid'],
		invalid: ['idle', 'checking', 'invalid'],
		unknown: ['idle', 'checking', 'invalid'],
	})
})

test('cleared or invalid drafts reject an old successful availability result', () => {
	for (const next of ['idle', 'invalid'] as const) {
		const store = createStateMachineStore<UsernameAvailabilityView>(
			usernameAvailabilityState,
			{ status: 'idle' },
		)
		store.transition({ status: 'checking' })
		store.transition(
			next === 'idle'
				? { status: 'idle' }
				: {
						status: 'invalid',
						username: '?',
						reason: 'Invalid',
						suggestions: [],
					},
		)
		expect(
			store.transition({
				status: 'available',
				username: 'previous',
				reason: null,
				suggestions: [],
			}),
		).toBe(false)
		expect(store.getSnapshot().status).toBe(next)
		store.transition({ status: 'checking' })
		expect(
			store.transition({
				status: 'unknown',
				username: 'new',
				reason: 'Unavailable',
				suggestions: [],
			}),
		).toBe(true)
	}
})
