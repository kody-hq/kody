#!/usr/bin/env node
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { readEdgeAuth, installEdgeAuth, makeSanitizer } from './edge-auth.mjs'

const [outputArg, packageDirectory] = process.argv.slice(2)
if (!outputArg || !packageDirectory)
	throw new Error(
		'Usage: edge-hero-visibility.mjs NEW_OUTPUT_DIRECTORY LIGHTHOUSE_PACKAGE_DIRECTORY',
	)
const output = resolve(outputArg)
if (existsSync(output)) throw new Error('Use a fresh output directory')
mkdirSync(output, { recursive: true })
const require = createRequire(join(resolve(packageDirectory), 'package.json'))
const { default: puppeteer } = await import(
	pathToFileURL(require.resolve('puppeteer-core')).href
)
const auth = readEdgeAuth()
const sanitize = makeSanitizer(auth)
const browser = await puppeteer.launch({
	executablePath:
		process.env.CHROME_PATH ??
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	headless: true,
})
try {
	for (const [origin, headers] of auth) {
		const label = origin.includes('compare-remix')
			? 'remix'
			: origin.includes('compare-start')
				? 'start'
				: null
		if (!label) continue
		const context = await browser.createBrowserContext()
		try {
			const page = await context.newPage()
			await page.setViewport({
				width: 1350,
				height: 940,
				deviceScaleFactor: 1,
			})
			await page.setCacheEnabled(false)
			await page.setBypassServiceWorker(true)
			await installEdgeAuth(page, new Map([[origin, headers]]))
			let pageErrors = 0
			page.on('pageerror', () => pageErrors++)
			await page.evaluateOnNewDocument(() => {
				const events = []
				window.__heroVisibility = events
				const ids = new WeakMap()
				let serial = 0
				const id = (node) => {
					if (!node) return null
					if (!ids.has(node)) ids.set(node, ++serial)
					return ids.get(node)
				}
				const push = (type, data = {}) => {
					if (events.length < 1500)
						events.push({ at: performance.now(), type, ...data })
				}
				const selectors = ['main h1', '#primitives-title']
				const state = (node) => {
					if (!node) return null
					const style = getComputedStyle(node)
					const rect = node.getBoundingClientRect()
					const ancestors = []
					for (let parent = node; parent; parent = parent.parentElement) {
						const css = getComputedStyle(parent)
						if (
							css.opacity !== '1' ||
							css.visibility !== 'visible' ||
							css.display === 'none' ||
							css.animationName !== 'none'
						)
							ancestors.push({
								node: id(parent),
								tag: parent.tagName,
								opacity: css.opacity,
								visibility: css.visibility,
								display: css.display,
								animation: css.animationName,
								delay: css.animationDelay,
								duration: css.animationDuration,
								fill: css.animationFillMode,
							})
					}
					return {
						node: id(node),
						tag: node.tagName,
						elementId: node.id,
						dataRise: node.getAttribute('data-rise'),
						connected: node.isConnected,
						opacity: style.opacity,
						visibility: style.visibility,
						display: style.display,
						fontFamily: style.fontFamily,
						fontSize: style.fontSize,
						rect: {
							x: rect.x,
							y: rect.y,
							width: rect.width,
							height: rect.height,
						},
						ancestors,
						animations: node.getAnimations().map((animation) => ({
							name: animation.animationName ?? null,
							state: animation.playState,
							time: animation.currentTime,
							timing: animation.effect?.getComputedTiming(),
						})),
					}
				}
				let previous = []
				const sample = (reason, frame = null) => {
					const nodes = selectors.map((selector) =>
						document.querySelector(selector),
					)
					const current = nodes.map(id)
					if (current.some((value, i) => value !== previous[i])) {
						push('node-identity-change', { previous, current })
						previous = current
					}
					push('sample', {
						reason,
						frame,
						hydrated: document.documentElement?.dataset.hydrated ?? null,
						jsClass:
							document.documentElement?.classList.contains('js') ?? false,
						spaNavigation:
							document.documentElement?.hasAttribute('data-spa-nav') ?? false,
						fonts: document.fonts.status,
						nodes: nodes.map(state),
					})
				}
				new MutationObserver(() => {
					const current = selectors.map((selector) =>
						id(document.querySelector(selector)),
					)
					if (current.some((value, i) => value !== previous[i]))
						sample('mutation')
				}).observe(document, { subtree: true, childList: true })
				for (const type of [
					'animationstart',
					'animationend',
					'animationcancel',
				]) {
					document.addEventListener(
						type,
						(event) => {
							const hero = document.querySelector('main h1')
							if (
								event.target instanceof Element &&
								(event.target === hero ||
									event.target.contains(hero) ||
									hero?.contains(event.target))
							) {
								push(type, {
									node: id(event.target),
									name: event.animationName,
									elapsed: event.elapsedTime,
								})
								sample(type)
							}
						},
						true,
					)
				}
				for (const type of ['loading', 'loadingdone', 'loadingerror'])
					document.fonts.addEventListener(type, () =>
						push(`fonts-${type}`, {
							status: document.fonts.status,
							count: document.fonts.size,
						}),
					)
				document.fonts.ready.then(() =>
					push('fonts-ready', { status: document.fonts.status }),
				)
				new PerformanceObserver((list) => {
					for (const entry of list.getEntries())
						push('lcp', {
							start: entry.startTime,
							render: entry.renderTime,
							load: entry.loadTime,
							size: entry.size,
							node: id(entry.element),
							tag: entry.element?.tagName ?? null,
							elementId: entry.element?.id ?? null,
						})
				}).observe({ type: 'largest-contentful-paint', buffered: true })
				let frame = 0
				let previousCheckpoint = -250
				const tick = () => {
					const now = performance.now()
					if (
						[0, 1, 2, 3, 5, 10, 20, 30, 60, 90, 120, 180].includes(frame) ||
						now - previousCheckpoint >= 250
					) {
						sample('raf', frame)
						previousCheckpoint = now
					}
					frame++
					if (now < 8000) requestAnimationFrame(tick)
				}
				requestAnimationFrame(tick)
				document.addEventListener('DOMContentLoaded', () =>
					sample('DOMContentLoaded'),
				)
				window.addEventListener('load', () => sample('load'))
			})
			const response = await page.goto(`${origin}/`, {
				waitUntil: 'load',
				timeout: 60000,
			})
			await page.waitForFunction(() => performance.now() >= 8500, {
				timeout: 30000,
			})
			const events = await page.evaluate(() => window.__heroVisibility)
			writeFileSync(
				join(output, `${label}.json`),
				JSON.stringify(
					sanitize({
						origin,
						status: response?.status(),
						pageErrors,
						viewport: { width: 1350, height: 940 },
						conditions:
							'Fresh browser context, disabled HTTP cache, no CPU or network throttling. Diagnostic timings are not Lighthouse simulated timings.',
						events,
					}),
					null,
					2,
				) + '\n',
				{ mode: 0o600, flag: 'wx' },
			)
			console.log(
				JSON.stringify({
					label,
					status: response?.status(),
					pageErrors,
					events: events.length,
				}),
			)
		} finally {
			await context.close()
		}
	}
} catch (error) {
	console.error(
		JSON.stringify({
			failed: true,
			errorType: error instanceof Error ? error.name : 'unknown',
		}),
	)
	process.exitCode = 1
} finally {
	await browser.close()
}
