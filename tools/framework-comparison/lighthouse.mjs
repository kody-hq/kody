#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { cpus, platform, arch } from 'node:os'

const [baselineOrigin, candidateOrigin, outputArg, countArg = '5'] =
	process.argv.slice(2)
if (!baselineOrigin || !candidateOrigin || !outputArg) {
	throw new Error(
		'Usage: node lighthouse.mjs BASELINE_ORIGIN CANDIDATE_ORIGIN OUTPUT_DIRECTORY [RUNS]',
	)
}
const count = Number(countArg)
if (!Number.isInteger(count) || count < 1)
	throw new Error('RUNS must be a positive integer')
const output = resolve(outputArg)
mkdirSync(output, { recursive: true })
const chromePath =
	process.env.CHROME_PATH ??
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const chromeVersion = spawnSync(chromePath, ['--version'], {
	encoding: 'utf8',
}).stdout?.trim()
const pages = [
	{ name: 'home', path: '/' },
	{ name: 'pricing', path: '/pricing' },
	{ name: 'docs', path: '/docs' },
]
const targets = [
	{ label: 'remix', origin: baselineOrigin },
	{ label: 'start', origin: candidateOrigin },
]
for (const target of targets) {
	for (const page of pages) {
		const response = await fetch(new URL(page.path, target.origin), {
			signal: AbortSignal.timeout(10_000),
		})
		if (response.status !== 200)
			throw new Error(
				`Production preflight failed: ${target.label}${page.path} returned ${response.status}`,
			)
		const html = await response.text()
		if (!html.includes('<title>') || html.includes('/@vite/client'))
			throw new Error(
				`Expected production HTML for ${target.label}${page.path}`,
			)
	}
}
const results = []
const metadata = {
	startedAt: new Date().toISOString(),
	node: process.version,
	platform: platform(),
	architecture: arch(),
	cpu: cpus()[0]?.model,
	chromeVersion,
	lighthouseVersion: '13.5.0',
	count,
	targets,
	cache:
		'Lighthouse default storage reset; fresh Chrome process for every audit',
	throttling: 'Lighthouse simulated mobile defaults, desktop preset defaults',
	order: 'Sequential paired audits, reversed target order on alternating runs',
	caveats: [
		'Local optimized production builds, not deployed edge or global network measurements.',
		'Public unauthenticated pages only; Lighthouse does not prove functional parity.',
		'External media/font availability and laptop load can affect results.',
		'No scores or failures are discarded; raw reports and stderr logs are retained.',
	],
}
function save() {
	writeFileSync(
		join(output, 'runs.json'),
		JSON.stringify(
			{ ...metadata, updatedAt: new Date().toISOString(), results },
			null,
			2,
		) + '\n',
	)
}
save()
for (const page of pages) {
	for (const mode of ['mobile', 'desktop']) {
		for (let run = 1; run <= count; run++) {
			for (const target of run % 2 ? targets : [...targets].reverse()) {
				const url = new URL(page.path, target.origin).href
				const id = `${target.label}-${page.name}-${mode}-${run}`
				const reportPath = join(output, id)
				for (const suffix of ['.report.json', '.report.html'])
					rmSync(reportPath + suffix, { force: true })
				const args = [
					'exec',
					'--yes',
					'--package=lighthouse@13.5.0',
					'--',
					'lighthouse',
					url,
					'--chrome-flags=--headless=new',
					'--only-categories=performance,accessibility,best-practices,seo',
					'--output=json',
					'--output=html',
					`--output-path=${reportPath}`,
					'--quiet',
				]
				if (mode === 'desktop') args.push('--preset=desktop')
				const started = performance.now()
				console.log(`${new Date().toISOString()} ${id} starting`)
				const result = spawnSync('npm', args, {
					encoding: 'utf8',
					timeout: 240_000,
					maxBuffer: 30_000_000,
					env: { ...process.env, CHROME_PATH: chromePath },
				})
				writeFileSync(
					`${reportPath}.log`,
					`${result.stdout ?? ''}\n${result.stderr ?? ''}`,
				)
				let report
				let reportError = null
				try {
					report = JSON.parse(readFileSync(`${reportPath}.report.json`, 'utf8'))
				} catch (error) {
					reportError = error.message
				}
				const audits = report?.audits ?? {}
				const value = (key) => audits[key]?.numericValue ?? null
				const entry = {
					id,
					label: target.label,
					page: page.name,
					mode,
					run,
					url,
					elapsedMs: performance.now() - started,
					exitCode: result.status,
					error: result.error?.message ?? reportError,
					runtimeError: report?.runtimeError ?? null,
					finalUrl: report?.finalDisplayedUrl ?? report?.finalUrl ?? null,
					lighthouseVersion: report?.lighthouseVersion ?? null,
					fetchTime: report?.fetchTime ?? null,
					scores: Object.fromEntries(
						Object.entries(report?.categories ?? {}).map(([key, category]) => [
							key,
							category.score,
						]),
					),
					metrics: {
						fcpMs: value('first-contentful-paint'),
						lcpMs: value('largest-contentful-paint'),
						cls: value('cumulative-layout-shift'),
						tbtMs: value('total-blocking-time'),
						speedIndexMs: value('speed-index'),
						ttfbMs: value('server-response-time'),
						transferBytes: value('total-byte-weight'),
						requestCount:
							audits['network-requests']?.details?.items?.length ?? null,
					},
					warnings: report?.runWarnings ?? [],
				}
				results.push(entry)
				save()
				console.log(JSON.stringify(entry))
			}
		}
	}
}
process.exitCode = results.some(
	(result) => result.exitCode !== 0 || result.runtimeError,
)
	? 1
	: 0
