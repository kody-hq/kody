#!/usr/bin/env node
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import {
	readEdgeAuth,
	installEdgeAuth,
	makeSanitizer,
	deliveryHeaders,
} from './edge-auth.mjs'
const [outputArg, packageDirectory, countArg = '3'] = process.argv.slice(2)
if (!outputArg || !packageDirectory)
	throw new Error(
		'Usage: node edge-document-timing.mjs NEW_OUTPUT_DIRECTORY LIGHTHOUSE_PACKAGE_DIRECTORY [PAIRS]',
	)
const output = resolve(outputArg)
if (existsSync(join(output, 'timings.json')))
	throw new Error('Use a fresh output directory')
const require = createRequire(join(resolve(packageDirectory), 'package.json'))
const { default: puppeteer } = await import(
	pathToFileURL(require.resolve('puppeteer-core')).href
)
const auth = readEdgeAuth(),
	sanitize = makeSanitizer(auth)
const targets = [...auth.keys()].map((origin) => ({
	origin,
	label: origin.includes('compare-remix') ? 'remix' : 'start',
}))
const count = Number(countArg)
if (targets.length !== 2 || !Number.isInteger(count) || count < 1)
	throw new Error('Expected two targets and positive pair count')
mkdirSync(output, { recursive: true })
const results = []
for (let run = 1; run <= count; run++)
	for (const target of run % 2 ? targets : [...targets].reverse()) {
		let browser
		try {
			browser = await puppeteer.launch({
				executablePath:
					process.env.CHROME_PATH ??
					'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
				headless: true,
				timeout: 30000,
			})
			const page = await browser.newPage()
			await installEdgeAuth(page, auth)
			const client = await page.createCDPSession()
			await client.send('Network.enable')
			const documents = []
			client.on('Network.responseReceived', ({ type, response }) => {
				if (type === 'Document')
					documents.push({
						url: response.url,
						status: response.status,
						protocol: response.protocol,
						connectionReused: response.connectionReused,
						connectionId: response.connectionId,
						fromDiskCache: response.fromDiskCache,
						fromServiceWorker: response.fromServiceWorker,
						timing: response.timing,
						delivery: deliveryHeaders(response.headers),
					})
			})
			const started = performance.now()
			const response = await page.goto(target.origin, {
				waitUntil: 'domcontentloaded',
				timeout: 60000,
			})
			const domContentLoadedWallMs = performance.now() - started
			const navigation = await page.evaluate(() => {
				const n = performance.getEntriesByType('navigation')[0]
				if (!n) return null
				return Object.fromEntries(
					[
						'startTime',
						'fetchStart',
						'domainLookupStart',
						'domainLookupEnd',
						'connectStart',
						'connectEnd',
						'secureConnectionStart',
						'requestStart',
						'responseStart',
						'responseEnd',
						'domInteractive',
						'domContentLoadedEventStart',
						'domContentLoadedEventEnd',
						'transferSize',
						'encodedBodySize',
						'decodedBodySize',
						'nextHopProtocol',
					].map((key) => [key, n[key]]),
				)
			})
			const content = await page.evaluate(() => ({
				title: document.title,
				mainCount: document.querySelectorAll('main').length,
				heading: document.querySelector('main h1')?.textContent,
			}))
			results.push({
				label: target.label,
				origin: target.origin,
				run,
				status: response?.status(),
				domContentLoadedWallMs,
				navigation,
				documents,
				content,
			})
		} catch (error) {
			results.push({ label: target.label, run, error: sanitize(error.message) })
		} finally {
			await browser?.close()
		}
		writeFileSync(
			join(output, 'timings.json'),
			JSON.stringify(
				sanitize({
					measuredAt: new Date().toISOString(),
					method:
						'Fresh headless Chrome, same origin-scoped Access interception, no Lighthouse and no CPU/network throttling. Alternating pairs. Only document response timing and allowlisted delivery fields retained, no raw headers.',
					results,
				}),
				null,
				2,
			) + '\n',
		)
	}
console.log(
	JSON.stringify({
		samples: results.length,
		failures: results.filter(
			(x) => x.error || x.status !== 200 || x.content?.mainCount !== 1,
		).length,
	}),
)
