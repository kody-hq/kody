import { expect, test } from 'vitest'
import { incompletePaths, isComplete, parseArgs } from './run.ts'
import { summarizePath } from './stats.ts'

const complete = summarizePath({
	cold: { wallMs: 100 },
	warm: [{ wallMs: 70 }, { wallMs: 80 }],
	errors: 0,
})

test('isComplete requires a cold sample, every warm sample, and no errors', () => {
	expect(isComplete(complete, 2)).toBe(true)
	expect(isComplete(complete, 3)).toBe(false)
	expect(isComplete({ ...complete, cold: null }, 2)).toBe(false)
	expect(isComplete({ ...complete, errors: 1 }, 2)).toBe(false)
})

test('incompletePaths names the paths that must fail the run', () => {
	expect(
		incompletePaths({
			origin: 'http://localhost:3742',
			measuredAt: '2026-10-10T00:00:00.000Z',
			n: 2,
			paths: {
				'execute-noop': complete,
				search: { ...complete, errors: 2 },
			},
			overhead: [],
		}),
	).toEqual(['search'])
})

test('parseArgs refuses password login against production and reads flags', () => {
	expect(() => parseArgs(['--origin', 'https://kody.codes'])).toThrow(/--token/)
	const options = parseArgs([
		'--origin',
		'https://kody.codes/',
		'--token',
		'abc',
		'--n',
		'5',
		'--mcp-args',
		'{"repoName":"x"}',
		'--concurrency',
		'3',
	])
	expect(options).toMatchObject({
		origin: 'https://kody.codes',
		token: 'abc',
		n: 5,
		concurrency: 3,
		mcpArgs: { repoName: 'x' },
	})
})

test('parseArgs rejects a concurrency below one', () => {
	expect(() => parseArgs(['--concurrency', '0'])).toThrow(/--concurrency/)
})

test('summarizePath keeps failure counts only when a sample failed', () => {
	expect(complete).not.toHaveProperty('failures')
	expect(
		summarizePath({
			cold: null,
			warm: [{ wallMs: 70 }],
			errors: 2,
			failures: { 'too large to bundle': 2 },
		}).failures,
	).toEqual({ 'too large to bundle': 2 })
})
