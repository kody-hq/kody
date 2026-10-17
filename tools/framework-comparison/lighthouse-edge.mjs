#!/usr/bin/env node
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import {
	readEdgeAuth,
	makeSanitizer,
	installEdgeAuth,
	deliveryHeaders,
} from './edge-auth.mjs'

const [
	baselineOrigin,
	candidateOrigin,
	outputArg,
	packageDirectory,
	countArg = '5',
] = process.argv.slice(2)
if (!baselineOrigin || !candidateOrigin || !outputArg || !packageDirectory)
	throw new Error(
		'Usage: node lighthouse-edge.mjs BASELINE_ORIGIN CANDIDATE_ORIGIN OUTPUT_DIRECTORY LIGHTHOUSE_PACKAGE_DIRECTORY [RUNS]',
	)
const count = Number(countArg)
if (!Number.isInteger(count) || count < 1)
	throw new Error('RUNS must be a positive integer')
const output = resolve(outputArg)
const prior =
	process.env.EDGE_RESUME === '1' && existsSync(join(output, 'runs.json'))
		? JSON.parse(readFileSync(join(output, 'runs.json'), 'utf8'))
		: null
if (existsSync(join(output, 'runs.json')) && !prior)
	throw new Error(
		'Use a fresh output directory, existing runs cannot be overwritten',
	)
mkdirSync(output, { recursive: true })
const auth = readEdgeAuth()
const sanitize = makeSanitizer(auth)
const targets = [
	{ label: 'remix', origin: baselineOrigin },
	{ label: 'start', origin: candidateOrigin },
]
for (const target of targets) {
	const url = new URL(target.origin)
	if (url.origin !== target.origin || url.protocol !== 'https:')
		throw new Error('Targets must be exact HTTPS origins')
	if (!auth.has(target.origin))
		throw new Error(
			'Every private target needs an explicitly configured Access service token',
		)
}
const require = createRequire(join(resolve(packageDirectory), 'package.json'))
const { default: lighthouse } = await import(
	pathToFileURL(require.resolve('lighthouse')).href
)
const { default: puppeteer } = await import(
	pathToFileURL(require.resolve('puppeteer-core')).href
)
const { ReportGenerator } = await import(
	pathToFileURL(
		join(resolve(packageDirectory), 'report/generator/report-generator.js'),
	).href
)
const { default: desktopConfig } = await import(
	pathToFileURL(
		join(resolve(packageDirectory), 'core/config/desktop-config.js'),
	).href
)
const chromePath =
	process.env.CHROME_PATH ??
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const pages = [
	{
		name: 'home',
		path: '/',
		heading: 'You shouldn’t have to start over in every agent.',
	},
	{
		name: 'pricing',
		path: '/pricing',
		heading: 'Start free.Pay when Kody earns it.',
	},
	{ name: 'docs', path: '/docs', heading: 'What is Kody?' },
]
const requestedPages = process.env.EDGE_PAGES?.split(',') ?? [
	'home',
	'pricing',
	'docs',
]
const modes = process.env.EDGE_MODES?.split(',') ?? ['mobile', 'desktop']
const throttlingMethod = process.env.EDGE_THROTTLING_METHOD ?? 'simulate'
if (
	!requestedPages.every((name) => pages.some((page) => page.name === name)) ||
	!modes.every((mode) => ['mobile', 'desktop'].includes(mode)) ||
	!['simulate', 'devtools'].includes(throttlingMethod)
)
	throw new Error('Invalid edge measurement selection')
if (
	prior &&
	(JSON.stringify(prior.targets) !== JSON.stringify(targets) ||
		prior.throttlingMethod !== throttlingMethod ||
		prior.count !== count ||
		JSON.stringify(prior.pages) !== JSON.stringify(requestedPages) ||
		JSON.stringify(prior.modes) !== JSON.stringify(modes))
)
	throw new Error('Resume settings must match the existing run exactly')
