#!/usr/bin/env node
import { chromium } from '@playwright/test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

// node long-session-soak.mjs CONFIG_JSON NEW_OUTPUT_DIRECTORY
// Smoke: durationMinutes: 0.05, intervalMs: 1000, idleMs: 1000.
// Optional steps override the default markers for a different seeded fixture.
const [configPath, outputPath] = process.argv.slice(2)
if (!configPath || !outputPath)
	throw new Error('Config and new output directory required')
const config = JSON.parse(readFileSync(configPath, 'utf8'))
if (!config.targets?.length) throw new Error('Targets required')
for (const target of config.targets) {
	const url = new URL(target.origin)
	if (
		!['localhost', '127.0.0.1'].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== '/'
	)
		throw new Error('Bare local origins only')
}
const durationMs = (config.durationMinutes ?? 30) * 60_000
const intervalMs = config.intervalMs ?? 30_000
const idleMs = config.idleMs ?? 330_000
if (
	![durationMs, intervalMs, idleMs].every(
		(value) => Number.isFinite(value) && value >= 0,
	)
)
	throw new Error('Durations must be finite and nonnegative')
const steps = config.steps ?? [
	{
		path: '/account/jobs',
		marker: {
			selector: 'main input[type="number"]',
			property: 'value',
			text: '14',
		},
	},
	{
		path: '/account/memories',
		marker: { selector: 'main h1', text: 'Memories' },
	},
	{
		path: '/account',
		marker: {
			selector: 'main input[name="username"]',
			property: 'value',
			text: 'jane',
		},
	},
]
if (
	!steps.length ||
	steps.some(
		(step) =>
			!step.path?.startsWith('/') ||
			!step.marker?.selector ||
			typeof step.marker.text !== 'string',
	)
)
	throw new Error('Steps need a path and explicit marker')
const output = resolve(outputPath)
if (existsSync(output)) throw new Error('Output directory must be new')
mkdirSync(output, { recursive: true })
const report = {
	startedAt: new Date().toISOString(),
	config,
	harnessSha256: createHash('sha256')
		.update(readFileSync(new URL(import.meta.url)))
		.digest('hex'),
	caveats: [
		'Local bounded-retention and interaction diagnostic, not a cold-load benchmark.',
		'Target browser processes remain resident together; browser operations run sequentially on one machine with natural clocks.',
		'Content readiness uses visible DOM markers. Memories uses its route heading; account and jobs use seeded data values.',
		'Garbage collection is deliberately forced before baseline, each fifth cycle, final active, and post-idle samples.',
		'Heap and DOM retention trends do not prove the absence of leaks. The finite route set does not cover unbounded search-key cardinality.',
		'Idle time allows inactive Query entries to expire, but the visible Account route remains active.',
		'No cookies, credentials, response bodies, console text or full error messages are written.',
	],
	durationMs,
	intervalMs,
	idleMs,
	idleExceedsFiveMinutes: idleMs > 300_000,
	targets: [],
}
const save = () =>
	writeFileSync(
		join(output, 'results.json'),
		JSON.stringify(report, null, 2) + '\n',
	)
