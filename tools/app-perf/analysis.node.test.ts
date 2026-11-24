import { expect, test } from 'vitest'
import {
	buildChunkGraph,
	duplicateStatements,
	formatComparison,
	gzipBytes,
	measureRoute,
	sequentialDepth,
	staticClosure,
	type ProbeEvent,
} from './analysis.ts'

function event(
	at: number,
	ms: number,
	detail: string | undefined = 'SELECT 1',
	binding = 'APP_DB',
) {
	return { binding, op: 'all', at, ms, detail } satisfies ProbeEvent
}

test('overlapping round trips are one sequential stage', () => {
	expect(sequentialDepth([])).toBe(0)
	expect(sequentialDepth([event(0, 5), event(1, 5), event(2, 9)])).toBe(1)
	expect(sequentialDepth([event(0, 5), event(5, 5), event(12, 1)])).toBe(3)
	// Same-millisecond local reads that started together still count once.
	expect(sequentialDepth([event(3, 0), event(3, 0), event(4, 0)])).toBe(2)
	// A slow call beside a chain of three does not hide the chain.
	expect(
		sequentialDepth([event(0, 30), event(1, 5), event(8, 5), event(15, 5)]),
	).toBe(3)
})

test('a route measurement separates D1 from other bindings and names repeats', () => {
	const events = [
		event(0, 1, 'SELECT * FROM orgs WHERE slug = ?'),
		event(2, 1, 'SELECT * FROM orgs WHERE slug = ?'),
		event(4, 1, 'batch(3)'),
		event(6, 1, 'batch(3)'),
		event(8, 2, undefined, 'SESSION_DO'),
	]
	expect(duplicateStatements(events)).toEqual({
		'SELECT * FROM orgs WHERE slug = ?': 2,
	})
	expect(measureRoute(200, 12.4, events)).toMatchObject({
		status: 200,
		ttfbMs: 12,
		d1: 4,
		other: { SESSION_DO: 1 },
		depth: 5,
	})
})

test('the comparison lists changed routes and totals every shared route', () => {
	const before = {
		'/a': measureRoute(200, 1, [event(0, 1), event(2, 1)]),
		'/b': measureRoute(200, 1, [event(0, 1)]),
	}
	const after = {
		'/a': measureRoute(200, 1, [event(0, 1)]),
		'/b': measureRoute(200, 1, [event(0, 1)]),
	}
	const table = formatComparison(before, after)
	expect(table).toContain('| `/a` | 2 → 1 | 2 → 1 |')
	expect(table).not.toContain('`/b`')
	expect(table).toContain('| **All compared routes** | 3 → 2 | 3 → 2 |')
})

test('a page that started failing is not reported as faster', () => {
	const table = formatComparison(
		{ '/a': measureRoute(200, 1, [event(0, 1), event(2, 1)]) },
		{ '/a': measureRoute(500, 1, []) },
	)
	expect(table).toContain('| `/a` | status 200 → 500 | not comparable |')
	expect(table).toContain('| **All compared routes** | 0 → 0 | 0 → 0 |')
})

test('the static closure follows static imports and stops at dynamic ones', () => {
	const graph = buildChunkGraph(
		new Map([
			['index-a.js', 'import{x}from"./shared-b.js";import("./lazy-c.js")'],
			['shared-b.js', 'export*from"./leaf-d.js";export const x=1'],
			['lazy-c.js', 'import"./shared-b.js";export default 2'],
			['leaf-d.js', 'export const y=1'],
		]),
	)
	const entry = staticClosure(graph, ['index-a.js'])
	expect([...entry].sort()).toEqual(['index-a.js', 'leaf-d.js', 'shared-b.js'])
	expect(gzipBytes(graph, entry)).toBeGreaterThan(0)
	expect(staticClosure(graph, ['lazy-c.js']).has('index-a.js')).toBe(false)
})
