import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { createActor } from 'xstate'
import { expect, test } from 'vitest'
import {
	usernameAvailabilityState,
	type UsernameAvailabilityView,
} from './username-availability-state.ts'
test('username-availability pins legal UI transitions', () => {
	expect([...usernameAvailabilityState.events].sort()).toEqual([
		'CHECK',
		'EDIT',
		'INVALID_DRAFT',
		'RESPONSE_AVAILABLE',
		'RESPONSE_INVALID',
		'RESPONSE_RESERVED',
		'RESPONSE_TAKEN',
		'RESPONSE_UNKNOWN',
	])
})

test('cleared or invalid drafts reject an old successful availability result', () => {
	for (const next of ['idle', 'invalid'] as const) {
		const store = createActor(usernameAvailabilityState).start()
		sendUiEvent(store, {
			type: 'CHECK',
			data: uiContext({ status: 'checking' }).data,
		} as Parameters<typeof store.send>[0])
		sendUiEvent(
			store,
			next === 'idle'
				? { type: 'EDIT', data: {} }
				: ({
						type: 'INVALID_DRAFT',
						data: { username: '?', reason: 'Invalid', suggestions: [] },
					} as Parameters<typeof store.send>[0]),
		)
		expect(
			sendUiEvent(store, {
				type: 'RESPONSE_AVAILABLE',
				data: uiContext({
					status: 'available',
					username: 'previous',
					reason: null,
					suggestions: [],
				}).data,
			} as Parameters<typeof store.send>[0]),
		).toBe(false)
		expect(uiState<UsernameAvailabilityView>(store.getSnapshot()).status).toBe(
			next,
		)
		sendUiEvent(store, {
			type: 'CHECK',
			data: uiContext({ status: 'checking' }).data,
		} as Parameters<typeof store.send>[0])
		expect(
			sendUiEvent(store, {
				type: 'RESPONSE_UNKNOWN',
				data: uiContext({
					status: 'unknown',
					username: 'new',
					reason: 'Unavailable',
					suggestions: [],
				}).data,
			} as Parameters<typeof store.send>[0]),
		).toBe(true)
	}
})