const sessions = []
const memory = async (session, phase, cycle, forceGc) => {
	session.row.stage = `memory-${phase}`
	if (forceGc) await session.cdp.send('HeapProfiler.collectGarbage')
	const [performanceMetrics, dom] = await Promise.all([
		session.cdp.send('Performance.getMetrics'),
		session.cdp.send('Memory.getDOMCounters'),
	])
	const values = Object.fromEntries(
		performanceMetrics.metrics.map(({ name, value }) => [name, value]),
	)
	session.row.memory.push({
		phase,
		cycle,
		elapsedMs: performance.now() - session.started,
		forcedGc: forceGc,
		jsHeapUsedBytes: values.JSHeapUsedSize,
		jsHeapTotalBytes: values.JSHeapTotalSize,
		documents: dom.documents,
		nodes: dom.nodes,
		eventListeners: dom.jsEventListeners,
	})
}
const navigate = async (session, step, phase, cycle) => {
	const { page, row } = session
	row.stage = `navigate-${phase}`
	const result = {
		path: step.path,
		phase,
		cycle,
		startedAt: new Date().toISOString(),
	}
	row.steps.push(result)
	const started = performance.now()
	try {
		await page.evaluate((step) => {
			const expected = new URL(step.path, location.origin)
			const link = [...document.querySelectorAll('a[href]')].find((node) => {
				const url = new URL(node.href)
				return (
					url.origin === expected.origin &&
					url.pathname === expected.pathname &&
					url.search === expected.search
				)
			})
			if (!link) throw new Error('Application anchor unavailable')
			window.__soakStep = {
				start: performance.now(),
				readyMs: null,
				timeOrigin: performance.timeOrigin,
			}
			const observe = () => {
				const state = window.__soakStep
				if (
					location.pathname === expected.pathname &&
					location.search === expected.search
				) {
					const marker = [
						...document.querySelectorAll(step.marker.selector),
					].find((node) => {
						const value =
							step.marker.property === 'value' ? node.value : node.textContent
						return String(value ?? '').trim() === step.marker.text
					})
					if (
						marker &&
						marker.getBoundingClientRect().width > 0 &&
						marker.getBoundingClientRect().height > 0 &&
						getComputedStyle(marker).visibility !== 'hidden' &&
						getComputedStyle(marker).opacity !== '0'
					) {
						state.readyMs = performance.now() - state.start
						return
					}
				}
				state.frame = requestAnimationFrame(observe)
			}
			link.click()
			requestAnimationFrame(observe)
		}, step)
		await page.waitForFunction(
			() =>
				window.__soakStep?.readyMs !== null &&
				window.__soakStep?.readyMs !== undefined,
		)
		Object.assign(
			result,
			await page.evaluate(() => ({
				readyMs: window.__soakStep.readyMs,
				documentPreserved:
					performance.timeOrigin === window.__soakStep.timeOrigin,
			})),
		)
		result.correct = true
	} catch (error) {
		result.failure = error.name ?? 'Error'
		result.correct = false
		result.documentPreserved = await page
			.evaluate(() => Boolean(window.__soakStep))
			.catch(() => false)
	} finally {
		result.observedMs = performance.now() - started
		await page
			.evaluate(() => {
				if (window.__soakStep) cancelAnimationFrame(window.__soakStep.frame)
			})
			.catch(() => {})
	}
}
save()
try {
	for (const target of config.targets) {
		const row = {
			label: target.label,
			stage: 'setup',
			memory: [],
			steps: [],
			pageErrorCount: 0,
			consoleErrorCount: 0,
			requestFailureCount: 0,
		}
		report.targets.push(row)
		const session = { row, started: performance.now() }
		sessions.push(session)
		try {
			session.browser = await chromium.launch({
				executablePath:
					config.chromePath ??
					'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
			})
			const context = await session.browser.newContext({
				viewport: { width: 1350, height: 940 },
			})
			context.setDefaultTimeout(config.timeoutMs ?? 15000)
			const auth = await context.request.post(target.origin + '/auth', {
				data: {
					email: 'jane@example.com',
					password: 'ilikecode',
					mode: 'login',
				},
			})
			if (!auth.ok()) throw new Error('Seeded login failed')
			session.page = await context.newPage()
			session.page.on('pageerror', () => row.pageErrorCount++)
			session.page.on('console', (message) => {
				if (message.type() === 'error') row.consoleErrorCount++
			})
			session.page.on('requestfailed', () => row.requestFailureCount++)
			session.cdp = await context.newCDPSession(session.page)
			await session.cdp.send('Performance.enable')
			await session.page.goto(target.origin + '/account', {
				waitUntil: 'networkidle',
			})
			await session.page.waitForFunction(
				() => document.documentElement.dataset.hydrated === 'true',
			)
			await session.page.waitForFunction(
				() =>
					document.querySelector('main input[name="username"]')?.value ===
					'jane',
			)
			await memory(session, 'initial', 0, true)
			session.ready = true
		} catch (error) {
			row.failure = error.name ?? 'Error'
		}
		save()
	}
	const ready = sessions.filter((session) => session.ready)
	if (!ready.length) throw new Error('No target initialized')
	const activeStarted = performance.now()
	let cycle = 0
	do {
		cycle++
		for (const step of steps) {
			for (let index = 0; index < ready.length; index++) {
				const session = ready[(index + cycle - 1) % ready.length]
				await navigate(session, step, 'active', cycle)
			}
		}
		for (const session of ready) {
			try {
				await memory(session, 'active', cycle, cycle % 5 === 0)
			} catch (error) {
				session.row.failure = error.name ?? 'Error'
			}
		}
		save()
		const remaining = durationMs - (performance.now() - activeStarted)
		if (remaining <= 0) break
		await delay(Math.min(intervalMs, remaining))
	} while (performance.now() - activeStarted < durationMs)
	report.activeElapsedMs = performance.now() - activeStarted
	for (const session of ready)
		await memory(session, 'active-final', cycle, true)
	report.idleStartedAt = new Date().toISOString()
	save()
	await delay(idleMs)
	for (const session of ready)
		await memory(session, 'post-idle-before-navigation', cycle, true)
	for (const step of steps)
		for (const session of ready)
			await navigate(session, step, 'post-idle', cycle + 1)
	for (const session of ready)
		await memory(session, 'post-idle-final', cycle + 1, true)
	report.completedAt = new Date().toISOString()
} catch (error) {
	report.failure = error.name ?? 'Error'
} finally {
	for (const session of sessions)
		await session.browser?.close().catch(() => {
			session.row.cleanupFailure = true
		})
	save()
}
process.exitCode =
	report.failure ||
	report.targets.some(
		(row) =>
			row.failure ||
			row.cleanupFailure ||
			row.pageErrorCount ||
			row.steps.some((step) => !step.correct),
	)
		? 1
		: 0