const selectedPages = pages.filter((page) => requestedPages.includes(page.name))
const results = prior?.results ?? []
let stopRequested = false
for (const signal of ['SIGINT', 'SIGTERM'])
	process.on(signal, () => {
		stopRequested = true
	})
const metadata = {
	startedAt: prior?.startedAt ?? new Date().toISOString(),
	resumeHistory: [
		...(prior?.resumeHistory ?? []),
		...(prior ? [new Date().toISOString()] : []),
	],
	throttlingMethod,
	pages: requestedPages,
	modes,
	count,
	targets,
	cache:
		'Fresh Chrome/cache per audit; edge and Worker cache state uncontrolled and recorded, not called cold edge',
	order: 'Paired sequential audits, target order reversed on alternating runs',
	auth: 'Origin-scoped Cloudflare Access service-token request headers, omitted from persisted evidence',
	caveats: [
		'Both targets must use matched Cloudflare region/account, bindings, data, assets and Access policy.',
		'Preflight warms document paths. Fresh browser does not mean cold edge or cold Worker.',
		'Access and request-interception overhead is present on both sides; deployed user sessions may differ.',
		'No cache purge or Worker cold-start claim is made.',
		'Only allowlisted response delivery metadata is retained; raw request/response headers are removed.',
	],
}
function save() {
	writeFileSync(
		join(output, 'runs.json'),
		JSON.stringify(
			sanitize({ ...metadata, updatedAt: new Date().toISOString(), results }),
			null,
			2,
		) + '\n',
	)
}
// Reject Access login pages or redirects before measuring; do not follow credentialed redirects.
for (const target of targets)
	for (const page of selectedPages) {
		const response = await fetch(new URL(page.path, target.origin), {
			headers: auth.get(target.origin),
			redirect: 'manual',
			signal: AbortSignal.timeout(30000),
		})
		const html = await response.text()
		if (
			response.status !== 200 ||
			!html.includes('<title>') ||
			!html.includes('<main') ||
			/cloudflareaccess\.com/.test(html)
		)
			throw new Error(
				`Private application preflight failed: ${target.label}${page.path}`,
			)
	}
