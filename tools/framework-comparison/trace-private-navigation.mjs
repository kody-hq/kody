#!/usr/bin/env node
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [origin, directory] = process.argv.slice(2)
if (
	!origin ||
	!directory ||
	!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)
)
	throw new Error(
		'Usage: trace-private-navigation.mjs LOCAL_ORIGIN NEW_DIRECTORY',
	)
const output = resolve(directory)
mkdirSync(output)
const browser = await chromium.launch({
	executablePath:
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
const report = {
	origin,
	startedAt: new Date().toISOString(),
	browserVersion: browser.version(),
	navigation: [],
	errors: [],
	caveat:
		'Separate instrumented diagnostic, not a performance sample. Trace overhead changes timings. Frame readiness is DOM/style observation, not physical pixel presentation. Only the primary renderer is observed.',
}
try {
	const context = await browser.newContext({
		viewport: { width: 1350, height: 940 },
	})
	const login = await context.request.post(origin + '/auth', {
		data: { email: 'jane@example.com', password: 'ilikecode', mode: 'login' },
	})
	if (!login.ok()) throw new Error('Local fixture login failed')
	const page = await context.newPage()
	page.on('pageerror', (error) => report.errors.push(error.message))
	await page.goto(origin + '/account', { waitUntil: 'networkidle' })
	await page.waitForFunction(
		() => document.documentElement.dataset.hydrated === 'true',
	)
	const navigate = async (path, name) => {
		await page.evaluate(
			({ path, name }) => {
				performance.clearResourceTimings()
				performance.mark(name + '-click')
				const link = [...document.querySelectorAll('a[href]')].find(
					(node) => new URL(node.href).pathname === path,
				)
				if (!link) throw new Error('Missing application link')
				window.__traceReady = false
				const observe = () => {
					const marker = document.querySelector(
						path === '/account'
							? 'main input[name="username"]'
							: 'main input[type="number"]',
					)
					let visible =
						location.pathname === path &&
						marker?.value === (path === '/account' ? 'jane' : '14') &&
						marker.getBoundingClientRect().width > 0
					for (let node = marker; visible && node; node = node.parentElement) {
						const style = getComputedStyle(node)
						if (
							style.display === 'none' ||
							style.visibility === 'hidden' ||
							Number(style.opacity) === 0
						)
							visible = false
					}
					if (visible) {
						performance.mark(name + '-ready')
						window.__traceReady = true
					} else requestAnimationFrame(observe)
				}
				link.click()
				requestAnimationFrame(observe)
			},
			{ path, name },
		)
		await page.waitForFunction(() => window.__traceReady === true)
		await page.waitForLoadState('networkidle')
		return page.evaluate(
			({ path, name }) => {
				const start = performance
					.getEntriesByName(name + '-click')
					.at(-1).startTime
				const end = performance
					.getEntriesByName(name + '-ready')
					.at(-1).startTime
				return {
					path,
					name,
					startMs: start,
					readyMs: end,
					durationMs: end - start,
					timeOrigin: performance.timeOrigin,
					resources: performance.getEntriesByType('resource').map((entry) => ({
						path: new URL(entry.name).pathname,
						startMs: entry.startTime - start,
						responseStartMs: entry.responseStart - start,
						responseEndMs: entry.responseEnd - start,
						transferSize: entry.transferSize,
					})),
				}
			},
			{ path, name },
		)
	}
	await navigate('/account/jobs', 'warmup-jobs')
	await navigate('/account', 'warmup-account')
	const client = await context.newCDPSession(page)
	await client.send('Tracing.start', {
		categories:
			'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,v8,disabled-by-default-v8.cpu_profiler',
		transferMode: 'ReturnAsStream',
	})
	for (let index = 0; index < 10; index++)
		report.navigation.push(
			await navigate(index % 2 ? '/account' : '/account/jobs', 'nav-' + index),
		)
	const finished = new Promise((resolve) =>
		client.once('Tracing.tracingComplete', resolve),
	)
	await client.send('Tracing.end')
	const { stream } = await finished
	let trace = ''
	for (;;) {
		const chunk = await client.send('IO.read', { handle: stream })
		trace += chunk.base64Encoded
			? Buffer.from(chunk.data, 'base64').toString('utf8')
			: chunk.data
		if (chunk.eof) break
	}
	await client.send('IO.close', { handle: stream })
	writeFileSync(join(output, 'trace.json'), trace)
} catch (error) {
	report.failure = error.message
	process.exitCode = 1
} finally {
	await browser.close()
	report.finishedAt = new Date().toISOString()
	writeFileSync(
		join(output, 'result.json'),
		JSON.stringify(report, null, 2) + '\n',
	)
}
