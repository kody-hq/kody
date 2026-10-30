#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { gzipSync } from 'node:zlib'

// One fresh process per variant per round. Imports and first highlight are cold;
// warm timing samples adapt to at least 50 ms and include every raw sample.
const [entryPath, fixturesPath, outputPath] = process.argv.slice(2)
const fixtures = JSON.parse(await readFile(fixturesPath, 'utf8'))
const started = performance.now()
const entry = await import(entryPath)
const importMs = performance.now() - started
const coldStarted = performance.now()
const highlighted = entry.highlight(fixtures.snippets)
const firstHighlightMs = performance.now() - coldStarted
let sink = 0
function measure(operation) {
	for (let index = 0; index < 5; index++)
		sink += JSON.stringify(operation()).length
	const pilot = performance.now()
	operation()
	const iterations = Math.min(
		1000,
		Math.max(1, Math.ceil(50 / Math.max(0.01, performance.now() - pilot))),
	)
	const samplesMs = []
	for (let sample = 0; sample < 15; sample++) {
		const start = performance.now()
		for (let index = 0; index < iterations; index++) {
			const value = operation()
			sink += value.length
		}
		samplesMs.push((performance.now() - start) / iterations)
	}
	const sorted = [...samplesMs].sort((a, b) => a - b)
	return { iterations, samplesMs, medianMs: sorted[7], p95Ms: sorted[14] }
}
const results = {
	importMs,
	firstHighlightMs,
	highlight: measure(() => entry.highlight(fixtures.snippets)),
	documents: [],
}
for (const document of fixtures.documents) {
	const fences = entry.highlight(entry.parse(document.markdown))
	const html = entry.render(document.markdown, fences)
	results.documents.push({
		path: document.path,
		fenceCount: fences.length,
		htmlBytes: Buffer.byteLength(html),
		htmlGzipBytes: gzipSync(html, { level: 9 }).length,
		parse: measure(() => entry.parse(document.markdown)),
		render: measure(() => entry.render(document.markdown, fences)),
		pipeline: measure(() => entry.pipeline(document.markdown)),
	})
}
const wire = JSON.stringify({ results: highlighted })
results.highlightPayload = {
	snippets: highlighted.length,
	plainSnippets: highlighted.filter((snippet) => snippet.plain).length,
	spans: highlighted.reduce(
		(sum, snippet) =>
			sum + snippet.lines.reduce((count, line) => count + line.length, 0),
		0,
	),
	bytes: Buffer.byteLength(wire),
	gzipBytes: gzipSync(wire, { level: 9 }).length,
}
results.sink = sink
await writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`)
