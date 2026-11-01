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
			packageAppId: null,
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

const landingResponse = () =>
	new Response(healthyHtml, {
		headers: {
			'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
			Vary: 'Cookie',
			'Server-Timing': 'session;dur=1, ssr;dur=4',
		},
	})

test('collectSitePerf probes the hello-world package app via packageAppFetch without changing the verdict', async () => {
	let appRequests = 0
	const appRequestInits: Array<RequestInit | undefined> = []
	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input))
			if (url.hostname === 'api.kody.codes') {
				appRequests += 1
				appRequestInits.push(init)
				return Response.json({
					status: 200,
					headers: {
						'server-timing': `credentialSuppliers;dur=${appRequests === 1 ? 40 : 0}, entrypoint;dur=3`,
					},
					body: 'ok',
					truncated: false,
				})
			}
			if (url.pathname === '/') return landingResponse()
			throw new Error(`unexpected probe: ${url}`)
		},
	)
	vi.stubGlobal('fetch', fetchMock)
	try {
		const report = await collectSitePerf({
			url: 'https://kody.codes/',
			budget,
			apiToken: 'kody_at_test',
		})
		expect(report.packageApp?.url).toBe(
			'https://api.kody.codes/v1/packages/app-fetch',
		)
		expect(report.packageApp?.packageId).toBe(
			'87aebd1f-9589-4c5a-b34e-40f191413564',
		)
		expect(report.packageApp?.samples).toHaveLength(3)
		expect(report.packageApp?.samples[0]).toEqual({
			status: 200,
			ttfbMs: expect.any(Number),
			serverTiming: [
				{ name: 'credentialSuppliers', durationMs: 40 },
				{ name: 'entrypoint', durationMs: 3 },
			],
		})
		expect(appRequestInits[0]).toMatchObject({
			method: 'POST',
			headers: { Authorization: 'Bearer kody_at_test' },
			body: JSON.stringify({
				package_id: '87aebd1f-9589-4c5a-b34e-40f191413564',
				path: '/',
			}),
		})
		expect(report.verdict).toBe('ok')
	} finally {
		vi.unstubAllGlobals()
	}
})

test('collectSitePerf skips the package-app probe without an API token', async () => {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input))
		if (url.pathname === '/') return landingResponse()
		throw new Error(`unexpected probe: ${url}`)
	})
	vi.stubGlobal('fetch', fetchMock)
	try {
		const report = await collectSitePerf({
			url: 'https://kody.codes/',
			budget,
		})
		expect(report.packageApp).toBeNull()
		expect(
			fetchMock.mock.calls.some(([input]) =>
				String(input).includes('api.kody.codes'),
			),
		).toBe(false)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('collectSitePerf reports a rejected token or partial package-app series', async () => {
	let appRequests = 0
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input))
			if (url.hostname === 'api.kody.codes') {
				appRequests += 1
				if (appRequests > 1) {
					return new Response('{"error":"invalid token"}', { status: 401 })
				}
				return Response.json({ status: 200, headers: {}, body: 'ok' })
			}
			if (url.pathname === '/') return new Response(healthyHtml)
			throw new Error(`unexpected probe: ${url}`)
		}),
	)
	try {
		const report = await collectSitePerf({
			url: 'https://kody.codes/',
			budget,
			apiToken: 'kody_at_test',
		})
		expect(report.packageApp?.samples).toHaveLength(1)
		expect(report.packageApp?.error).toBe(
			'sample 2 of 3 failed: packageAppFetch HTTP 401: {"error":"invalid token"}',
		)
	} finally {
		vi.unstubAllGlobals()
	}
})
