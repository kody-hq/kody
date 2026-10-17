#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createAccountSession } from './session-account.mjs'
import { chromium } from '@playwright/test'
import {
	readFileSync,
	writeFileSync,
	mkdirSync,
	existsSync,
	openSync,
	closeSync,
	unlinkSync,
} from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'

const lockPath = join(tmpdir(), 'kody-session-measurement.lock')
if (existsSync(lockPath)) {
	const owner = Number(readFileSync(lockPath, 'utf8'))
	let alive = true
	try {
		process.kill(owner, 0)
	} catch (error) {
		if (error.code === 'ESRCH') alive = false
		else throw error
	}
	if (alive)
		throw new Error(`Measurement runner ${owner} already owns the browser slot`)
	unlinkSync(lockPath)
}
const lock = openSync(lockPath, 'wx')
writeFileSync(lock, String(process.pid))
closeSync(lock)
process.on('exit', () => {
	if (readFileSync(lockPath, 'utf8') === String(process.pid))
		unlinkSync(lockPath)
})

async function verifyAccountPrerequisites(target, config) {
	const browser = await chromium.launch({
		executablePath:
			config.chromePath ??
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	})
	const evidence = { label: target.label, errors: [], consoleErrors: [] }
	try {
		const context = await browser.newContext()
		const credentials = process.env.SESSION_AUTH_FILE
			? JSON.parse(readFileSync(process.env.SESSION_AUTH_FILE, 'utf8'))[
					target.origin
				]
			: { email: 'jane@example.com', password: 'ilikecode' }
		const login = await context.request.post(target.origin + '/auth', {
			data: { ...credentials, mode: 'login' },
		})
		evidence.loginStatus = login.status()
		if (!login.ok())
			throw new Error(`Prerequisite login returned ${login.status()}`)
		const jobs = await context.request.get(target.origin + '/account/jobs.json')
		evidence.jobsApiStatus = jobs.status()
		if (!jobs.ok())
			throw new Error(`Prerequisite Jobs API returned ${jobs.status()}`)
		if (!Array.isArray((await jobs.json()).jobs))
			throw new Error('Prerequisite Jobs API payload is invalid')
		const page = await context.newPage()
		page.on('pageerror', (error) => evidence.errors.push(error.message))
		page.on('console', (message) => {
			if (message.type() === 'error')
				evidence.consoleErrors.push(message.text().slice(0, 2000))
		})
		const response = await page.goto(target.origin + '/account/jobs', {
			waitUntil: 'networkidle',
		})
		evidence.jobsDocumentStatus = response.status()
		if (response.status() !== 200)
			throw new Error(
				`Prerequisite Jobs document returned ${response.status()}`,
			)
		evidence.heading = (await page.locator('main h1').innerText()).trim()
		if (evidence.heading !== 'Jobs')
			throw new Error(`Prerequisite Jobs heading was ${evidence.heading}`)
		await page.waitForFunction(
			() => document.documentElement.dataset.hydrated === 'true',
		)
		evidence.hydrated = true
	} catch (error) {
		evidence.failure = error.message
	} finally {
		await browser.close()
	}
	return evidence
}

const [configFile, outputDirectory] = process.argv.slice(2)
if (!configFile || !outputDirectory)
	throw new Error(
		'Usage: node session-measurement.mjs CONFIG_JSON NEW_OUTPUT_DIRECTORY',
	)
const config = JSON.parse(readFileSync(configFile, 'utf8'))
if (
	!Array.isArray(config.routes) ||
	new Set(config.routes.map((route) => route.path)).size < 2
)
	throw new Error('At least two distinct navigation routes are required')
