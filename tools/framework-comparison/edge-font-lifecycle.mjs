#!/usr/bin/env node
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readEdgeAuth, installEdgeAuth, makeSanitizer } from './edge-auth.mjs'
const [outputArg, packageDirectory] = process.argv.slice(2)
if (!outputArg || !packageDirectory)
	throw new Error(
		'Usage: node edge-font-lifecycle.mjs OUTPUT_DIRECTORY LIGHTHOUSE_PACKAGE_DIRECTORY',
	)
const output = resolve(outputArg)
mkdirSync(output, { recursive: true })
const require = createRequire(join(resolve(packageDirectory), 'package.json'))
const { default: puppeteer } = await import(
	pathToFileURL(require.resolve('puppeteer-core')).href
)
const auth = readEdgeAuth(),
	sanitize = makeSanitizer(auth)
for (const origin of auth.keys()) {
	const label = origin.includes('compare-remix') ? 'remix' : 'start'
	if (process.env.EDGE_FONT_LABEL && process.env.EDGE_FONT_LABEL !== label)
		continue
	const browser = await puppeteer.launch({
		executablePath:
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		headless: true,
	})
	try {
		const page = await browser.newPage()
		await page.setViewport({
			width: 412,
			height: 823,
			deviceScaleFactor: 1,
			isMobile: true,
		})
		await installEdgeAuth(page, auth)
		const client = await page.createCDPSession()
		await client.send('Network.enable')
		await client.send('Network.emulateNetworkConditions', {
			offline: false,
			latency: 562.5,
			downloadThroughput: (1474.56 * 1024) / 8,
			uploadThroughput: (675 * 1024) / 8,
		})
		await client.send('Emulation.setCPUThrottlingRate', { rate: 4 })
		const network = []
		page.on('response', (r) => {
			if (r.request().resourceType() === 'font')
				network.push({
					url: r.url(),
					status: r.status(),
					at: performance.now(),
				})
		})
		const errors = []
		page.on('pageerror', (e) => errors.push(e.message))
		await page.evaluateOnNewDocument(() => {
			const events = []
			window.__fontLifecycle = events
			const ids = new WeakMap()
			const lastStyleText = new WeakMap()
			let serial = 0
			const id = (n) => {
				if (!ids.has(n)) ids.set(n, ++serial)
				return ids.get(n)
			}
			const push = (type, data) => {
				if (events.length < 1000)
					events.push({ at: performance.now(), type, ...data })
			}

			const inner = Object.getOwnPropertyDescriptor(
				Element.prototype,
				'innerHTML',
			)
			const hash = (text) => {
				let n = 2166136261
				for (let i = 0; i < text.length; i++) {
					n ^= text.charCodeAt(i)
					n = Math.imul(n, 16777619)
				}
				return (n >>> 0).toString(16)
			}
			Object.defineProperty(Element.prototype, 'innerHTML', {
				...inner,
				set(value) {
					if (
						this.tagName === 'STYLE' &&
						(this.textContent.includes('@font-face') ||
							String(value).includes('@font-face'))
					) {
						const before = inner.get.call(this),
							after = String(value)
						push('global-style-innerHTML-set', {
							id: id(this),
							equal: before === after,
							beforeHash: hash(before),
							afterHash: hash(after),
							beforeLength: before.length,
							afterLength: after.length,
							frames: (new Error().stack ?? '')
								.split('\n')
								.map((line) => line.match(/https:\/\/[^\s)]+:\d+:\d+/)?.[0])
								.filter(Boolean),
						})
					}
					return inner.set.call(this, value)
				},
			})
			const selector = (n) =>
				n?.nodeType === 1
					? `${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}${n.classList?.length ? '.' + [...n.classList].slice(0, 3).join('.') : ''}`
					: null
			const detail = (n) => {
				let contentEqualsPrevious = null
				if (n.tagName === 'STYLE') {
					contentEqualsPrevious = lastStyleText.has(n)
						? lastStyleText.get(n) === n.textContent
						: null
					lastStyleText.set(n, n.textContent)
				}
				return {
					contentEqualsPrevious,
					id: id(n),
					tag: n.tagName,
					parent: selector(n.parentElement),
					connected: n.isConnected,
					bytes: n.tagName === 'STYLE' ? n.textContent.length : 0,
					fontFaces:
						n.tagName === 'STYLE' && n.textContent.includes('@font-face'),
					rel: n.getAttribute('rel'),
					href: n.tagName === 'LINK' ? n.getAttribute('href') : null,
					crossorigin: n.getAttribute('crossorigin'),
				}
			}
			const relevant = (n) =>
				n?.nodeType === 1 &&
				(n.tagName === 'STYLE' ||
					(n.tagName === 'LINK' &&
						['stylesheet', 'preload'].includes(n.getAttribute('rel'))))
			const visit = (n, type) => {
				if (relevant(n)) push(type, detail(n))
				if (n.nodeType === 1)
					for (const child of n.querySelectorAll(
						'style,link[rel="stylesheet"],link[as="font"]',
					))
						push(type, detail(child))
			}
			new MutationObserver((records) => {
				for (const m of records) {
					if (m.type === 'childList') {
						for (const n of m.removedNodes) visit(n, 'removed')
						for (const n of m.addedNodes) visit(n, 'added')
						if (m.target.nodeType === 1 && m.target.tagName === 'STYLE')
							push('style-content', detail(m.target))
					} else if (
						m.type === 'characterData' &&
						m.target.parentElement?.tagName === 'STYLE'
					)
						push('style-content', detail(m.target.parentElement))
					else if (m.type === 'attributes' && relevant(m.target))
						push('attribute', detail(m.target))
				}
			}).observe(document, {
				subtree: true,
				childList: true,
				characterData: true,
				attributes: true,
				attributeFilter: ['rel', 'href', 'crossorigin', 'media'],
			})
			for (const name of ['loading', 'loadingdone', 'loadingerror'])
				document.fonts.addEventListener(name, (e) =>
					push('fonts-' + name, {
						status: document.fonts.status,
						faces: [...(e.fontfaces ?? [])].map((f) => ({
							family: f.family,
							status: f.status,
						})),
					}),
				)
			new PerformanceObserver((list) => {
				for (const e of list.getEntries())
					push('layout-shift', {
						value: e.value,
						hadRecentInput: e.hadRecentInput,
						sources: e.sources?.map((s) => ({
							node: selector(s.node),
							previous: s.previousRect.toJSON(),
							current: s.currentRect.toJSON(),
						})),
					})
			}).observe({ type: 'layout-shift', buffered: true })
			window.__fontSnapshot = () => ({
				at: performance.now(),
				fontStatus: document.fonts.status,
				styles: [...document.querySelectorAll('style')]
					.filter((n) => n.textContent.includes('@font-face'))
					.map(detail),
				paragraphs: [...document.querySelectorAll('main article p')]
					.slice(0, 2)
					.map((n) => ({
						node: selector(n),
						top: n.getBoundingClientRect().top,
						height: n.getBoundingClientRect().height,
						font: getComputedStyle(n).fontFamily,
					})),
			})
		})
		const response = await page.goto(origin + '/docs', {
			waitUntil: 'domcontentloaded',
			timeout: 60000,
		})
		const snapshots = []
		for (const delay of [0, 3000, 9000]) {
			if (delay) await new Promise((r) => setTimeout(r, delay))
			snapshots.push(await page.evaluate(() => window.__fontSnapshot()))
		}
		const events = await page.evaluate(() => window.__fontLifecycle)
		const result = sanitize({
			label,
			origin,
			status: response.status(),
			diagnosticSettings:
				'412x823 mobile viewport, 4x CPU,562.5ms latency,1474.56Kibps download,675Kibps upload, same Access request interception. Diagnostic only, not Lighthouse scoring.',
			events,
			snapshots,
			network,
			errors,
		})
		writeFileSync(
			join(output, label + '.json'),
			JSON.stringify(result, null, 2) + '\n',
		)
		console.log(
			JSON.stringify({
				label,
				events: events.length,
				fontEvents: events.filter((e) => e.type.startsWith('fonts-')),
				shifts: events
					.filter((e) => e.type === 'layout-shift')
					.map((e) => ({ at: e.at, value: e.value })),
				errors,
			}),
		)
	} finally {
		await browser.close()
	}
}
