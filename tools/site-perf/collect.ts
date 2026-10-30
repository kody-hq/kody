import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isExecutedDirectly } from '../node-runtime.ts'
import {
	parseServerTimingHeader,
	type ServerTimingEntry,
} from '#worker/server-timing.ts'

export type SitePerfVerdict = 'ok' | 'needs-fix'

export type SitePerfBudget = {
	htmlBytes: number
	sameOriginJsBytes: number
	lcpImageBytes: number
}

export type SitePerfFinding = {
	id: string
	message: string
}

export type SitePerfPageProbe = {
	url: string
	htmlBytes: number
	cacheControl: string | null
	ttfbMs: number | null
	serverTiming: Array<ServerTimingEntry>
}

export type SitePerfReport = {
	url: string
	fetchedAt: string
	htmlBytes: number
	cacheControl: string | null
	vary: string | null
	largestSameOriginJsBytes: number | null
	lcpImageBytes: number | null
	ttfbMs: number | null
	serverTiming: Array<ServerTimingEntry>
	pages: Array<SitePerfPageProbe>
	findings: Array<SitePerfFinding>
	verdict: SitePerfVerdict
}

export const defaultBudgetPath = path.join(import.meta.dirname, 'budget.json')

export async function loadSitePerfBudget(
	budgetPath = defaultBudgetPath,
): Promise<SitePerfBudget> {
	return JSON.parse(await readFile(budgetPath, 'utf8')) as SitePerfBudget
}

function hrefsMatching(html: string, pattern: RegExp) {
	return [...html.matchAll(pattern)]
		.map((match) => match[1])
		.filter((href): href is string => href !== undefined && href.length > 0)
}

function resolveUrl(base: string, href: string) {
	return new URL(href, base).href
}

function isSameOrigin(base: string, href: string) {
	return new URL(href, base).origin === new URL(base).origin
}

