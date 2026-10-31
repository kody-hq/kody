import { expect, test, vi } from 'vitest'
import {
	classifySitePerf,
	collectSitePerf,
	type SitePerfBudget,
} from './collect.ts'

const budget: SitePerfBudget = {
	htmlBytes: 1000,
	sameOriginJsBytes: 1000,
	lcpImageBytes: 1000,
}

const healthyHtml = `
<link rel="preload" as="image" href="/images/hero/kody-base-640.webp" />
<script type="module" src="/client-entry.js"></script>
`

test('classifySitePerf scores healthy landing signals and flags cache, LCP, Shiki, and JS budget issues', () => {
	expect(
		classifySitePerf({
			url: 'https://kody.codes/',
			html: healthyHtml,
			cacheControl: 'public, max-age=60, stale-while-revalidate=300',
			vary: 'Cookie',
			htmlBytes: 800,
			largestSameOriginJsBytes: 800,
			lcpImageBytes: 800,
			budget,
		}),
	).toMatchObject({ verdict: 'ok', findings: [] })

	const cacheAndLcp = classifySitePerf({
		url: 'https://kody.codes/',
		html: '<html></html>',
		cacheControl: 'no-store',
		vary: null,
		htmlBytes: 800,
		largestSameOriginJsBytes: 800,
		lcpImageBytes: null,
		budget,
	})
	expect(cacheAndLcp.verdict).toBe('needs-fix')
	expect(cacheAndLcp.findings.map((finding) => finding.id).sort()).toEqual([
		'home-no-store',
		'missing-lcp-preload',
	])

	const shikiAndJs = classifySitePerf({
		url: 'https://kody.codes/',
		html: `${healthyHtml}<link rel="modulepreload" href="/assets/syntax-highlight-Bk0_PSZb.js" />`,
		cacheControl: 'public, max-age=60',
		vary: 'Cookie',
		htmlBytes: 800,
		largestSameOriginJsBytes: 3000,
		lcpImageBytes: 800,
		budget,
	})
	expect(shikiAndJs.verdict).toBe('needs-fix')
	expect(shikiAndJs.findings.map((finding) => finding.id)).toEqual([
		'syntax-highlight-on-home',
		'js-over-budget',
	])

	const missingTiming = classifySitePerf({
		url: 'https://kody.codes/',
		html: healthyHtml,
		cacheControl: 'public, max-age=60, stale-while-revalidate=300',
		vary: 'Cookie',
		htmlBytes: 800,
		largestSameOriginJsBytes: 800,
		lcpImageBytes: 800,
		budget,
		serverTiming: [{ name: 'cfEdge', durationMs: 9 }],
	})
	expect(missingTiming.findings.map((finding) => finding.id)).toContain(
		'missing-app-timing',
	)
	expect(
		classifySitePerf({
			url: 'https://kody.codes/',
			html: healthyHtml,
			cacheControl: 'public, max-age=60, stale-while-revalidate=300',
			vary: 'Cookie',
			htmlBytes: 800,
			largestSameOriginJsBytes: 800,
			lcpImageBytes: 800,
			budget,
			serverTiming: [
				{ name: 'session', durationMs: 4 },
				{ name: 'ssr', durationMs: 20 },
			],
		}).verdict,
	).toBe('ok')
})

