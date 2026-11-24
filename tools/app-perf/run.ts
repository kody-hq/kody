/**
 * Web app performance measurements for a local dev server.
 * See docs/contributing/app-performance.md.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { playwrightCookiesFromHeader } from '../control-kody/browse.ts'
import { isExecutedDirectly } from '../node-runtime.ts'
import {
	buildChunkGraph,
	formatComparison,
	gzipBytes,
	measureRoute,
	staticClosure,
	type ProbeEvent,
	type RouteMeasurement,
} from './analysis.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const usage = `Usage: npm run app-perf -- <command> [options]

  ssr       Binding round trips, sequential depth, and repeats per document request
            --org <slug> [--package <org>/<name>] [--routes <file>] [--out <file>]
            [--trace <route>]   print every round trip of one route with its caller
  compare   Markdown before/after table from two \`ssr --out\` files
            <before.json> <after.json>
  nav       Requests sent on hover and on click, and click-to-URL time, in Chromium
            <path> <path> [...]   links are followed in order from the first path
  bundle    Gzip size of what every page downloads, and what a route chunk adds
            [--assets dist/client/assets] [--max-entry-kb <n>] [chunk-name-part ...]

Common: --origin http://localhost:3742  --cookie-file .tmp/control-kody-cookie
ssr needs the dev server started with VITE_KODY_PERF_PROBE=1.`

type Options = {
	origin: string
	cookieFile: string
}

async function readCookie(file: string) {
	const lines = (await readFile(file, 'utf8'))
		.split('\n')
		.filter((line) => line && !line.startsWith('#'))
	const cookie = lines.at(-1)
	if (!cookie)
		throw new Error(`No session cookie in ${file}. Run control-kody login.`)
	return cookie
}

async function readRoutes(
	file: string,
	values: Record<string, string | undefined>,
) {
	const routes: Array<{ path: string; anonymous: boolean }> = []
	for (const raw of (await readFile(file, 'utf8')).split('\n')) {
		const line = raw.trim()
		if (!line || line.startsWith('#')) continue
		let skipped = false
		const filled = line.replace(/\{(\w+)\}/g, (_match, name: string) => {
			const value = values[name]
			if (!value) skipped = true
			return value ?? ''
		})
		if (skipped) continue
		routes.push({
			path: filled.replace(/^!/, ''),
			anonymous: filled.startsWith('!'),
		})
	}
	return routes
}

async function dumpProbe(origin: string) {
	const response = await fetch(`${origin}/__perf/dump`)
	if (!response.headers.get('content-type')?.includes('application/json')) {
		throw new Error(
			'The binding probe is off. Restart the dev server with VITE_KODY_PERF_PROBE=1.',
		)
	}
	return (await response.json()) as Array<{
		url: string
		events: Array<ProbeEvent>
	}>
}

async function ssr(options: Options, argv: Array<string>) {
	const { values } = parseArgs({
		args: argv,
		options: {
			org: { type: 'string' },
			package: { type: 'string' },
			routes: { type: 'string', default: path.join(here, 'routes.txt') },
			out: { type: 'string' },
			trace: { type: 'string' },
		},
	})
	const cookie = await readCookie(options.cookieFile)
	const routes = await readRoutes(values.routes, {
		org: values.org,
		package: values.package,
	})
	const results: Record<string, RouteMeasurement> = {}
	await dumpProbe(options.origin)
	for (const route of routes) {
		let status = 0
		let ttfbMs = 0
		// The third request is the measured one: the first two warm module
		// initialization and any lazily created rows.
		for (let attempt = 0; attempt < 3; attempt++) {
			const started = performance.now()
			const response = await fetch(options.origin + route.path, {
				headers: route.anonymous ? {} : { cookie },
				redirect: 'manual',
			})
			ttfbMs = performance.now() - started
			status = response.status
			await response.arrayBuffer()
		}
		// Work that outlives the response still belongs to the request.
		await new Promise((done) => setTimeout(done, 150))
		const record = (await dumpProbe(options.origin))
			.filter((entry) => entry.url === options.origin + route.path)
			.at(-1)
		const key = `${route.anonymous ? '!' : ''}${route.path}`
		const result = measureRoute(status, ttfbMs, record?.events ?? [])
		results[key] = result
		const repeats = Object.values(result.duplicates).reduce(
			(sum, count) => sum + count - 1,
			0,
		)
		console.log(
			`${status} ${key.padEnd(52)} ttfb=${String(result.ttfbMs).padStart(4)}ms d1=${String(result.d1).padStart(3)} depth=${String(result.depth).padStart(3)} repeats=${repeats} other=${JSON.stringify(result.other)}`,
		)
	}
	const all = Object.values(results)
	console.log(
		`TOTAL routes=${all.length} d1=${all.reduce((n, r) => n + r.d1, 0)} depth=${all.reduce((n, r) => n + r.depth, 0)}`,
	)
	if (values.trace) {
		const traced = results[values.trace]
		if (!traced) throw new Error(`--trace ${values.trace} was not measured`)
		for (const event of traced.events) {
			console.log(
				`  +${event.at}ms ${event.ms}ms ${event.binding} ${event.op} ${event.detail?.slice(0, 80) ?? ''}\n      ${event.stack?.split(' < ').slice(0, 4).join(' < ') ?? ''}`,
			)
		}
	}
	if (values.out) await writeFile(values.out, JSON.stringify(results, null, 1))
}

async function compare(argv: Array<string>) {
	const [before, after] = argv
	if (!before || !after) throw new Error(usage)
	console.log(
		formatComparison(
			JSON.parse(await readFile(before, 'utf8')),
			JSON.parse(await readFile(after, 'utf8')),
		),
	)
}

function requestLabel(url: URL) {
	const prefix = '/_serverFn/'
	if (!url.pathname.startsWith(prefix)) return url.pathname
	try {
		const id = JSON.parse(
			Buffer.from(url.pathname.slice(prefix.length), 'base64url').toString(),
		) as { file?: string; export?: string }
		const file = String(id.file).split('/').pop()?.split('?')[0]
		return `fn:${file}#${id.export}`
	} catch {
		return url.pathname.slice(0, 60)
	}
}

async function nav(options: Options, paths: Array<string>) {
	if (paths.length < 2) throw new Error(usage)
	const { chromium } = await import('playwright')
	const browser = await chromium.launch()
	try {
		const context = await browser.newContext()
		await context.addCookies(
			playwrightCookiesFromHeader(
				await readCookie(options.cookieFile),
				options.origin,
			),
		)
		const page = await context.newPage()
		let requests: Array<{ at: number; label: string }> = []
		page.on('request', (request) => {
			if (!['fetch', 'xhr'].includes(request.resourceType())) return
			requests.push({
				at: Date.now(),
				label: `${request.method()} ${requestLabel(new URL(request.url()))}`,
			})
		})
		const settle = async () => {
			for (let seen = -1; seen !== requests.length;) {
				seen = requests.length
				await page.waitForTimeout(300)
				await page
					.waitForLoadState('networkidle', { timeout: 5000 })
					.catch(() => {})
			}
		}
		await page.goto(options.origin + paths[0])
		await settle()
		const steps = []
		for (const target of paths.slice(1)) {
			const link = page.locator(`a[href="${target}"]`).first()
			if (!(await link.count())) {
				steps.push({ path: target, error: 'no link to this path on the page' })
				continue
			}
			requests = []
			await link.hover()
			await page.waitForTimeout(600)
			await settle()
			const onHover = requests.map((request) => request.label)
			requests = []
			const clickedAt = Date.now()
			await link.click()
			await page.waitForURL((url) => url.pathname === target, {
				timeout: 15_000,
			})
			const clickToUrlMs = Date.now() - clickedAt
			await settle()
			steps.push({
				path: target,
				onHover,
				clickToUrlMs,
				onClick: requests.map(
					(request) => `+${request.at - clickedAt}ms ${request.label}`,
				),
			})
		}
		console.log(JSON.stringify(steps, null, 1))
	} finally {
		await browser.close()
	}
}

async function bundle(argv: Array<string>) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			assets: { type: 'string', default: 'dist/client/assets' },
			'max-entry-kb': { type: 'string' },
		},
	})
	const sources = new Map<string, string>()
	for (const name of await readdir(values.assets)) {
		if (!name.endsWith('.js')) continue
		sources.set(name, await readFile(path.join(values.assets, name), 'utf8'))
	}
	const graph = buildChunkGraph(sources)
	const entry = [...sources]
		.filter(([name]) => name.startsWith('index-'))
		.sort((a, b) => b[1].length - a[1].length)[0]?.[0]
	if (!entry)
		throw new Error(
			`No index-*.js entry in ${values.assets}. Run npm run build.`,
		)
	const kb = (bytes: number) => (bytes / 1024).toFixed(1).padStart(7)
	const largest = (chunks: Iterable<string>, count: number) =>
		[...chunks]
			.sort((a, b) => graph.get(b)!.gzipBytes - graph.get(a)!.gzipBytes)
			.slice(0, count)
			.map((name) => `  ${kb(graph.get(name)!.gzipBytes)}  ${name}`)
			.join('\n')
	const base = staticClosure(graph, [entry])
	const entryKb = gzipBytes(graph, base) / 1024
	console.log(
		`Every page: ${base.size} chunks, ${entryKb.toFixed(0)} KB gzip (entry ${entry})\n${largest(base, 12)}`,
	)
	for (const part of positionals) {
		for (const name of [...sources.keys()].filter((file) =>
			file.includes(part),
		)) {
			const added = staticClosure(graph, [name]).difference(base)
			console.log(
				`\n${name}: +${added.size} chunks, +${(gzipBytes(graph, added) / 1024).toFixed(0)} KB gzip\n${largest(added, 8)}`,
			)
		}
	}
	const max = Number(values['max-entry-kb'])
	if (max && entryKb > max) {
		console.error(
			`Every-page download is ${entryKb.toFixed(0)} KB gzip, over ${max} KB.`,
		)
		process.exitCode = 1
	}
}

export async function main(argv = process.argv.slice(2)) {
	const { values, positionals, tokens } = parseArgs({
		args: argv,
		allowPositionals: true,
		strict: false,
		tokens: true,
		options: {
			origin: { type: 'string', default: 'http://localhost:3742' },
			'cookie-file': { type: 'string', default: '.tmp/control-kody-cookie' },
		},
	})
	const [command] = positionals
	const options = {
		origin: String(values.origin).replace(/\/$/, ''),
		cookieFile: String(values['cookie-file']),
	}
	// Everything after the command except the common options goes to it.
	const common = new Set(['origin', 'cookie-file'])
	const rest: Array<string> = []
	let seenCommand = false
	for (const token of tokens) {
		if (token.kind === 'positional' && !seenCommand) {
			seenCommand = true
		} else if (token.kind === 'positional') {
			rest.push(token.value)
		} else if (token.kind === 'option' && !common.has(token.name)) {
			rest.push(token.rawName)
			if (token.value !== undefined && !token.inlineValue)
				rest.push(token.value)
		}
	}
	if (command === 'ssr') return ssr(options, rest)
	if (command === 'compare') return compare(rest)
	if (command === 'nav') return nav(options, rest)
	if (command === 'bundle') return bundle(rest)
	console.log(usage)
	if (command && command !== 'help') process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) await main()
