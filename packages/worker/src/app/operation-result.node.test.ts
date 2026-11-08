import { expect, test } from 'vitest'
import { operationResult, requireOperationResult } from './operation-result.ts'

test('operationResult wraps data with an HTTP status', () => {
	expect(operationResult({ ok: true as const, name: 'demo' }, 200)).toEqual({
		data: { ok: true, name: 'demo' },
		status: 200,
		headers: undefined,
	})
	expect(
		operationResult({ ok: false as const, error: 'Nope.' }, { status: 400 }),
	).toEqual({
		data: { ok: false, error: 'Nope.' },
		status: 400,
		headers: undefined,
	})
})

test('requireOperationResult returns data for a 2xx wrapper', () => {
	expect(
		requireOperationResult({
			data: { ok: true as const, name: 'demo' },
			status: 200,
		}),
	).toEqual({ ok: true, name: 'demo' })
})

test('requireOperationResult throws on 4xx/5xx with the payload error string', () => {
	expect(() =>
		requireOperationResult({
			data: { ok: false as const, error: 'Nope.' },
			status: 400,
		}),
	).toThrow('Nope.')
})

test('requireOperationResult refuses an already-unwrapped community install payload', () => {
	// Historical footgun: payload.status is `'installed'`, not an HTTP code.
	// Before the guard, this returned undefined and the Fork UI threw on `.ok`.
	expect(() =>
		requireOperationResult({
			ok: true,
			status: 'installed',
			targetName: '@nstudio/tanstack-github-dashboard',
			agentPrompt: 'Review then publish.',
		} as never),
	).toThrow('Unable to complete operation.')
})

test('requireOperationResult refuses a 2xx wrapper with missing data', () => {
	expect(() =>
		requireOperationResult({ data: undefined, status: 200 } as never),
	).toThrow('Unable to complete operation.')
})
