import { expect, test } from 'vitest'
import { envWithNodeHeapFloor, nodeHeapFloorMb } from './node-runtime.ts'

test('envWithNodeHeapFloor adds an 8GB heap when NODE_OPTIONS is unset', () => {
	expect(envWithNodeHeapFloor({}).NODE_OPTIONS).toBe(
		`--max-old-space-size=${nodeHeapFloorMb}`,
	)
})

test('envWithNodeHeapFloor leaves an explicit heap flag alone', () => {
	const env = { NODE_OPTIONS: '--max-old-space-size=4096' }
	expect(envWithNodeHeapFloor(env)).toBe(env)
	expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096')
})

test('envWithNodeHeapFloor appends beside other NODE_OPTIONS flags', () => {
	expect(
		envWithNodeHeapFloor({ NODE_OPTIONS: '--no-warnings' }).NODE_OPTIONS,
	).toBe(`--no-warnings --max-old-space-size=${nodeHeapFloorMb}`)
})
