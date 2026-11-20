import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
	pickAvailableHandleSuggestion,
	waitForDebounce,
} from './verified-handle-suggestion.ts'

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

function available(username: string) {
	return { ok: true, status: 'available', username, suggestions: [] }
}

function taken(username: string, suggestions: Array<string>) {
	return {
		ok: true,
		status: 'taken',
		username,
		reason: `${username} is taken.`,
		suggestions,
	}
}

test('pickAvailableHandleSuggestion only offers handles the check confirmed free', () => {
	expect(pickAvailableHandleSuggestion('jsdk-j', available('jsdk-j'))).toEqual({
		suggestion: 'jsdk-j',
		verified: true,
	})
	expect(
		pickAvailableHandleSuggestion(
			'jsdk-j',
			taken('jsdk-j', ['jsdk-j', 'jsdk-j-2', 'jsdk-j-3']),
		),
	).toEqual({ suggestion: 'jsdk-j-2', verified: true })
	expect(
		pickAvailableHandleSuggestion('admin', {
			ok: true,
			status: 'reserved',
			username: 'admin',
			reason: 'This username is reserved.',
			suggestions: ['Not Valid', 'admin-2'],
		}),
	).toEqual({ suggestion: 'admin-2', verified: true })
	expect(pickAvailableHandleSuggestion('jsdk-j', taken('jsdk-j', []))).toEqual({
		suggestion: null,
		verified: true,
	})
	expect(
		pickAvailableHandleSuggestion('jsdk-j', {
			ok: false,
			code: 'rate_limited',
			error: 'Too many username checks.',
		}),
	).toEqual({ suggestion: null, verified: false })
	expect(pickAvailableHandleSuggestion('jsdk-j', null)).toEqual({
		suggestion: null,
		verified: false,
	})
})

test('waitForDebounce resolves after the delay', async () => {
	const done = vi.fn()
	void waitForDebounce(300, new AbortController().signal).then(done)
	await vi.advanceTimersByTimeAsync(299)
	expect(done).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(1)
	expect(done).toHaveBeenCalled()
})

test('waitForDebounce rejects when the signal aborts', async () => {
	const controller = new AbortController()
	const waiting = waitForDebounce(300, controller.signal)
	controller.abort(new Error('superseded'))
	await expect(waiting).rejects.toThrow('superseded')
})
