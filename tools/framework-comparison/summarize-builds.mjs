#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const [directoryArg] = process.argv.slice(2)
if (!directoryArg)
	throw new Error('Usage: node summarize-builds.mjs REPORT_DIRECTORY')
const directory = resolve(directoryArg)
const input = JSON.parse(
	readFileSync(join(directory, 'paired-builds.json'), 'utf8'),
)
function stats(values) {
	const sorted = values.slice().sort((a, b) => a - b)
	const middle = Math.floor(sorted.length / 2)
	return {
		count: sorted.length,
		median:
			sorted.length % 2
				? sorted[middle]
				: (sorted[middle - 1] + sorted[middle]) / 2,
		min: sorted[0],
		max: sorted.at(-1),
	}
}
const frameworks = ['remix', 'start'].map((framework) => {
	const reports = input.reports.filter(
		(report) => report.framework === framework,
	)
	const last = reports.at(-1)
	const assets = (kind) => {
		const selected = last.assets.filter((asset) =>
			kind === 'client'
				? asset.path.includes('/client/')
				: !asset.path.includes('/client/'),
		)
		return {
			files: selected.length,
			bytes: selected.reduce((sum, asset) => sum + asset.bytes, 0),
			gzipBytes: selected.reduce((sum, asset) => sum + asset.gzipBytes, 0),
		}
	}
	return {
		framework,
		buildMs: stats(
			reports.flatMap((report) => report.runs.map((run) => run.elapsedMs)),
		),
		client: assets('client'),
		server: assets('server'),
		source: {
			files: last.source.length,
			lines: last.source.reduce((sum, file) => sum + file.lines, 0),
		},
	}
})
const summary = {
	frameworks,
	caveats: [
		...input.caveats,
		'JS/CSS asset totals include every lazy chunk and are not initial page transfer sizes.',
		'Gzip values sum individually compressed files.',
		'Whole-worker source volume includes retained code and is not a measure of maintainability.',
	],
}
writeFileSync(
	join(directory, 'summary.json'),
	JSON.stringify(summary, null, 2) + '\n',
)
let markdown =
	'# Paired production build comparison\n\n| Framework | Warm builds | Median ms | Minimum ms | Maximum ms | Client JS/CSS bytes | Client per-file gzip bytes | Server JS/CSS bytes | Server per-file gzip bytes |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n'
for (const row of frameworks)
	markdown += `| ${row.framework} | ${row.buildMs.count} | ${row.buildMs.median.toFixed(0)} | ${row.buildMs.min.toFixed(0)} | ${row.buildMs.max.toFixed(0)} | ${row.client.bytes} | ${row.client.gzipBytes} | ${row.server.bytes} | ${row.server.gzipBytes} |\n`
markdown +=
	'\n' + summary.caveats.map((caveat) => `- ${caveat}`).join('\n') + '\n'
writeFileSync(join(directory, 'SUMMARY.md'), markdown)
console.log(markdown)
