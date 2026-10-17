#!/usr/bin/env node
import { chromium } from '@playwright/test'
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

const [configPath, outputArg] = process.argv.slice(2)
if (!configPath || !outputArg)
	throw new Error(
		'Usage: blog-cache-probe.mjs CONFIG_JSON NEW_OUTPUT_DIRECTORY',
	)
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const output = resolve(outputArg)
if (existsSync(output)) throw new Error('Output directory must be new')
mkdirSync(output, { recursive: true })
const report = {
	caveat:
		'Unthrottled localhost desktop, no hover. Tracking-query navigation is history-driven, using the same observed pushState path as the repository browser contract. No timing is assigned to unchanged-content query navigation. Timings are DOM-ready, not physical paint. Shell and blog leaf requests are counted separately from the compiled resolver map.',
	results: [],
}
const save = () =>
	writeFileSync(
		join(output, 'results.json'),
		JSON.stringify(report, null, 2) + '\n',
	)
for (let round = 0; round < (config.rounds ?? 3); round++) {
	for (const target of [
		...config.targets.slice(round % 2),
		...config.targets.slice(0, round % 2),
	]) {
		if (!['127.0.0.1', 'localhost'].includes(new URL(target.origin).hostname))
			throw new Error('Local origins only')
		const resolverDir = join(target.root, 'dist-start/server/assets')
		const resolver = readFileSync(
			join(
				resolverDir,
				readdirSync(resolverDir).find(
					(name) =>
						name.startsWith('__23tanstack-start-server-fn-resolver-') &&
						name.endsWith('.js'),
				),
			),
			'utf8',
		)
		const names = Object.fromEntries(
			[
				...resolver.matchAll(
					/"([a-f0-9]{64})":\s*\{\s*functionName: "([^"]+)"/g,
				),
			].map((match) => [match[1], match[2]]),
		)
		for (const required of [
			'loadBlog_createServerFn_handler',
			'loadShell_createServerFn_handler',
		]) {
			if (!Object.values(names).includes(required))
				throw new Error(`Resolver is missing ${required}`)
		}
		const result = {
			label: target.label,
			round: round + 1,
			steps: [],
			errors: [],
		}
		report.results.push(result)
		const browser = await chromium.launch({
			executablePath:
				'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		})
		try {
			const page = await browser.newPage({
				viewport: { width: 1350, height: 940 },
			})
			page.on('pageerror', (error) => result.errors.push(error.message))
			await page.goto(target.origin, { waitUntil: 'networkidle' })
			let step
			const pendingRpc = new Set()
			page.on('requestfinished', (request) => pendingRpc.delete(request))
			page.on('requestfailed', (request) => pendingRpc.delete(request))
			page.on('request', (request) => {
				const url = new URL(request.url())
				if (step && url.pathname.startsWith('/_serverFn/')) {
					pendingRpc.add(request)
					step.rpc.push({
						name: names[url.pathname.split('/').at(-1)] ?? 'unknown',
						method: request.method(),
					})
				}
			})
			for (const item of [
				{ name: 'first-blog', path: '/blog', heading: 'Notes from the' },
				{ name: 'leave-blog', path: '/pricing', heading: 'Start free' },
				{
					name: 'within-30s-revisit',
					path: '/blog',
					heading: 'Notes from the',
				},
				{
					name: 'tracking-query-only',
					path: '/blog?utm_source=measurement',
					heading: 'Notes from the',
				},
				{
					name: 'leave-before-expiry',
					path: '/pricing',
					heading: 'Start free',
				},
				{
					name: 'after-31s-revisit',
					path: '/blog',
					heading: 'Notes from the',
					waitMs: 31_000,
				},
			]) {
				if (item.waitMs) await page.waitForTimeout(item.waitMs)
				step = { name: item.name, path: item.path, rpc: [] }
				result.steps.push(step)
				const before = await page.evaluate(() => performance.timeOrigin)
				await page.evaluate(({ path, heading }) => {
					const target = new URL(path, location.origin)
					const anchor = [...document.querySelectorAll('a[href]')].find(
						(node) => new URL(node.href).pathname === target.pathname,
					)
					if (!anchor)
						throw new Error('Matching application anchor unavailable')
					window.__blogProbe = null
					const start = performance.now()
					if (target.search) window.history.pushState(null, '', target.href)
					else anchor.click()
					const observe = () => {
						if (
							location.pathname === target.pathname &&
							location.search === target.search &&
							document.querySelector('main h1')?.textContent?.includes(heading)
						)
							window.__blogProbe = performance.now() - start
						else requestAnimationFrame(observe)
					}
					requestAnimationFrame(observe)
				}, item)
				await page.waitForFunction(() => typeof window.__blogProbe === 'number')
				step.domReadyMs =
					item.name === 'tracking-query-only'
						? null
						: await page.evaluate(() => window.__blogProbe)
				step.navigationMethod =
					item.name === 'tracking-query-only'
						? 'history.pushState'
						: 'anchor-click'
				await page.waitForTimeout(1000)
				const deadline = Date.now() + 10000
				while (pendingRpc.size && Date.now() < deadline)
					await page.waitForTimeout(50)
				if (pendingRpc.size) throw new Error('RPC requests did not settle')
				step.fullReload =
					before !== (await page.evaluate(() => performance.timeOrigin))
				if (step.fullReload) throw new Error('Unexpected full document reload')
				if (step.rpc.some((request) => request.name === 'unknown'))
					throw new Error('Unmapped RPC observed')
				step.shellReads = step.rpc.filter(
					(request) => request.name === 'loadShell_createServerFn_handler',
				).length
				step.blogLeafReads = step.rpc.filter(
					(request) => request.name === 'loadBlog_createServerFn_handler',
				).length
				step.otherRpcReads = step.rpc.length - step.blogLeafReads
				save()
			}
		} catch (error) {
			result.failure = error.message
		} finally {
			await browser.close()
			save()
		}
	}
}
