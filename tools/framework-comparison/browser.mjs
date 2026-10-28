#!/usr/bin/env node
import { chromium, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [configFile, outputArg] = process.argv.slice(2)
if (!configFile || !outputArg)
	throw new Error('Usage: browser.mjs CONFIG NEW_OUTPUT_DIRECTORY')
const config = JSON.parse(readFileSync(configFile, 'utf8'))
const output = resolve(outputArg)
if (existsSync(output)) throw new Error('Output directory must be new')
for (const target of config.targets) {
	const url = new URL(target.origin)
	if (
		!['127.0.0.1', 'localhost'].includes(url.hostname) ||
		url.username ||
		url.password
	)
		throw new Error('Local disposable origins only')
	const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
	if (
		response.status !== 200 ||
		(await response.text()).includes('/@vite/client')
	)
		throw new Error(`${target.label}: production preflight failed`)
}
mkdirSync(output, { recursive: true })
const report = {
	startedAt: new Date().toISOString(),
	node: process.version,
	harnessSha256: createHash('sha256')
		.update(readFileSync(new URL(import.meta.url)))
		.digest('hex'),
	config,
	runs: [],
	caveats: [
		'Optimized local builds. Warm Worker processes, fresh browser contexts per round.',
		'Click time starts in the browser click handler and ends at the first animation frame with the destination marker visible. This is DOM/style readiness, not physical paint.',
		'CDP latency is a minimum request latency, not a complete mobile network model.',
		'No cookies, headers, query strings or response bodies are retained.',
	],
}
const save = () =>
	writeFileSync(
		join(output, 'runs.json'),
		JSON.stringify(report, null, 2) + '\n',
	)
save()
const browser = await chromium.launch({
	executablePath:
		config.chromePath ??
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
report.chrome = browser.version()
try {
	for (const latencyMs of config.latencyMs ?? [0, 100]) {
		for (let round = 0; round < (config.rounds ?? 5); round++) {
			for (let offset = 0; offset < config.targets.length; offset++) {
				const target = config.targets[(round + offset) % config.targets.length]
				const row = {
					label: target.label,
					round: round + 1,
					latencyMs,
					errors: [],
					consoleErrorCount: 0,
					failedRequests: [],
					steps: [],
				}
				report.runs.push(row)
				const context = await browser.newContext({
					viewport: { width: 1350, height: 940 },
				})
				try {
					if (config.authenticated) {
						const response = await context.request.post(
							target.origin + '/auth',
							{
								data: {
									email: 'jane@example.com',
									password: 'ilikecode',
									mode: 'login',
								},
							},
						)
						if (!response.ok())
							throw new Error(`Seed login: ${response.status()}`)
					}
					const page = await context.newPage()
					page.on('pageerror', (error) => row.errors.push(error.message))
					page.on('console', (message) => {
						if (message.type() === 'error') row.consoleErrorCount++
					})
					page.on('requestfailed', (request) =>
						row.failedRequests.push({
							path: new URL(request.url()).pathname,
							failure: request.failure()?.errorText,
						}),
					)
					const cdp = await context.newCDPSession(page)
					await cdp.send('Network.enable')
					await cdp.send('Network.emulateNetworkConditions', {
						offline: false,
						latency: latencyMs,
						downloadThroughput: -1,
						uploadThroughput: -1,
					})
					await page.addInitScript(() => {
						performance.setResourceTimingBufferSize(10_000)
						const hydrated = new MutationObserver(() => {
							if (document.documentElement?.dataset.hydrated === 'true') {
								window.__benchmarkHydratedMs = performance.now()
								hydrated.disconnect()
							}
						})
						hydrated.observe(document, {
							attributes: true,
							subtree: true,
							attributeFilter: ['data-hydrated'],
						})
						new PerformanceObserver((list) => {
							for (const entry of list.getEntries())
								window.__benchmarkLcpMs = entry.startTime
						}).observe({ type: 'largest-contentful-paint', buffered: true })
						document.addEventListener(
							'click',
							() => {
								window.__benchmarkClick = performance.now()
							},
							true,
						)
					})
					const initial = await page.goto(
						new URL(config.entry ?? '/', target.origin).href,
						{ waitUntil: 'networkidle' },
					)
					if (initial.status() !== 200)
						throw new Error(`Entry returned ${initial.status()}`)
					if ((await page.content()).includes('/@vite/client'))
						throw new Error('Development build rejected')
					row.initial = await page.evaluate(() => ({
						heading: document.querySelector('h1')?.textContent,
						hydratedMs: window.__benchmarkHydratedMs ?? null,
						observedLcpMs: window.__benchmarkLcpMs ?? null,
						observedFcpMs:
							performance.getEntriesByName('first-contentful-paint')[0]
								?.startTime ?? null,
						inlineStylesheetBytes: [
							...document.querySelectorAll('style[data-tsr-inline-css]'),
						].reduce(
							(sum, style) =>
								sum + new TextEncoder().encode(style.textContent ?? '').length,
							0,
						),
						inlineStyleBytes: [...document.querySelectorAll('style')].reduce(
							(sum, style) =>
								sum + new TextEncoder().encode(style.textContent ?? '').length,
							0,
						),
						document: performance
							.getEntriesByType('navigation')
							.map((entry) => ({
								encodedBytes: entry.encodedBodySize,
								decodedBytes: entry.decodedBodySize,
								transferBytes: entry.transferSize,
							})),
						resources: performance
							.getEntriesByType('resource')
							.map((resource) => ({
								path: new URL(resource.name).pathname,
								type: resource.initiatorType,
								transferBytes: resource.transferSize,
								encodedBytes: resource.encodedBodySize,
								decodedBytes: resource.decodedBodySize,
							})),
					}))
					for (const step of config.steps) {
						const requests = []
						const listener = (request) =>
							requests.push({
								path: new URL(request.url()).pathname,
								method: request.method(),
								type: request.resourceType(),
							})
						page.on('request', listener)
						const before = await page.evaluate(() => performance.timeOrigin)
						const link = page
							.locator(step.link ?? `a[href="${step.path}"]`)
							.filter({ visible: true })
							.first()
						if (!step.history) await expect(link).toBeVisible()
						const measurement = page
							.evaluate(
								({ path, selector, text }) =>
									new Promise((resolve, reject) => {
										const initialOrigin = performance.timeOrigin
										const deadline = performance.now() + 15_000
										const frame = () => {
											const element = [
												...document.querySelectorAll(selector),
											].find((candidate) =>
												candidate.textContent.includes(text),
											)
											if (
												window.__benchmarkClick != null &&
												location.pathname === path &&
												element?.getBoundingClientRect().height &&
												getComputedStyle(element).visibility !== 'hidden'
											) {
												resolve({
													elapsedMs:
														performance.now() - window.__benchmarkClick,
													timeOrigin: initialOrigin,
												})
											} else if (performance.now() > deadline)
												reject(new Error('Destination marker timed out'))
											else requestAnimationFrame(frame)
										}
										window.__benchmarkClick = null
										requestAnimationFrame(frame)
									}),
								{ path: step.path, ...step.marker },
							)
							.catch((error) => ({ error: error.message }))
						// DOM click avoids hover preloading. The event handler and frame observer share the browser clock.
						if (step.history === 'back')
							await page.evaluate(() => {
								window.__benchmarkClick = performance.now()
								history.back()
							})
						else if (step.history === 'forward')
							await page.evaluate(() => {
								window.__benchmarkClick = performance.now()
								history.forward()
							})
						else await link.evaluate((element) => element.click())
						const observed = await measurement
						if (observed.error) throw new Error(observed.error)
						await page.waitForURL((url) => url.pathname === step.path)
						await page.waitForLoadState('networkidle')
						page.off('request', listener)
						row.steps.push({
							path: step.path,
							action: step.history ?? 'click',
							elapsedMs: observed.elapsedMs,
							fullDocumentReload: before !== observed.timeOrigin,
							requests,
							resources: await page.evaluate(() =>
								performance.getEntriesByType('resource').map((resource) => ({
									path: new URL(resource.name).pathname,
									type: resource.initiatorType,
									transferBytes: resource.transferSize,
									encodedBytes: resource.encodedBodySize,
									decodedBytes: resource.decodedBodySize,
								})),
							),
						})
					}
				} catch (error) {
					row.failure = error.message
				} finally {
					await context.close()
					save()
				}
			}
		}
	}
} finally {
	await browser.close()
}
process.exitCode = report.runs.some((run) => run.failure || run.errors.length)
	? 1
	: 0
