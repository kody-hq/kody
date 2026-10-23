import { expect, test } from 'vitest'
import { addedOverhead, percentile, summarizePath } from './stats.ts'

test('percentile uses nearest rank and clamps to the sample range', () => {
	const values = [5, 1, 4, 2, 3]
	expect(percentile(values, 50)).toBe(3)
	expect(percentile(values, 95)).toBe(5)
	expect(percentile(values, 0)).toBe(1)
	expect(percentile([], 50)).toBeNaN()
})

test('summarizePath reports wall, tool, and per-phase percentiles for warm samples only', () => {
	const summary = summarizePath({
		cold: { wallMs: 900, toolMs: 850, phases: { bundle: 700 } },
		warm: [
			{ wallMs: 70, toolMs: 36, phases: { bundle: 4, sandbox: 15 } },
			{ wallMs: 80, toolMs: 40, phases: { bundle: 5, sandbox: 20 } },
			{ wallMs: 75, phases: { bundle: 6 } },
		],
		errors: 1,
	})
	expect(summary.cold?.wallMs).toBe(900)
	expect(summary.warm).toMatchObject({ n: 3, p50: 75, p95: 80, min: 70 })
	expect(summary.warm.tool).toMatchObject({ n: 2, p50: 36, p95: 40 })
	expect(summary.warm.phases?.sandbox).toMatchObject({ n: 2, p50: 15 })
	expect(summary.warm.phases?.bundle).toMatchObject({ n: 3, p50: 5 })
	expect(summary.errors).toBe(1)
})

test('addedOverhead subtracts the direct call', () => {
	const kody = summarizePath({
		cold: null,
		warm: [{ wallMs: 83.1 }, { wallMs: 141 }],
		errors: 0,
	})
	const direct = summarizePath({
		cold: null,
		warm: [{ wallMs: 2 }, { wallMs: 3.7 }],
		errors: 0,
	})
	const overhead = addedOverhead('execute-mcp', kody, 'direct-mcp', direct)
	expect(overhead).toEqual({
		kodyPath: 'execute-mcp',
		directPath: 'direct-mcp',
		p50Ms: 81.1,
		p95Ms: 137.3,
	})
})
