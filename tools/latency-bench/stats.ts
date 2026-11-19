type Percentiles = {
	n: number
	p50: number
	p95: number
	p99: number
	min: number
}

export type PhaseSample = {
	/** Client-observed HTTP round trip for the request, in ms. */
	wallMs: number
	/** Server-reported tool duration (execute `timing.durationMs`), when present. */
	toolMs?: number
	/** Server-reported phase durations (execute `timing.serverTiming`). */
	phases?: Record<string, number>
}

export type PathSummary = {
	cold: PhaseSample | null
	warm: Percentiles & {
		tool?: Percentiles
		phases?: Record<string, Percentiles>
	}
	errors: number
	/** Error count per message (first 160 characters), when any sample failed. */
	failures?: Record<string, number>
}

export type OverheadSummary = {
	kodyPath: string
	directPath: string
	p50Ms: number
	p95Ms: number
}

/** Nearest-rank percentile; `p` in [0, 100]. */
function percentile(values: Array<number>, p: number) {
	if (values.length === 0) return Number.NaN
	const sorted = [...values].sort((a, b) => a - b)
	const rank = Math.ceil((p / 100) * sorted.length)
	return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] as number
}

function round1(value: number) {
	return Math.round(value * 10) / 10
}

function summarize(values: Array<number>): Percentiles {
	return {
		n: values.length,
		p50: round1(percentile(values, 50)),
		p95: round1(percentile(values, 95)),
		p99: round1(percentile(values, 99)),
		min: values.length ? round1(Math.min(...values)) : Number.NaN,
	}
}

export function summarizePath(input: {
	cold: PhaseSample | null
	warm: Array<PhaseSample>
	errors: number
	failures?: Record<string, number>
}): PathSummary {
	const walls = input.warm.map((sample) => sample.wallMs)
	const tools = input.warm
		.map((sample) => sample.toolMs)
		.filter((value): value is number => value !== undefined)
	const phaseNames = new Set(
		input.warm.flatMap((sample) => Object.keys(sample.phases ?? {})),
	)
	const phases: Record<string, Percentiles> = {}
	for (const name of phaseNames) {
		phases[name] = summarize(
			input.warm
				.map((sample) => sample.phases?.[name])
				.filter((value): value is number => value !== undefined),
		)
	}
	return {
		cold: input.cold,
		warm: {
			...summarize(walls),
			...(tools.length ? { tool: summarize(tools) } : {}),
			...(phaseNames.size ? { phases } : {}),
		},
		errors: input.errors,
		...(input.failures && Object.keys(input.failures).length
			? { failures: input.failures }
			: {}),
	}
}

/**
 * "Latency Kody adds" in Executor's sense: the Kody round trip minus the
 * round trip of the same underlying call made directly from the client.
 * Each row subtracts the two paths' percentiles (p50 − p50, p95 − p95); it is
 * not the percentile of per-call differences, since the calls are not paired.
 */
export function addedOverhead(
	kodyPath: string,
	kody: PathSummary,
	directPath: string,
	direct: PathSummary,
): OverheadSummary {
	return {
		kodyPath,
		directPath,
		p50Ms: round1(kody.warm.p50 - direct.warm.p50),
		p95Ms: round1(kody.warm.p95 - direct.warm.p95),
	}
}

export function formatMarkdown(report: {
	origin: string
	paths: Record<string, PathSummary>
	overhead: Array<OverheadSummary>
}) {
	const lines = [
		`### Latency bench — ${report.origin}`,
		'',
		'| path | cold ms | warm p50 | p95 | p99 | tool p50 | errors |',
		'| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
	]
	for (const [name, path] of Object.entries(report.paths)) {
		lines.push(
			`| ${name} | ${path.cold ? round1(path.cold.wallMs) : '—'} | ${path.warm.p50} | ${path.warm.p95} | ${path.warm.p99} | ${path.warm.tool?.p50 ?? '—'} | ${path.errors} |`,
		)
	}
	if (report.overhead.length) {
		lines.push(
			'',
			'| added over direct (percentile − percentile) | p50 ms | p95 ms |',
			'| --- | ---: | ---: |',
		)
		for (const entry of report.overhead) {
			lines.push(
				`| ${entry.kodyPath} − ${entry.directPath} | ${entry.p50Ms} | ${entry.p95Ms} |`,
			)
		}
	}
	return lines.join('\n')
}
