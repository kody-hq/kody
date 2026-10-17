#!/usr/bin/env node
import { chromium } from '@playwright/test'
import { createHash } from 'node:crypto'
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { createAccountSession } from './session-account.mjs'
import { profileFixture } from './cache-probe-fixtures.mjs'

const [configFile, outputArg] = process.argv.slice(2)
if (!configFile || !outputArg)
	throw new Error(
		'Usage: cache-navigation-probe.mjs CONFIG_JSON NEW_OUTPUT_DIRECTORY',
	)
const config = JSON.parse(readFileSync(configFile, 'utf8'))
const output = resolve(outputArg)
if (existsSync(output)) throw new Error('Output directory must be new')
if (!config.targets?.length || !config.steps?.length)
	throw new Error('Targets and steps are required')
for (const target of config.targets) {
	if (!['localhost', '127.0.0.1'].includes(new URL(target.origin).hostname))
		throw new Error('Local origins only')
}
for (const step of config.steps) {
	if (!step.marker?.selector || typeof step.marker.text !== 'string')
		throw new Error(
			'Each step needs an explicit data marker, not just a heading',
		)
	if (
		step.barrier &&
		!step.barrier.functionNames?.length &&
		!step.barrier.paths?.length
	)
		throw new Error('Barrier must name the reads to hold')
}
if (config.accountCheckpoint && !config.authenticated)
	throw new Error('Account checkpoints require authentication')
mkdirSync(output, { recursive: true })
const report = {
	config,
	startedAt: new Date().toISOString(),
	harnessSha256: createHash('sha256')
		.update(readFileSync(new URL(import.meta.url)))
		.digest('hex'),
	caveats: [
		'Local production diagnostic. CDP latency is minimum request-to-response-header latency, not a complete remote-network simulation.',
		'Anchor clicks do not hover. Marker visibility is frame-observed DOM/style readiness, not physical pixels.',
		'Barrier steps intercept only explicitly named GET reads and hold their fetched responses. Their timings are diagnostic, not comparable to uninterrupted navigation.',
		'Resource timing and marker observations share the document performance clock. Failed/aborted requests have no completed ResourceTiming entry and remain in the separate request log.',
		'Authenticated samples reuse one in-memory login per target, while every sample starts a fresh browser context and client cache.',
		'No response bodies, query strings, headers, credentials or cookies are saved.',
	],
	runs: [],
}
const save = () =>
	writeFileSync(
		join(output, 'results.json'),
		JSON.stringify(report, null, 2) + '\n',
	)