save()
auditLoop: for (const pageSpec of selectedPages)
	for (const mode of modes)
		for (let run = 1; run <= count; run++)
			for (const target of run % 2 ? targets : [...targets].reverse()) {
				const slot = `${target.label}-${pageSpec.name}-${mode}-${run}`
				const attempts = results.filter(
					(row) =>
						row.label === target.label &&
						row.page === pageSpec.name &&
						row.mode === mode &&
						row.run === run,
				)
				if (
					attempts.some(
						(row) => row.exitCode === 0 && !row.error && !row.runtimeError,
					)
				)
					continue
				const id = attempts.length
					? `${slot}-attempt-${attempts.length + 1}`
					: slot
				const url = new URL(pageSpec.path, target.origin).href
				let browser
				const started = performance.now()
				const pageErrors = []
				const consoleMessages = []
				let entry = {
					id,
					label: target.label,
					page: pageSpec.name,
					mode,
					run,
					url,
					exitCode: 0,
					error: null,
					runtimeError: null,
				}
				try {
					browser = await puppeteer.launch({
						executablePath: chromePath,
						headless: true,
						timeout: 30000,
					})
					const page = await browser.newPage()
					page.on('pageerror', (error) =>
						pageErrors.push(sanitize(error.message)),
					)
					page.on('console', (message) => {
						if (['error', 'warn'].includes(message.type()))
							consoleMessages.push(
								sanitize({ type: message.type(), text: message.text() }),
							)
					})
					await installEdgeAuth(page, auth)
					const delivery = []
					page.on('response', (response) => {
						delivery.push({
							url: response.url(),
							status: response.status(),
							resourceType: response.request().resourceType(),
							requestCache: Object.fromEntries(
								['cache-control', 'pragma'].flatMap((name) => {
									const value = response.request().headers()[name]
									return value === undefined ? [] : [[name, value]]
								}),
							),
							fromCache: response.fromCache(),
							fromServiceWorker: response.fromServiceWorker(),
							headers: deliveryHeaders(response.headers()),
						})
					})
					const config = {
						extends: 'lighthouse:default',
						settings: {
							...(mode === 'desktop' ? desktopConfig.settings : {}),
							throttlingMethod,
							onlyCategories: [
								'performance',
								'accessibility',
								'best-practices',
								'seo',
							],
						},
					}
					const result = await lighthouse(
						url,
						{ logLevel: 'error' },
						config,
						page,
					)
					if (!result) throw new Error('Lighthouse produced no report')
					const report = sanitize(result.lhr)
					entry = { ...entry, runtimeError: report.runtimeError ?? null }
					const finalUrl = report.finalDisplayedUrl ?? report.finalUrl
					if (new URL(finalUrl).origin !== target.origin)
						throw new Error('Audit left the private application origin')
					writeFileSync(
						join(output, `${id}.report.json`),
						JSON.stringify(report, null, 2) + '\n',
					)
					writeFileSync(
						join(output, `${id}.report.html`),
						ReportGenerator.generateReportHtml(report),
					)
					// Public allowlist deliberately lives under delivery, not a raw headers container.
					writeFileSync(
						join(output, `${id}.delivery.json`),
						JSON.stringify(
							sanitize(
								delivery.map(({ headers, ...item }) => ({
									...item,
									delivery: headers,
								})),
							),
							null,
							2,
						) + '\n',
					)

					const content = await page.evaluate(() => ({
						url: location.href,
						title: document.title,
						mainCount: document.querySelectorAll('main').length,
						heading:
							document
								.querySelector('main h1')
								?.textContent?.replace(/\s+/g, ' ')
								.trim() ?? '',
					}))
					const expectedHeading = pageSpec.heading.replace(/\s+/g, ' ').trim()
					const actualHeading = content.heading
						.replace(/\s+/g, '')
						.toLowerCase()
					const documentStatus = report.audits[
						'network-requests'
					]?.details?.items
						?.filter((item) => item.resourceType === 'Document')
						.at(-1)?.statusCode
					const contentValid =
						content.mainCount === 1 &&
						actualHeading ===
							expectedHeading.replace(/\s+/g, '').toLowerCase() &&
						new URL(content.url).pathname.replace(/\/$/, '') ===
							pageSpec.path.replace(/\/$/, '') &&
						documentStatus === 200
					entry = {
						...entry,
						contentCheck: sanitize({
							...content,
							expectedHeading,
							documentStatus,
							valid: contentValid,
						}),
					}
					if (!contentValid)
						throw new Error(
							'Audit did not render the expected application page, inspect contentCheck and retained reports',
						)
					const value = (key) => report.audits[key]?.numericValue ?? null
					entry = {
						...entry,
						runtimeError: report.runtimeError ?? null,
						finalUrl,
						lighthouseVersion: report.lighthouseVersion,
						fetchTime: report.fetchTime,
						scores: Object.fromEntries(
							Object.entries(report.categories ?? {}).map(([key, value]) => [
								key,
								value.score,
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
								report.audits['network-requests']?.details?.items?.length ??
								null,
						},
						warnings: report.runWarnings ?? [],
					}
				} catch (error) {
					entry = {
						...entry,
						exitCode: 1,
						error: sanitize(error.message),
						failureStage: browser ? 'audit' : 'browser-launch',
					}
				} finally {
					await browser?.close()
				}
				if (pageErrors.length)
					entry = {
						...entry,
						exitCode: 1,
						error: entry.error ?? 'Uncaught page runtime errors were recorded',
					}
				results.push({
					...entry,
					pageErrors,
					consoleMessages,
					elapsedMs: performance.now() - started,
				})
				save()
				console.log(JSON.stringify(sanitize(results.at(-1))))
				if (stopRequested) break auditLoop
			}
process.exitCode = results.some(
	(row) =>
		row.exitCode || row.error || row.runtimeError || row.pageErrors.length,
)
	? 1
	: 0
