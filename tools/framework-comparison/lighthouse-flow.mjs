#!/usr/bin/env node
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readEdgeAuth, makeSanitizer, installEdgeAuth } from './edge-auth.mjs'

const [origin, label, outputArg, lighthouseDirectory, countArg = '5'] =
	process.argv.slice(2)
if (!origin || !label || !outputArg || !lighthouseDirectory) {
	throw new Error(
		'Usage: node lighthouse-flow.mjs ORIGIN LABEL OUTPUT_DIRECTORY LIGHTHOUSE_PACKAGE_DIRECTORY [RUNS]',
	)
}
const require = createRequire(
	join(resolve(lighthouseDirectory), 'package.json'),
)
const { startFlow } = await import(
	pathToFileURL(require.resolve('lighthouse')).href
)
const { default: puppeteer } = await import(
	pathToFileURL(require.resolve('puppeteer-core')).href
)
const count = Number(countArg)
if (!Number.isInteger(count) || count < 1)
	throw new Error('RUNS must be a positive integer')
const auth = readEdgeAuth()
const sanitize = makeSanitizer(auth)
if (auth.size && !auth.has(new URL(origin).origin))
	throw new Error('Private flow origin has no configured Access token')
const { ReportGenerator } = await import(
	pathToFileURL(
		join(resolve(lighthouseDirectory), 'report/generator/report-generator.js'),
	).href
)
const output = resolve(outputArg)
mkdirSync(output, { recursive: true })
const results = []
for (let run = 1; run <= count; run++) {
	const browser = await puppeteer.launch({
		executablePath:
			process.env.CHROME_PATH ??
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		headless: true,
	})
	try {
		const page = await browser.newPage()
		if (auth.size) await installEdgeAuth(page, auth)
		await page.setViewport({ width: 1350, height: 940, deviceScaleFactor: 1 })
		const errors = []
		page.on('pageerror', (error) => errors.push(error.message))
		const flow = await startFlow(page, {
			name: `${label} home to pricing to docs, run ${run}`,
			config: {
				extends: 'lighthouse:default',
				settings: {
					formFactor: 'desktop',
					screenEmulation: {
						mobile: false,
						width: 1350,
						height: 940,
						deviceScaleFactor: 1,
						disabled: false,
					},
					throttlingMethod: 'provided',
					onlyCategories: ['performance'],
				},
			},
		})
		await flow.navigate(origin, { stepName: 'Initial home load' })
		const transitions = []
		for (const [path, heading] of [
			['/pricing', 'Start free.'],
			['/docs', 'What is Kody?'],
		]) {
			await flow.startTimespan({ stepName: `Client navigation to ${path}` })
			const selector = `header a[href="${path}"], nav a[href="${path}"]`
			await page.waitForSelector(selector, { visible: true })
			const before = await page.evaluate(() => performance.timeOrigin)
			const measurementCount = await page.evaluate(
				() => performance.getEntriesByName('framework-click-to-content').length,
			)
			await page.evaluate(
				({ path, heading }) => {
					const link = document.querySelector(
						`header a[href="${path}"], nav a[href="${path}"]`,
					)
					link.addEventListener(
						'click',
						() => {
							performance.mark('framework-navigation-click')
							const check = () => {
								const title = document.querySelector('main h1')
								if (
									location.pathname.replace(/\/$/, '') === path &&
									title?.textContent?.includes(heading)
								) {
									performance.mark('framework-navigation-content-ready')
									performance.measure(
										'framework-click-to-content',
										'framework-navigation-click',
										'framework-navigation-content-ready',
									)
									return
								}
								requestAnimationFrame(check)
							}
							requestAnimationFrame(check)
						},
						{ capture: true, once: true },
					)
				},
				{ path, heading },
			)
			await page.click(selector)
			await page.waitForFunction(
				({ path, heading }) =>
					location.pathname.replace(/\/$/, '') === path &&
					document.querySelector('main h1')?.textContent?.includes(heading),
				{ timeout: 30_000 },
				{ path, heading },
			)
			await page.waitForFunction(
				({ before, measurementCount }) =>
					performance.timeOrigin !== before ||
					performance.getEntriesByName('framework-click-to-content').length >
						measurementCount,
				{ timeout: 30_000 },
				{ before, measurementCount },
			)
			const observed = await page.evaluate(() => ({
				timeOrigin: performance.timeOrigin,
				clickToContentMs:
					performance.getEntriesByName('framework-click-to-content').at(-1)
						?.duration ?? null,
				heading: document.querySelector('main h1')?.textContent?.trim(),
			}))
			transitions.push({
				path,
				fullDocumentReload: before !== observed.timeOrigin,
				...observed,
			})
			await flow.endTimespan()
		}
		const result = sanitize(await flow.createFlowResult())
		writeFileSync(
			join(output, `${label}-flow-${run}.json`),
			JSON.stringify(result, null, 2) + '\n',
		)
		writeFileSync(
			join(output, `${label}-flow-${run}.html`),
			ReportGenerator.generateFlowReportHtml(result),
		)
		results.push({
			run,
			transitions,
			errors,
			steps: result.steps.map((step) => ({
				name: step.name,
				mode: step.lhr.gatherMode,
				cls: step.lhr.audits['cumulative-layout-shift']?.numericValue ?? null,
				tbtMs: step.lhr.audits['total-blocking-time']?.numericValue ?? null,
				requests: step.lhr.audits['network-requests']?.details?.items ?? [],
			})),
		})
	} catch (error) {
		results.push({ run, error: sanitize(error.stack ?? error.message) })
	} finally {
		await browser.close()
	}
	writeFileSync(
		join(output, `${label}-flows.json`),
		JSON.stringify(
			sanitize({
				label,
				origin,
				measuredAt: new Date().toISOString(),
				results,
				caveats: [
					'Desktop unthrottled user flows, measured separately from simulated direct-load Lighthouse audits; origin and auth configuration determine local versus private edge target.',
					'Click-to-content ends at the first animation frame with destination URL and expected heading in the DOM, not a paint-complete or background-quiescence measurement.',
					'A full document reload loses the click performance mark and is reported with a null timing.',
					'Fresh browser per flow; pricing and docs inherit the same warm session and native prefetch behavior.',
					'No authenticated data freshness is established by these public navigation measurements.',
				],
			}),
			null,
			2,
		) + '\n',
	)
	console.log(
		JSON.stringify({
			label,
			run,
			error: results.at(-1).error ?? null,
			transitions: results.at(-1).transitions,
		}),
	)
}
process.exitCode = results.some((run) => run.error) ? 1 : 0
