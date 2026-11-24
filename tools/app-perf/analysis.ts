import { gzipSync } from 'node:zlib'

export type ProbeEvent = {
	binding: string
	op: string
	at: number
	ms: number
	detail?: string
	stack?: string
}

export type RouteMeasurement = {
	status: number
	ttfbMs: number
	/** D1 round trips; a batch counts once. */
	d1: number
	/** Round trips to other bindings, by binding name. */
	other: Record<string, number>
	/** Round trips that had to wait for an earlier one to finish. */
	depth: number
	/** Identical D1 statements sent more than once, with their counts. */
	duplicates: Record<string, number>
	events: Array<ProbeEvent>
}

const isD1 = (event: ProbeEvent) => event.binding.endsWith('_DB')

/**
 * Number of sequential stages: round trips that overlap in time count as one
 * stage. Production latency is roughly this number times one round trip.
 */
export function sequentialDepth(events: ReadonlyArray<ProbeEvent>) {
	const intervals = events
		.map((event) => [event.at, event.at + Math.max(event.ms, 0)] as const)
		.sort((a, b) => a[0] - b[0] || a[1] - b[1])
	let stages = 0
	let end = -Infinity
	for (const [start, finish] of intervals) {
		if (start >= end) {
			stages += 1
			// Local D1 often answers within the same millisecond.
			end = Math.max(finish, start + 0.5)
		} else {
			end = Math.max(end, finish)
		}
	}
	return stages
}

export function duplicateStatements(events: ReadonlyArray<ProbeEvent>) {
	const counts = new Map<string, number>()
	for (const event of events) {
		if (!isD1(event) || !event.detail || event.detail.startsWith('batch(')) {
			continue
		}
		counts.set(event.detail, (counts.get(event.detail) ?? 0) + 1)
	}
	return Object.fromEntries([...counts].filter(([, count]) => count > 1))
}

export function measureRoute(
	status: number,
	ttfbMs: number,
	events: Array<ProbeEvent>,
): RouteMeasurement {
	const other: Record<string, number> = {}
	for (const event of events) {
		if (!isD1(event)) other[event.binding] = (other[event.binding] ?? 0) + 1
	}
	return {
		status,
		ttfbMs: Math.round(ttfbMs),
		d1: events.filter(isD1).length,
		other,
		depth: sequentialDepth(events),
		duplicates: duplicateStatements(events),
		events,
	}
}

export function formatComparison(
	before: Record<string, RouteMeasurement>,
	after: Record<string, RouteMeasurement>,
) {
	const lines = [
		'| Route | D1 round trips | Sequential depth |',
		'| --- | ---: | ---: |',
	]
	const d1 = [0, 0]
	const depth = [0, 0]
	for (const [route, a] of Object.entries(before)) {
		const b = after[route]
		if (!b) continue
		d1[0]! += a.d1
		d1[1]! += b.d1
		depth[0]! += a.depth
		depth[1]! += b.depth
		if (a.d1 === b.d1 && a.depth === b.depth) continue
		lines.push(`| \`${route}\` | ${a.d1} → ${b.d1} | ${a.depth} → ${b.depth} |`)
	}
	lines.push(
		`| **All compared routes** | ${d1.join(' → ')} | ${depth.join(' → ')} |`,
	)
	return lines.join('\n')
}

const staticImport =
	/(?:import|export)\s*(?:[\w${},*\s]+?\s*from\s*)?["']\.\/([^"']+\.js)["']/g

export type ChunkGraph = Map<
	string,
	{ gzipBytes: number; imports: Array<string> }
>

/** `sources` maps a chunk file name to its code; imports are sibling `./x.js`. */
export function buildChunkGraph(
	sources: ReadonlyMap<string, string>,
): ChunkGraph {
	const graph: ChunkGraph = new Map()
	for (const [name, code] of sources) {
		const imports = [...code.matchAll(staticImport)]
			.map((match) => match[1]!)
			.filter((file) => sources.has(file))
		graph.set(name, {
			gzipBytes: gzipSync(code, { level: 6 }).length,
			imports,
		})
	}
	return graph
}

/** Every chunk a browser must download before `roots` can run. */
export function staticClosure(graph: ChunkGraph, roots: Iterable<string>) {
	const seen = new Set<string>()
	const pending = [...roots]
	while (pending.length) {
		const name = pending.pop()!
		if (seen.has(name)) continue
		seen.add(name)
		pending.push(...(graph.get(name)?.imports ?? []))
	}
	return seen
}

export function gzipBytes(graph: ChunkGraph, chunks: Iterable<string>) {
	let total = 0
	for (const name of chunks) total += graph.get(name)?.gzipBytes ?? 0
	return total
}