const output = resolve(outputDirectory)
if (existsSync(output)) throw new Error('Output directory must be new')
mkdirSync(output, { recursive: true })
for (const target of config.targets) {
	const url = new URL(target.origin)
	if (!['127.0.0.1', 'localhost'].includes(url.hostname))
		throw new Error('This harness only accepts local production previews')
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const percentile = (values, p) => {
	const ordered = values.filter(Number.isFinite).sort((a, b) => a - b)
	return ordered.length ? ordered[Math.ceil(p * ordered.length) - 1] : null
}
const report = {
	startedAt: new Date().toISOString(),
	nodeVersion: process.version,
	harnessSha256: createHash('sha256')
		.update(readFileSync(new URL(import.meta.url)))
		.update(readFileSync(new URL('./session-account.mjs', import.meta.url)))
		.digest('hex'),
	config: {
		...config,
		targets: config.targets.map(({ storageState, ...target }) => ({
			...target,
			authenticated: Boolean(storageState),
		})),
	},
	results: [],
	caveats: [
		'Local production previews do not measure edge latency or compression.',
		'Cold entry accounting includes the entire configured observation window, including background preloads.',
		'Navigation timing starts at the click event and ends at a frame with the expected URL and heading. Visible-ready also checks ancestor opacity and geometry, but is not a pixel paint measurement.',
		'Natural heap samples are not forced-GC retained heap. Growth alone does not prove a leak.',
		'Public route races do not establish authenticated data freshness or mutation isolation.',
		'Percentiles use nearest rank and remain descriptive at small sample counts.',
	],
}
const save = () =>
	writeFileSync(
		join(output, 'results.json'),
		JSON.stringify(report, null, 2) + '\n',
	)
save()
report.prerequisites = []
if (config.accountRoutes) {
	for (const target of config.targets) {
		const evidence = await verifyAccountPrerequisites(target, config)
		report.prerequisites.push(evidence)
		save()
		if (evidence.failure || evidence.errors.length)
			throw new Error(
				`Target ${target.label} failed its authenticated prerequisite; no timing started`,
			)
	}
}
let stopRequested = false
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		stopRequested = true
	})
}
measurement: for (let round = 0; round < (config.rounds ?? 1); round++) {
	const targets = config.targets.map(
		(_, i) => config.targets[(i + round) % config.targets.length],
	)
	for (const target of targets) {
		if (stopRequested) {
			report.stoppedAtTargetBoundary = true
			save()
			break measurement
		}
		const result = {
			label: target.label,
			round: round + 1,
			startedAt: new Date().toISOString(),
			requests: [],
			errors: [],
			navigation: [],
			memory: [],
			races: [],
			accountChecks: [],
		}
		report.results.push(result)
		let accountSession
		const browser = await chromium.launch({
			handleSIGINT: false,
			handleSIGTERM: false,
			executablePath:
				config.chromePath ??
				'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		})
		result.browserVersion = browser.version()
		try {
			const context = await browser.newContext({
				viewport: { width: 1350, height: 940 },
				storageState: target.storageState,
			})
			const page = await context.newPage()
			const client = await context.newCDPSession(page)
			await client.send('Network.enable')
			await client.send('Performance.enable')
			let phase = 'cold-entry'
			const requestMap = new Map()
			const localStart = performance.now()
			client.on('Network.requestWillBeSent', (event) => {
				const url = new URL(event.request.url)
				const row = {
					id: event.requestId,
					phase,
					atMs: performance.now() - localStart,
					url: url.origin + url.pathname,
					method: event.request.method,
					type: event.type,
					initiator: event.initiator.type,
				}
				result.requests.push(row)
				requestMap.set(event.requestId, row)
			})
			client.on('Network.responseReceived', ({ requestId, response }) => {
				Object.assign(requestMap.get(requestId) ?? {}, {
					status: response.status,
					protocol: response.protocol,
					fromDiskCache: response.fromDiskCache,
					fromServiceWorker: response.fromServiceWorker,
				})
			})
			client.on(
				'Network.loadingFinished',
				({ requestId, encodedDataLength }) => {
					Object.assign(requestMap.get(requestId) ?? {}, {
						encodedBytes: encodedDataLength,
						completedAtMs: performance.now() - localStart,
					})
				},
			)
			client.on(
				'Network.loadingFailed',
				({ requestId, errorText, canceled }) => {
					Object.assign(requestMap.get(requestId) ?? {}, {
						error: errorText,
						canceled,
					})
				},
			)
			page.on('pageerror', (error) =>
				result.errors.push({ phase, message: error.message }),
			)
			await page.addInitScript(() => {
				window.__measurementClick = null
				document.addEventListener(
					'click',
					() => {
						window.__measurementClick = performance.now()
					},
					true,
				)
			})
			const response = await page.goto(target.origin + (config.entry ?? '/'), {
				waitUntil: 'domcontentloaded',
			})
			if (response.status() !== 200)
				throw new Error(`Entry returned ${response.status()}`)
			await page.locator('main h1').waitFor()
			await delay(config.coldObservationMs ?? 30_000)
			const sampleMemory = async () => {
				const { metrics } = await client.send('Performance.getMetrics')
				result.memory.push({
					navigationCount: result.navigation.length,
					accountCheckpointCount: result.accountChecks.length,
					atMs: performance.now() - localStart,
					path: new URL(page.url()).pathname,
					phase,
					...Object.fromEntries(
						metrics
							.filter((x) =>
								[
									'JSHeapUsedSize',
									'JSHeapTotalSize',
									'Nodes',
									'Documents',
									'JSEventListeners',
									'LayoutCount',
								].includes(x.name),
							)
							.map((x) => [x.name, x.value]),
					),
				})
			}
			await sampleMemory()
			const sessionStart = performance.now()
			let sequence = 0
			while (
				performance.now() - sessionStart <
				(config.sessionMs ?? 180_000) - (config.idleMs ?? 0)
			) {
				if (
					config.accountRoutes &&
					!accountSession &&
					performance.now() - sessionStart >= (config.accountStartMs ?? 300_000)
				) {
					phase = 'account-setup'
					accountSession = await createAccountSession(
						context,
						target.origin,
						result,
					)
					await page.goto(target.origin + '/account')
					await page.getByLabel('Display name', { exact: true }).waitFor()
					await sampleMemory()
				}
				const routes = accountSession ? config.accountRoutes : config.routes
				const destination = routes[sequence % routes.length]
				sequence++
				if (new URL(page.url()).pathname === destination.path) continue
				phase = `${accountSession ? 'account' : 'public'}-navigation-${sequence}`
				const link = page
					.locator(`a[href="${destination.path}"]`)
					.filter({ visible: true })
					.first()
				const previous = {
					path: new URL(page.url()).pathname,
					heading: await page.locator('main h1').textContent(),
				}
				const before = await page.evaluate(() => performance.timeOrigin)
				await link.hover()
				await delay(config.hoverMs ?? 500)
				await page.evaluate(() => {
					window.__headingGaps = []
					window.__headingObserver?.disconnect()
					window.__headingObserver = new MutationObserver(() => {
						if (
							!document.querySelector('main h1')?.textContent?.trim() &&
							window.__headingGaps.length < 100
						)
							window.__headingGaps.push(performance.now())
					})
					window.__headingObserver.observe(document.body, {
						childList: true,
						subtree: true,
						characterData: true,
					})
				})
				await link.evaluate((link, destination) => {
					link.addEventListener(
						'click',
						() => {
							const timing = {
								start: performance.now(),
								domReadyMs: null,
								visibleReadyMs: null,
							}
							window.__navigationTiming = timing
							const frame = () => {
								const title = document.querySelector('main h1')
								if (
									location.pathname === destination.path &&
									title?.textContent?.includes(destination.heading)
								) {
									if (timing.domReadyMs === null)
										timing.domReadyMs = performance.now() - timing.start
									let visible = Boolean(title.getBoundingClientRect().height)
									for (let node = title; node; node = node.parentElement) {
										const style = getComputedStyle(node)
										if (
											Number(style.opacity) < 0.99 ||
											style.visibility === 'hidden'
										)
											visible = false
									}
									if (visible) {
										timing.visibleReadyMs = performance.now() - timing.start
										return
									}
								}
								if (performance.now() - timing.start < 30000)
									requestAnimationFrame(frame)
							}
							requestAnimationFrame(frame)
						},
						{ capture: true, once: true },
					)
				}, destination)
				await link.click()
				await page.waitForFunction(
					(before) =>
						performance.timeOrigin !== before ||
						window.__navigationTiming?.visibleReadyMs != null,
					before,
					{ timeout: 30_000 },
				)
				const dom = await page.evaluate(() => ({
					origin: performance.timeOrigin,
					duration: window.__navigationTiming?.domReadyMs ?? null,
				}))
				const visibleMs = await page.evaluate(
					() => window.__navigationTiming?.visibleReadyMs ?? null,
				)
				const headingGaps = await page.evaluate(() => {
					window.__headingObserver?.disconnect()
					return window.__headingGaps ?? []
				})
				result.navigation.push({
					headingGaps,
					segment: accountSession ? 'account' : 'public',
					path: destination.path,
					domReadyMs: dom.duration,
					visibleReadyMs: visibleMs,
					fullDocumentReload: before !== dom.origin,
				})
				if (config.historyEvery && sequence % config.historyEvery === 0) {
					phase = `history-${sequence}`
					await page.goBack({ waitUntil: 'domcontentloaded' })
					await page.waitForFunction(
						({ path, heading }) =>
							location.pathname === path &&
							document.querySelector('main h1')?.textContent?.trim() ===
								heading.trim(),
						previous,
					)
					await page.goForward({ waitUntil: 'domcontentloaded' })
					await page.waitForFunction(
						({ path, heading }) =>
							location.pathname === path &&
							document.querySelector('main h1')?.textContent?.includes(heading),
						destination,
					)
				}
				if (config.raceEvery && sequence % config.raceEvery === 0) {
					phase = `race-${sequence}`
					const options = routes.filter(
						(route) => route.path !== destination.path,
					)
					const first = options[0]
					const last = options[1] ?? destination
					await page.evaluate(
						({ first, last }) => {
							const a = document.querySelector(`a[href="${first.path}"]`)
							const b = document.querySelector(`a[href="${last.path}"]`)
							if (!a || !b) throw new Error('Race link is unavailable')
							a.click()
							b.click()
						},
						{ first, last },
					)
					await page.waitForFunction(
						({ path, heading }) =>
							location.pathname === path &&
							document.querySelector('main h1')?.textContent?.includes(heading),
						last,
					)
					await delay(config.raceSettleMs ?? 1500)
					const observed = await page.evaluate(() => ({
						path: location.pathname,
						heading: document.querySelector('main h1')?.textContent,
					}))
					const passed =
						observed.path === last.path &&
						observed.heading?.includes(last.heading)
					result.races.push({
						first: first.path,
						last: last.path,
						observed,
						passed,
					})
					if (!passed)
						throw new Error('A late navigation replaced the latest destination')
				}
				if (
					accountSession &&
					sequence % (config.accountCheckEvery ?? 12) === 0
				) {
					phase = `account-check-${sequence}`
					await accountSession.checkpoint(page)
				}
				await sampleMemory()
				save()
				await delay(config.dwellMs ?? 10_000)
			}
			if (config.idleMs) {
				phase = 'idle-start'
				await sampleMemory()
				const idleStart = performance.now()
				while (performance.now() - idleStart < config.idleMs) {
					await delay(
						Math.min(60_000, config.idleMs - (performance.now() - idleStart)),
					)
					phase = `idle-${Math.round((performance.now() - idleStart) / 1000)}s`
					await sampleMemory()
					save()
				}
				const routes = accountSession ? config.accountRoutes : config.routes
				const lastRoute = routes.find(
					(route) => route.path !== new URL(page.url()).pathname,
				)
				phase = 'post-idle-activity'
				await page
					.locator(`a[href="${lastRoute.path}"]`)
					.filter({ visible: true })
					.first()
					.click()
				await page.waitForFunction(
					({ path, heading }) =>
						location.pathname === path &&
						document.querySelector('main h1')?.textContent?.includes(heading),
					lastRoute,
				)
				await sampleMemory()
			}
			if (config.finalForcedGc) {
				phase = 'forced-final-gc'
				await client.send('HeapProfiler.collectGarbage')
				await sampleMemory()
			}
			result.summary = {
				durationMs: performance.now() - sessionStart,
				navigationCount: result.navigation.length,
				navigationBySegment: Object.fromEntries(
					['public', 'account'].map((segment) => {
						const rows = result.navigation.filter(
							(row) => row.segment === segment,
						)
						return [
							segment,
							{
								count: rows.length,
								domReady: Object.fromEntries(
									[0.5, 0.95, 0.99].map((p) => [
										String(p),
										percentile(
											rows.map((row) => row.domReadyMs),
											p,
										),
									]),
								),
								visibleReady: Object.fromEntries(
									[0.5, 0.95, 0.99].map((p) => [
										String(p),
										percentile(
											rows.map((row) => row.visibleReadyMs),
											p,
										),
									]),
								),
							},
						]
					}),
				),
				domReady: Object.fromEntries(
					[0.5, 0.95, 0.99].map((p) => [
						String(p),
						percentile(
							result.navigation.map((x) => x.domReadyMs),
							p,
						),
					]),
				),
				visibleReady: Object.fromEntries(
					[0.5, 0.95, 0.99].map((p) => [
						String(p),
						percentile(
							result.navigation.map((x) => x.visibleReadyMs),
							p,
						),
					]),
				),
				trafficByPhase: Object.fromEntries(
					[...new Set(result.requests.map((request) => request.phase))].map(
						(name) => {
							const requests = result.requests.filter(
								(request) => request.phase === name,
							)
							return [
								name,
								{
									requests: requests.length,
									encodedBytes: requests.reduce(
										(sum, request) => sum + (request.encodedBytes ?? 0),
										0,
									),
									unfinished: requests.filter(
										(request) =>
											request.completedAtMs === undefined && !request.error,
									).length,
								},
							]
						},
					),
				),
				coldEntry: {
					requests: result.requests.filter((x) => x.phase === 'cold-entry')
						.length,
					encodedBytes: result.requests
						.filter((x) => x.phase === 'cold-entry')
						.reduce((sum, x) => sum + (x.encodedBytes ?? 0), 0),
				},
			}
		} catch (error) {
			result.failure = error.message
		} finally {
			if (accountSession) {
				try {
					await accountSession.close()
				} catch (error) {
					result.cleanupFailure = error.message
				}
			}
			await browser.close()
			result.finishedAt = new Date().toISOString()
			save()
		}
		console.log(
			JSON.stringify({
				label: target.label,
				round: round + 1,
				failure: result.failure ?? null,
				summary: result.summary,
			}),
		)
	}
}
process.exitCode = report.results.some(
	(x) =>
		x.failure ||
		x.cleanupFailure ||
		x.profileRestored === false ||
		x.retentionRestored === false ||
		x.accountChecks.some(
			(check) =>
				!check.mutationPersisted ||
				!check.focusFresh ||
				!check.reconnectRefresh ||
				!check.draftRetained ||
				!check.documentRetained ||
				!check.retentionPersisted ||
				!check.jobsSearchRetained ||
				check.jobsStatus !== 200,
		) ||
		x.errors.length ||
		x.navigation.some((n) => n.fullDocumentReload || n.headingGaps.length),
)
	? 1
	: 0
