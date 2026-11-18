import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
	createVerifiedHandleSuggestions,
	pickAvailableHandleSuggestion,
	type VerifiedHandleSuggestionState,
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

function harness(check: (candidate: string) => Promise<unknown>) {
	const states: Array<VerifiedHandleSuggestionState> = []
	const calls: Array<string> = []
	const controller = createVerifiedHandleSuggestions({
		onChange: (state) => states.push(state),
	})
	const suggestions = {
		request: (candidate: string | null) =>
			controller.request(candidate, (value) => {
				calls.push(value)
				return check(value)
			}),
	}
	return { suggestions, states, calls, last: () => states.at(-1) }
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

test('an available suggestion shows after the debounce', async () => {
	const h = harness(async (candidate) => available(candidate))
	h.suggestions.request('jsdklfjsdlsks-j')
	expect(h.last()).toEqual({
		status: 'checking',
		candidate: 'jsdklfjsdlsks-j',
		suggestion: null,
	})
	expect(h.calls).toEqual([])
	await vi.advanceTimersByTimeAsync(300)
	expect(h.calls).toEqual(['jsdklfjsdlsks-j'])
	expect(h.last()).toEqual({
		status: 'ready',
		candidate: 'jsdklfjsdlsks-j',
		suggestion: 'jsdklfjsdlsks-j',
	})
})

test('a taken suggestion is replaced by the first available variant', async () => {
	const h = harness(async (candidate) =>
		taken(candidate, [`${candidate}-2`, `${candidate}-3`]),
	)
	h.suggestions.request('kent-c')
	await vi.advanceTimersByTimeAsync(300)
	expect(h.last()).toEqual({
		status: 'ready',
		candidate: 'kent-c',
		suggestion: 'kent-c-2',
	})
})

test('no suggestion when nothing can be confirmed available', async () => {
	const noneFree = harness(async (candidate) => taken(candidate, []))
	noneFree.suggestions.request('kent-c')
	await vi.advanceTimersByTimeAsync(300)
	expect(noneFree.last()).toEqual({
		status: 'ready',
		candidate: 'kent-c',
		suggestion: null,
	})

	const failing = harness(async () => {
		throw new Error('network down')
	})
	failing.suggestions.request('kent-c')
	await vi.advanceTimersByTimeAsync(300)
	expect(failing.last()).toEqual({
		status: 'ready',
		candidate: 'kent-c',
		suggestion: null,
	})
})

test('typing debounces checks and a stale response never shows for newer input', async () => {
	const pending = new Map<string, (value: unknown) => void>()
	const h = harness(
		(candidate) =>
			new Promise((resolve) => {
				pending.set(candidate, resolve)
			}),
	)
	h.suggestions.request('abc-d')
	await vi.advanceTimersByTimeAsync(100)
	h.suggestions.request('abc-de')
	await vi.advanceTimersByTimeAsync(300)
	expect(h.calls).toEqual(['abc-de'])

	h.suggestions.request('abc-def')
	await vi.advanceTimersByTimeAsync(300)
	expect(h.calls).toEqual(['abc-de', 'abc-def'])

	pending.get('abc-de')?.(available('abc-de'))
	await vi.advanceTimersByTimeAsync(0)
	expect(h.last()).toEqual({
		status: 'checking',
		candidate: 'abc-def',
		suggestion: null,
	})

	pending.get('abc-def')?.(available('abc-def'))
	await vi.advanceTimersByTimeAsync(0)
	expect(h.last()).toEqual({
		status: 'ready',
		candidate: 'abc-def',
		suggestion: 'abc-def',
	})
	expect(
		h.states.some(
			(state) => state.status === 'ready' && state.candidate === 'abc-de',
		),
	).toBe(false)
})

test('clearing the candidate goes idle and cancels the pending check', async () => {
	const h = harness(async (candidate) => available(candidate))
	h.suggestions.request('abc-d')
	h.suggestions.request(null)
	await vi.advanceTimersByTimeAsync(300)
	expect(h.calls).toEqual([])
	expect(h.last()).toEqual({
		status: 'idle',
		candidate: null,
		suggestion: null,
	})
})

test('verified results are reused briefly; failed checks are retried', async () => {
	let fail = true
	const h = harness(async (candidate) => {
		if (fail) throw new Error('offline')
		return available(candidate)
	})
	h.suggestions.request('abc-d')
	await vi.advanceTimersByTimeAsync(300)
	fail = false
	h.suggestions.request('abc-d')
	await vi.advanceTimersByTimeAsync(300)
	expect(h.calls).toEqual(['abc-d', 'abc-d'])
	h.suggestions.request('abc-d')
	expect(h.last()).toEqual({
		status: 'ready',
		candidate: 'abc-d',
		suggestion: 'abc-d',
	})
	expect(h.calls).toEqual(['abc-d', 'abc-d'])
})