export function classifySitePerf(input: {
	url: string
	html: string
	cacheControl: string | null
	vary: string | null
	htmlBytes: number
	largestSameOriginJsBytes: number | null
	lcpImageBytes: number | null
	budget: SitePerfBudget
	ttfbMs?: number | null
	serverTiming?: Array<ServerTimingEntry>
	pages?: Array<SitePerfPageProbe>
}): SitePerfReport {
	const findings: Array<SitePerfFinding> = []
	const { html, budget } = input

	if (!/rel=["']preload["'][^>]+as=["']image["']/.test(html)) {
		findings.push({
			id: 'missing-lcp-preload',
			message: 'Homepage HTML is missing an LCP image preload.',
		})
	} else if (!html.includes('kody-base-640.webp')) {
		findings.push({
			id: 'lcp-preload-not-responsive',
			message: 'LCP preload does not point at the 640w hero variant.',
		})
	}

	if (new URL(input.url).pathname === '/' && /syntax-highlight/.test(html)) {
		findings.push({
			id: 'syntax-highlight-on-home',
			message: 'Homepage HTML preloads a syntax-highlight chunk on /.',
		})
	}

	if (/turnstile\/v0\/api\.js/.test(html)) {
		findings.push({
			id: 'turnstile-in-ssr',
			message: 'Turnstile script is present in the first HTML document.',
		})
	}

	if (
		input.cacheControl === 'no-store' &&
		new URL(input.url).pathname === '/'
	) {
		findings.push({
			id: 'home-no-store',
			message: 'Anonymous homepage HTML is Cache-Control: no-store.',
		})
	}

	if (input.htmlBytes > budget.htmlBytes) {
		findings.push({
			id: 'html-over-budget',
			message: `HTML is ${input.htmlBytes} bytes (budget ${budget.htmlBytes}).`,
		})
	}

	if (
		input.largestSameOriginJsBytes !== null &&
		input.largestSameOriginJsBytes > budget.sameOriginJsBytes
	) {
		findings.push({
			id: 'js-over-budget',
			message: `Largest same-origin JS is ${input.largestSameOriginJsBytes} bytes (budget ${budget.sameOriginJsBytes}).`,
		})
	}

	if (
		input.lcpImageBytes !== null &&
		input.lcpImageBytes > budget.lcpImageBytes
	) {
		findings.push({
			id: 'lcp-image-over-budget',
			message: `LCP image is ${input.lcpImageBytes} bytes (budget ${budget.lcpImageBytes}).`,
		})
	}

	if (
		new URL(input.url).pathname === '/' &&
		input.serverTiming &&
		!input.serverTiming.some((entry) => entry.name === 'ssr')
	) {
		findings.push({
			id: 'missing-app-timing',
			message:
				'Homepage Server-Timing is missing the app ssr phase (session/ssr).',
		})
	}

	return {
		url: input.url,
		fetchedAt: new Date(0).toISOString(),
		htmlBytes: input.htmlBytes,
		cacheControl: input.cacheControl,
		vary: input.vary,
		largestSameOriginJsBytes: input.largestSameOriginJsBytes,
		lcpImageBytes: input.lcpImageBytes,
		ttfbMs: input.ttfbMs ?? null,
		serverTiming: input.serverTiming ?? [],
		pages: input.pages ?? [],
		findings,
		verdict: findings.length > 0 ? 'needs-fix' : 'ok',
	}
}

async function byteLengthOf(url: string): Promise<number | null> {
	try {
		const head = await fetch(url, { method: 'HEAD' })
		const length = head.headers.get('Content-Length')
		if (length && Number.isFinite(Number(length))) return Number(length)
		if (!head.ok) return null
		const body = await fetch(url)
		if (!body.ok) return null
		return (await body.arrayBuffer()).byteLength
	} catch {
		return null
	}
}

const extraLandingPaths = ['/onboarding', '/docs/how-kody-works'] as const

async function probePage(url: string): Promise<SitePerfPageProbe | null> {
	try {
		const startedAt = performance.now()
		const response = await fetch(url, {
			headers: { Accept: 'text/html' },
			redirect: 'follow',
		})
		const ttfbMs = Math.round(performance.now() - startedAt)
		const html = await response.text()
		return {
			url: response.url || url,
			htmlBytes: new TextEncoder().encode(html).byteLength,
			cacheControl: response.headers.get('Cache-Control'),
			ttfbMs,
			serverTiming: parseServerTimingHeader(
				response.headers.get('Server-Timing'),
			),
		}
	} catch {
		return null
	}
}

export async function collectSitePerf(input: {
	url: string
	budget?: SitePerfBudget
	now?: Date
}): Promise<SitePerfReport> {
	const budget = input.budget ?? (await loadSitePerfBudget())
	const startedAt = performance.now()
	const response = await fetch(input.url, {
		headers: { Accept: 'text/html' },
		redirect: 'follow',
	})
	const ttfbMs = Math.round(performance.now() - startedAt)
	const html = await response.text()
	const htmlBytes = new TextEncoder().encode(html).byteLength
	const serverTiming = parseServerTimingHeader(
		response.headers.get('Server-Timing'),
	)
	const resolvedUrl = response.url || input.url
	const extraPages =
		new URL(resolvedUrl).pathname === '/'
			? (
					await Promise.all(
						extraLandingPaths.map((pathname) =>
							probePage(new URL(pathname, resolvedUrl).href),
						),
					)
				).filter((page): page is SitePerfPageProbe => page !== null)
			: []
	const scriptHrefs = hrefsMatching(html, /<script[^>]+src=["']([^"']+)["']/gi)
	const preloadHrefs = hrefsMatching(
		html,
		/<link[^>]+rel=["'](?:modulepreload|preload)["'][^>]+href=["']([^"']+)["']/gi,
	)
	const sameOriginJs = [...scriptHrefs, ...preloadHrefs]
		.filter((href) => href.endsWith('.js'))
		.filter((href) => isSameOrigin(input.url, href))
		.map((href) => resolveUrl(input.url, href))

	const jsSizes = await Promise.all(sameOriginJs.map(byteLengthOf))
	const largestSameOriginJsBytes = jsSizes.reduce<number | null>(
		(max, size) => {
			if (size === null) return max
			if (max === null || size > max) return size
			return max
		},
		null,
	)

	const lcpHref =
		hrefsMatching(
			html,
			/<link[^>]+rel=["']preload["'][^>]+href=["']([^"']+\.webp)["']/gi,
		)[0] ?? null
	const lcpImageBytes = lcpHref
		? await byteLengthOf(resolveUrl(input.url, lcpHref))
		: null

	const report = classifySitePerf({
		url: resolvedUrl,
		html,
		cacheControl: response.headers.get('Cache-Control'),
		vary: response.headers.get('Vary'),
		htmlBytes,
		largestSameOriginJsBytes,
		lcpImageBytes,
		budget,
		ttfbMs,
		serverTiming,
		pages: extraPages,
	})
	report.fetchedAt = (input.now ?? new Date()).toISOString()
	return report
}

function parseArgs(argv: Array<string>) {
	let url = 'https://kody.codes/'
	let json = false
	let exitZero = false
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (arg === '--json') json = true
		else if (arg === '--exit-zero') exitZero = true
		else if (arg === '--url') {
			const value = argv[index + 1]
			if (!value) throw new Error('--url requires a value')
			url = value
			index += 1
		}
	}
	return { url, json, exitZero }
}

export async function main(argv = process.argv.slice(2)) {
	const { url, json, exitZero } = parseArgs(argv)
	const report = await collectSitePerf({ url })
	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
	} else {
		process.stdout.write(
			`${report.verdict} ${report.url} html=${report.htmlBytes} js=${report.largestSameOriginJsBytes ?? 'n/a'} lcp=${report.lcpImageBytes ?? 'n/a'} ttfb=${report.ttfbMs ?? 'n/a'}\n`,
		)
		for (const finding of report.findings) {
			process.stdout.write(`- ${finding.message}\n`)
		}
	}
	if (exitZero) return
	if (report.verdict === 'needs-fix') process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) {
	void main()
}