const safePath = (url) => new URL(url).pathname
const resolverNames = (target) => {
	if (!target.root || target.framework === 'remix') return {}
	const directory = join(target.root, 'dist-start/server/assets')
	const name = readdirSync(directory).find(
		(file) =>
			file.startsWith('__23tanstack-start-server-fn-resolver-') &&
			file.endsWith('.js'),
	)
	if (!name) throw new Error('Compiled server-function resolver is missing')
	return Object.fromEntries(
		[
			...readFileSync(join(directory, name), 'utf8').matchAll(
				/"([a-f0-9]{64})":\s*\{\s*functionName: "([^"]+)"/g,
			),
		].map((match) => [match[1], match[2]]),
	)
}
save()
const authenticatedCookies = new Map()
for (const latencyMs of config.latencyMs ?? [0, 100]) {
	for (let round = 0; round < (config.rounds ?? 3); round++) {
		for (let offset = 0; offset < config.targets.length; offset++) {
			const target = config.targets[(offset + round) % config.targets.length]
			const names = resolverNames(target)
			const run = {
				label: target.label,
				latencyMs,
				round: round + 1,
				steps: [],
				pageErrors: [],
				consoleErrors: [],
				errors: [],
				accountChecks: [],
			}
			report.runs.push(run)
			const browser = await chromium.launch({
				executablePath:
					config.chromePath ??
					'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
			})
			let releaseBarrier = () => {}
			let accountSession
			let fixture
			try {
				const context = await browser.newContext({
					viewport: { width: 1350, height: 940 },
				})
				if (config.authenticated && authenticatedCookies.has(target.origin)) {
					await context.addCookies(authenticatedCookies.get(target.origin))
				} else if (config.authenticated) {
					const credentials = process.env.SESSION_AUTH_FILE
						? JSON.parse(readFileSync(process.env.SESSION_AUTH_FILE, 'utf8'))[
								target.origin
							]
						: { email: 'jane@example.com', password: 'ilikecode' }
					const auth = await context.request.post(target.origin + '/auth', {
						data: { ...credentials, mode: 'login' },
					})
					if (!auth.ok())
						throw new Error(`Fixture login returned ${auth.status()}`)
					authenticatedCookies.set(target.origin, await context.cookies())
				}
				if (
					config.profileSeedDisplayName ||
					config.steps.some((step) => step.mutateDisplayName)
				) {
					if (!config.authenticated)
						throw new Error('Profile fixtures need authenticated configuration')
					fixture = await profileFixture(
						context,
						target.origin,
						config.profileSeedDisplayName,
					)
				}
				const page = await context.newPage()
				if (config.accountCheckpoint)
					accountSession = await createAccountSession(
						context,
						target.origin,
						run,
					)
				page.on('pageerror', (error) => run.pageErrors.push(error.message))
				page.on('console', (message) => {
					if (message.type() === 'error')
						run.consoleErrors.push(message.text().slice(0, 2000))
				})
				const client = await context.newCDPSession(page)
				await client.send('Network.enable')
				await client.send('Network.emulateNetworkConditionsByRule', {
					matchedNetworkConditions: [
						{
							urlPattern: '',
							latency: latencyMs,
							downloadThroughput: -1,
							uploadThroughput: -1,
						},
					],
				})
				let active
				const requests = new Map()
				client.on('Network.requestWillBeSent', (event) => {
					if (!active) return
					const path = safePath(event.request.url)
					const row = {
						path,
						method: event.request.method,
						type: event.type,
						functionName: path.startsWith('/_serverFn/')
							? (names[path.split('/').at(-1)] ?? 'unknown')
							: null,
					}
					requests.set(event.requestId, row)
					active.requests.push(row)
				})
				client.on('Network.responseReceived', ({ requestId, response }) =>
					Object.assign(requests.get(requestId) ?? {}, {
						status: response.status,
						fromDiskCache: response.fromDiskCache,
					}),
				)
				client.on(
					'Network.loadingFinished',
					({ requestId, encodedDataLength }) =>
						Object.assign(requests.get(requestId) ?? {}, {
							completedBytes: encodedDataLength,
						}),
				)
				client.on(
					'Network.loadingFailed',
					({ requestId, errorText, canceled }) =>
						Object.assign(requests.get(requestId) ?? {}, {
							error: errorText,
							canceled,
						}),
				)
				const response = await page.goto(
					target.origin + (config.entry ?? '/account'),
					{ waitUntil: 'networkidle' },
				)
				if (response.status() !== 200)
					throw new Error(`Entry returned ${response.status()}`)
				await page.waitForFunction(
					() => document.documentElement.dataset.hydrated === 'true',
				)
				for (const step of config.steps) {
					await page.waitForTimeout(step.waitBeforeMs ?? 0)
					if (step.activateBefore) {
						active = { name: `activation-before-${step.name}`, requests: [] }
						;(run.activations ??= []).push(active)
						const verified = page.waitForResponse((response) => {
							const id = new URL(response.url()).pathname.split('/').at(-1)
							return names[id]?.startsWith('verifySession') === true
						})
						await page.evaluate(() =>
							window.dispatchEvent(new FocusEvent('focus')),
						)
						await (await verified).finished()
						await page.waitForTimeout(step.activationDwellMs ?? 0)
						await page.waitForLoadState('networkidle')
					}
					if (step.mutateDisplayName)
						await fixture.write(step.mutateDisplayName)
					active = {
						name: step.name,
						path: step.path,
						requests: [],
						heldReads: [],
					}
					run.steps.push(active)
					const current = active
					let release
					const barrier = new Promise((done) => {
						release = done
					})
					releaseBarrier = release
					const intercept = async (route) => {
						const request = route.request()
						const path = safePath(request.url())
						const functionName = names[path.split('/').at(-1)]
						if (
							request.method() !== 'GET' ||
							!(
								step.barrier.paths?.includes(path) ||
								step.barrier.functionNames?.includes(functionName)
							)
						)
							return route.continue()
						const held = {
							path,
							functionName: functionName ?? null,
							backendResponseReady: false,
							released: false,
						}
						current.heldReads.push(held)
						const fetched = await route.fetch()
						held.backendResponseReady = true
						held.status = fetched.status()
						await barrier
						held.released = true
						await route.fulfill({ response: fetched })
					}
					const readPattern = /\/(?:_serverFn\/|[^?]*\.json(?:\?|$))/
					if (step.barrier) await page.route(readPattern, intercept)
					const timeOrigin = await page.evaluate(() => performance.timeOrigin)
					await page.evaluate((step) => {
						performance.clearResourceTimings()
						performance.setResourceTimingBufferSize(2000)
						window.__cacheProbe = {
							startedAt: performance.now(),
							firstMarkerMs: null,
							freshMarkerMs: null,
						}
						const visibleMatch = (marker) => {
							const normalize = (value) =>
								String(value ?? '')
									.replace(/\s+/g, ' ')
									.trim()
							const element = [
								...document.querySelectorAll(marker.selector),
							].find(
								(node) =>
									normalize(
										marker.property === 'value'
											? node.value
											: marker.attribute
												? node.getAttribute(marker.attribute)
												: node.textContent,
									) === normalize(marker.text),
							)
							if (!element) return false
							if (
								!element.getBoundingClientRect().width ||
								!element.getBoundingClientRect().height
							)
								return false
							for (let node = element; node; node = node.parentElement) {
								const style = getComputedStyle(node)
								if (
									style.display === 'none' ||
									style.visibility === 'hidden' ||
									Number(style.opacity) === 0
								)
									return false
							}
							return true
						}
						const observe = () => {
							const state = window.__cacheProbe
							if (
								location.pathname ===
									new URL(step.path, location.origin).pathname &&
								location.search === new URL(step.path, location.origin).search
							) {
								if (state.firstMarkerMs === null && visibleMatch(step.marker))
									state.firstMarkerMs = performance.now() - state.startedAt
								if (
									step.freshMarker &&
									state.freshMarkerMs === null &&
									visibleMatch(step.freshMarker)
								)
									state.freshMarkerMs = performance.now() - state.startedAt
							}
							state.frame = requestAnimationFrame(observe)
						}
						if (step.navigation === 'history') {
							history.pushState(null, '', step.path)
						} else {
							const link = [...document.querySelectorAll('a[href]')].find(
								(node) =>
									new URL(node.href).pathname ===
									new URL(step.path, location.origin).pathname,
							)
							if (!link) throw new Error('Application anchor is unavailable')
							link.click()
						}
						requestAnimationFrame(observe)
					}, step)
					if (step.barrier) {
						await page.waitForTimeout(step.barrier.observeMs ?? 1000)
						current.beforeRelease = await page.evaluate(() => ({
							markerMs: window.__cacheProbe.firstMarkerMs,
							freshMarkerMs: window.__cacheProbe.freshMarkerMs,
							completedPaths: performance
								.getEntriesByType('resource')
								.map((entry) => new URL(entry.name).pathname),
						}))
						current.beforeRelease.heldReads = current.heldReads.map((row) => ({
							...row,
						}))
						current.cacheVisibleWhileReadHeld =
							current.beforeRelease.markerMs !== null &&
							current.heldReads.some(
								(row) => row.backendResponseReady && !row.released,
							)
						release()
					}
					await page.waitForFunction(
						() =>
							window.__cacheProbe.firstMarkerMs !== null ||
							window.__cacheProbe.freshMarkerMs !== null,
						null,
						{ timeout: config.timeoutMs ?? 15000 },
					)
					if (step.freshMarker)
						await page.waitForFunction(
							() => window.__cacheProbe.freshMarkerMs !== null,
							null,
							{ timeout: config.timeoutMs ?? 15000 },
						)
					await page.waitForLoadState('networkidle')
					Object.assign(
						current,
						await page.evaluate(() => {
							const state = window.__cacheProbe
							cancelAnimationFrame(state.frame)
							return {
								firstMarkerMs: state.firstMarkerMs,
								freshMarkerMs: state.freshMarkerMs,
								resources: performance
									.getEntriesByType('resource')
									.map((entry) => ({
										path: new URL(entry.name).pathname,
										initiatorType: entry.initiatorType,
										startMs: entry.startTime - state.startedAt,
										responseStartMs: entry.responseStart - state.startedAt,
										responseEndMs: entry.responseEnd - state.startedAt,
										transferSize: entry.transferSize,
									})),
							}
						}),
					)
					current.fullReload =
						timeOrigin !== (await page.evaluate(() => performance.timeOrigin))
					if (step.barrier) await page.unroute(readPattern, intercept)
					if (current.fullReload) throw new Error('Unexpected document reload')
					if (
						current.requests.some(
							(request) => request.functionName === 'unknown',
						)
					)
						throw new Error('Unmapped server function observed')
					if (step.barrier && !current.heldReads.length)
						throw new Error(
							'Barrier was not exercised; cache proof is inconclusive',
						)
					save()
				}
				if (accountSession) {
					active = { name: 'account-mutation-and-refresh', requests: [] }
					run.mutationTraffic = active
					await page.evaluate(() => performance.clearResourceTimings())
					await accountSession.checkpoint(page)
					await page.waitForLoadState('networkidle')
					active.resources = await page.evaluate(() => {
						const start = window.__retentionTiming?.start
						if (typeof start !== 'number') return []
						return performance
							.getEntriesByType('resource')
							.filter((entry) => entry.startTime >= start)
							.map((entry) => ({
								path: new URL(entry.name).pathname,
								startMs: entry.startTime - start,
								responseStartMs: entry.responseStart - start,
								responseEndMs: entry.responseEnd - start,
								transferSize: entry.transferSize,
							}))
					})
				}
			} catch (error) {
				run.failure = error.message
			} finally {
				releaseBarrier()
				try {
					await accountSession?.close()
				} catch (error) {
					run.cleanupFailure = error.message
				}
				try {
					if (fixture) run.profileFixtureRestored = await fixture.close()
				} catch (error) {
					run.fixtureCleanupFailure = error.message
				}
				await browser.close()
				save()
			}
		}
	}
}
process.exitCode = report.runs.some(
	(run) =>
		run.failure ||
		run.cleanupFailure ||
		run.fixtureCleanupFailure ||
		run.pageErrors.length ||
		run.errors.length ||
		((config.profileSeedDisplayName ||
			config.steps.some((step) => step.mutateDisplayName)) &&
			!run.profileFixtureRestored) ||
		(config.accountCheckpoint &&
			(!run.profileRestored || !run.retentionRestored)),
)
	? 1
	: 0