test('collectSitePerf keeps homepage classify when extra landing probes fail', async () => {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input)
		const pathname = new URL(url).pathname
		if (pathname === '/') {
			return new Response(healthyHtml, {
				headers: {
					'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
					Vary: 'Cookie',
					'Server-Timing': 'session;dur=1, ssr;dur=4',
				},
			})
		}
		if (pathname === '/docs/how-kody-works') {
			return new Response('<html></html>', {
				headers: {
					'Cache-Control': 'no-store',
					'Server-Timing': 'highlight;dur=7;desc="hit"',
				},
			})
		}
		throw new Error(`extra landing probe failed: ${url}`)
	})
	vi.stubGlobal('fetch', fetchMock)
	try {
		const report = await collectSitePerf({
			url: 'https://kody.codes/',
			budget,
			packageAppUrl: null,
		})
		expect(report.packageApp).toBeNull()
		expect(report.pages).toEqual([
			{
				url: 'https://kody.codes/docs/how-kody-works',
				htmlBytes: new TextEncoder().encode('<html></html>').byteLength,
				cacheControl: 'no-store',
				ttfbMs: expect.any(Number),
				serverTiming: [{ name: 'highlight', durationMs: 7, desc: 'hit' }],
			},
		])
		expect(report.verdict).toBe('ok')
		expect(report.findings).toEqual([])
	} finally {
		vi.unstubAllGlobals()
	}
})

test('collectSitePerf probes the hello-world package app without changing the verdict', async () => {
	let appRequests = 0
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input))
		if (url.hostname === 'kentcdodds.kody.run') {
			appRequests += 1
			return new Response('ok', {
				headers: {
					'Server-Timing': `credentialSuppliers;dur=${appRequests === 1 ? 40 : 0}, entrypoint;dur=3, total;dur=${appRequests === 1 ? 90 : 20}`,
				},
			})
		}
		if (url.pathname === '/') {
			return new Response(healthyHtml, {
				headers: {
					'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
					Vary: 'Cookie',
					'Server-Timing': 'session;dur=1, ssr;dur=4',
				},
			})
		}
		throw new Error(`unexpected probe: ${url}`)
	})
	vi.stubGlobal('fetch', fetchMock)
	try {
		const report = await collectSitePerf({
			url: 'https://kody.codes/',
			budget,
		})
		expect(report.packageApp?.url).toBe(
			'https://kentcdodds.kody.run/perf-hello/',
		)
		expect(report.packageApp?.samples).toHaveLength(3)
		expect(report.packageApp?.samples[0]).toEqual({
			status: 200,
			ttfbMs: expect.any(Number),
			serverTiming: [
				{ name: 'credentialSuppliers', durationMs: 40 },
				{ name: 'entrypoint', durationMs: 3 },
				{ name: 'total', durationMs: 90 },
			],
		})
		expect(report.packageApp?.samples[2]?.serverTiming).toContainEqual({
			name: 'total',
			durationMs: 20,
		})
		expect(report.verdict).toBe('ok')
	} finally {
		vi.unstubAllGlobals()
	}
})

test('collectSitePerf omits a package-app probe that cannot connect', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input))
			if (url.hostname === 'kentcdodds.kody.run') throw new Error('offline')
			if (url.pathname === '/') {
				return new Response(healthyHtml, {
					headers: {
						'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
						Vary: 'Cookie',
						'Server-Timing': 'session;dur=1, ssr;dur=4',
					},
				})
			}
			throw new Error(`unexpected probe: ${url}`)
		}),
	)
	try {
		const report = await collectSitePerf({ url: 'https://kody.codes/', budget })
		expect(report.packageApp).toBeNull()
		expect(report.verdict).toBe('ok')
	} finally {
		vi.unstubAllGlobals()
	}
})

test('collectSitePerf marks a partial package-app series', async () => {
	let appRequests = 0
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input))
			if (url.hostname === 'kentcdodds.kody.run') {
				appRequests += 1
				if (appRequests > 1) throw new Error('reset')
				return new Response('ok')
			}
			if (url.pathname === '/') return new Response(healthyHtml)
			throw new Error(`unexpected probe: ${url}`)
		}),
	)
	try {
		const report = await collectSitePerf({ url: 'https://kody.codes/', budget })
		expect(report.packageApp?.samples).toHaveLength(1)
		expect(report.packageApp?.error).toBe('sample 2 of 3 failed: reset')
	} finally {
		vi.unstubAllGlobals()
	}
})
