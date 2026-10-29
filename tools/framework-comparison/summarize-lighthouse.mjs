#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
const [directoryArg] = process.argv.slice(2)
if (!directoryArg)
	throw new Error('Usage: node summarize-lighthouse.mjs REPORT_DIRECTORY')
const directory = resolve(directoryArg)
const report = JSON.parse(readFileSync(join(directory, 'runs.json'), 'utf8'))
function stats(values) {
	const sorted = values
		.filter((value) => typeof value === 'number' && Number.isFinite(value))
		.sort((a, b) => a - b)
	if (!sorted.length) return { count: 0, median: null, min: null, max: null }
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
const groups = []
const labels = report.targets?.map((target) => target.label) ?? [
	...new Set(report.results.map((run) => run.label)),
]
for (const label of labels)
	for (const page of report.pages ?? ['home', 'pricing', 'docs'])
		for (const mode of report.modes ?? ['mobile', 'desktop']) {
			const runs = report.results.filter(
				(run) => run.label === label && run.page === page && run.mode === mode,
			)
			const validRuns = runs.filter(
				(run) => run.exitCode === 0 && !run.runtimeError && !run.error,
			)
			groups.push({
				label,
				page,
				mode,
				attempts: runs.length,
				failures: runs.filter(
					(run) => run.exitCode !== 0 || run.runtimeError || run.error,
				),
				scores: Object.fromEntries(
					['performance', 'accessibility', 'best-practices', 'seo'].map(
						(key) => [
							key,
							stats(
								validRuns.map((run) =>
									run.scores[key] == null ? null : run.scores[key] * 100,
								),
							),
						],
					),
				),
				metrics: Object.fromEntries(
					[
						'fcpMs',
						'lcpMs',
						'cls',
						'tbtMs',
						'speedIndexMs',
						'ttfbMs',
						'transferBytes',
						'requestCount',
					].map((key) => [
						key,
						stats(validRuns.map((run) => run.metrics[key])),
					]),
				),
			})
		}
const summary = { metadata: { ...report, results: undefined }, groups }
writeFileSync(
	join(directory, 'summary.json'),
	JSON.stringify(summary, null, 2) + '\n',
)
const formatted = (result, digits = 0) =>
	result.count
		? `${result.median.toFixed(digits)} (${result.min.toFixed(digits)}–${result.max.toFixed(digits)})`
		: 'unavailable'
const successful = report.results.find(
	(run) => run.exitCode === 0 && !run.error && !run.runtimeError,
)
let sample
try {
	sample = successful
		? JSON.parse(
				readFileSync(join(directory, `${successful.id}.report.json`), 'utf8'),
			)
		: undefined
} catch {}
const lighthouseVersion =
	report.lighthouseVersion ??
	successful?.lighthouseVersion ??
	'version unavailable'
const chromeVersion =
	report.chromeVersion ??
	sample?.environment?.hostUserAgent ??
	'browser version unavailable'
const throttling =
	report.throttling ??
	(report.throttlingMethod === 'devtools'
		? 'Applied DevTools network/CPU throttling, not standard simulated Lighthouse scoring'
		: (report.throttlingMethod ?? 'throttling unavailable'))
let markdown = `# Production Lighthouse comparison\n\n${lighthouseVersion}, ${chromeVersion}. Each cell shows median (minimum–maximum). Target: ${report.count} runs per page, device and framework.\n\n`
markdown +=
	'| Framework | Page | Device | Runs / failures | Performance | Accessibility | Best practices | SEO |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n'
for (const group of groups)
	markdown += `| ${group.label} | ${group.page} | ${group.mode} | ${group.attempts} / ${group.failures.length} | ${['performance', 'accessibility', 'best-practices', 'seo'].map((key) => formatted(group.scores[key])).join(' | ')} |\n`
markdown +=
	'\n| Framework | Page | Device | FCP ms | LCP ms | TTFB ms | TBT ms | CLS | Speed Index ms | Transfer bytes | Requests |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n'
for (const group of groups)
	markdown += `| ${group.label} | ${group.page} | ${group.mode} | ${['fcpMs', 'lcpMs', 'ttfbMs', 'tbtMs', 'cls', 'speedIndexMs', 'transferBytes', 'requestCount'].map((key) => formatted(group.metrics[key], key === 'cls' ? 3 : 0)).join(' | ')} |\n`
markdown += `\nSettings: ${report.cache}. ${throttling}. ${report.order}.\n\n`
markdown += report.caveats.map((caveat) => `- ${caveat}`).join('\n') + '\n'
if (report.results.some((run) => run.warnings?.length))
	markdown +=
		'\nRun warnings are retained in `runs.json` and each raw report.\n'
if (groups.some((group) => group.failures.length))
	markdown +=
		'\nFailures remain in the report. Numeric summaries use only successful full audit reports, so inspect sample counts in `summary.json` before comparing groups.\n'
writeFileSync(join(directory, 'SUMMARY.md'), markdown)
console.log(markdown)
