#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readEdgeAuth, deliveryHeaders } from './edge-auth.mjs'
const [outputArg, countArg = '10'] = process.argv.slice(2)
if (!outputArg)
	throw new Error(
		'Usage: node edge-http.mjs NEW_OUTPUT_DIRECTORY [PAIRS_PER_PAGE]',
	)
const output = resolve(outputArg)
if (existsSync(join(output, 'requests.json')))
	throw new Error('Use a fresh output directory')
const count = Number(countArg)
if (!Number.isInteger(count) || count < 1) throw new Error('Invalid pair count')
const auth = readEdgeAuth()
if (auth.size !== 2)
	throw new Error('Expected exactly two configured comparison origins')
const targets = [...auth].map(([origin, headers]) => ({
	origin,
	headers,
	label: origin.includes('compare-remix') ? 'remix' : 'start',
}))
mkdirSync(output, { recursive: true })
const results = []
for (const path of ['/', '/pricing', '/docs'])
	for (let run = 1; run <= count; run++)
		for (const target of run % 2 ? targets : [...targets].reverse()) {
			const started = performance.now()
			try {
				const response = await fetch(new URL(path, target.origin), {
					headers: { ...target.headers, 'accept-encoding': 'gzip, br' },
					redirect: 'manual',
					signal: AbortSignal.timeout(30000),
				})
				const headersMs = performance.now() - started
				const body = await response.text()
				results.push({
					label: target.label,
					origin: target.origin,
					path,
					run,
					status: response.status,
					headersMs,
					bodyMs: performance.now() - started,
					decodedBytes: Buffer.byteLength(body),
					completeHtml: body.includes('<main') && body.includes('</html>'),
					delivery: deliveryHeaders(Object.fromEntries(response.headers)),
				})
			} catch {
				results.push({
					label: target.label,
					path,
					run,
					error: 'HTTP request failed or timed out',
				})
			}
			writeFileSync(
				join(output, 'requests.json'),
				JSON.stringify(
					{
						measuredAt: new Date().toISOString(),
						method:
							'Sequential alternating Node fetch, no Puppeteer interception or throttling; connection reuse allowed; header timing includes DNS/TLS/Access/network, not pure origin time; no cache-control/pragma request headers; gzip/br requested',
						results,
					},
					null,
					2,
				) + '\n',
			)
		}
console.log(
	JSON.stringify({
		attempts: results.length,
		failures: results.filter(
			(row) => row.error || row.status !== 200 || !row.completeHtml,
		).length,
	}),
)
