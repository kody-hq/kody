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
		})
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
