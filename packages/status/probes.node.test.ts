import { expect, test } from 'vitest'
import {
	fetchExecuteEvidenceLastSuccessAt,
	jobsProbeOrigin,
	runAllProbes,
} from './probes.ts'
import { statusComponentIds } from './status-types.ts'

type FakeRoute = {
	status?: number
	headers?: Record<string, string>
	body?: unknown
	error?: string
}

function fakeFetcher(routes: Record<string, FakeRoute>): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input.toString()
		const route = routes[url]
		if (!route) throw new Error(`Unexpected probe URL: ${url}`)
		if (route.error) throw new Error(route.error)
		return new Response(
			route.body === undefined ? null : JSON.stringify(route.body),
			{ status: route.status ?? 200, headers: route.headers ?? {} },
		)
	}) as typeof fetch
}

const primaryOrigin = 'https://kody.codes'
const packageAppOrigin = 'https://kody.run'
const runtimeHealth = `${packageAppOrigin}/__runtime/health`
const jobsHealth = `${jobsProbeOrigin}/health`
const jobsComponents = `${jobsProbeOrigin}/health/components`

function healthyRoutes(): Record<string, FakeRoute> {
	return {
		[`${primaryOrigin}/health`]: {
			body: { ok: true, commitSha: 'abc123def4567890abcdef1234567890abcdef12' },
		},
		[`${primaryOrigin}/mcp`]: {
			status: 401,
			headers: { 'WWW-Authenticate': 'Bearer resource_metadata="..."' },
		},
		[runtimeHealth]: {
			body: {
				status: 'ok',
				commitSha: 'def4567890abcdef1234567890abcdef12345678',
				cookieSecretConfigured: true,
			},
		},
		[jobsHealth]: {
			body: { ok: true, commit: '7890abcdef1234567890abcdef1234567890abcd' },
		},
		[jobsComponents]: {
			body: {
				ok: true,
				commit: '7890abcdef1234567890abcdef1234567890abcd',
				components: [{ id: 'jobs_db', ok: true, latencyMs: 3 }],
			},
		},
		[`${primaryOrigin}/health/components`]: {
			body: {
				ok: true,
				components: [
					{ id: 'app_db', ok: true, latencyMs: 4 },
					{ id: 'audit_db', ok: true, latencyMs: 6 },
					{ id: 'kv', ok: true, latencyMs: 2 },
					{ id: 'assets', ok: true, latencyMs: 9 },
				],
				executeEvidence: {
					lastSuccessAt: '2026-09-07T17:00:00.000Z',
				},
			},
		},
	}
}

async function probe(routes: Record<string, FakeRoute>) {
	return runAllProbes({
		primaryOrigin,
		packageAppOrigin,
		fetcher: fakeFetcher(routes),
	})
}

function outcome(
	result: Awaited<ReturnType<typeof runAllProbes>>,
	component: string,
) {
	return result.outcomes.find((entry) => entry.component === component)
}

test('a fully healthy pass reports every component ok', async () => {
	const result = await probe(healthyRoutes())
	expect(result.outcomes.map((entry) => entry.component).toSorted()).toEqual(
		[...statusComponentIds].toSorted(),
	)
	expect(result.outcomes.filter((entry) => !entry.ok)).toEqual([])
	expect(outcome(result, 'app_db')?.latencyMs).toBe(4)
	expect(result.productionCommitSha).toBe(
		'abc123def4567890abcdef1234567890abcdef12',
	)
	expect(result.runtimeCommitSha).toBe(
		'def4567890abcdef1234567890abcdef12345678',
	)
	expect(result.jobsCommitSha).toBe('7890abcdef1234567890abcdef1234567890abcd')
	expect(result.executeLastSuccessAt).toBe(
		Date.parse('2026-09-07T17:00:00.000Z'),
	)
})

const redirect: FakeRoute = {
	status: 302,
	headers: { Location: 'https://kody.codes/' },
}

test('apex 302 is not probed as package-runtime up', async () => {
	const requested: Array<string> = []
	const apexFetcher = fakeFetcher({
		...healthyRoutes(),
		[`${packageAppOrigin}/`]: redirect,
	})
	const apexResult = await runAllProbes({
		primaryOrigin,
		packageAppOrigin,
		fetcher: (async (input, init) => {
			requested.push(typeof input === 'string' ? input : input.toString())
			return apexFetcher(input, init)
		}) as typeof fetch,
	})
	expect(requested).not.toContain(`${packageAppOrigin}/`)
	expect(requested).toContain(runtimeHealth)
	expect(outcome(apexResult, 'package_apps')?.ok).toBe(true)
})

test('probe failures isolate to the affected component and map error details', async () => {
	const jobsUnreachable = { error: 'jobs worker unreachable' }
	const originUnreachable = { error: 'connection refused' }
	// [route overrides, failing component -> detail, still-ok components, result fields]
	const cases: Array<
		[
			Record<string, FakeRoute>,
			Record<string, string>,
			Array<string>,
			Record<string, unknown>?,
		]
	> = [
		[
			{ [runtimeHealth]: redirect },
			{ package_apps: 'HTTP 302' },
			['app'],
			{ runtimeCommitSha: null },
		],
		[
			{ [runtimeHealth]: { status: 200, body: { ok: true } } },
			{ package_apps: 'HTTP 200' },
			[],
		],
		[{ [runtimeHealth]: { status: 521 } }, { package_apps: 'HTTP 521' }, []],
		[{ [runtimeHealth]: { status: 404 } }, { package_apps: 'HTTP 404' }, []],
		// Jobs probe failure is not app-down.
		[
			{ [jobsHealth]: jobsUnreachable, [jobsComponents]: jobsUnreachable },
			{ jobs: 'jobs worker unreachable' },
			['app', 'mcp', 'package_apps'],
		],
		[
			{
				[jobsComponents]: {
					status: 503,
					body: {
						ok: false,
						components: [{ id: 'jobs_db', ok: false, error: 'timeout' }],
					},
				},
			},
			{ jobs: 'timeout' },
			['app'],
			{ jobsCommitSha: '7890abcdef1234567890abcdef1234567890abcd' },
		],
		[
			{ [`${primaryOrigin}/mcp`]: { status: 500 } },
			{ mcp: 'HTTP 500' },
			['app'],
		],
		[
			{
				[`${primaryOrigin}/mcp`]: {
					status: 401,
					headers: { 'WWW-Authenticate': 'Basic realm="nope"' },
				},
			},
			{ mcp: 'HTTP 401' },
			[],
		],
		[
			{
				[`${primaryOrigin}/health/components`]: {
					status: 503,
					body: {
						ok: false,
						components: [
							{ id: 'app_db', ok: false, error: 'timeout' },
							{ id: 'audit_db', ok: true, latencyMs: 6 },
							{ id: 'kv', ok: true, latencyMs: 2 },
							{ id: 'assets', ok: true, latencyMs: 9 },
						],
						executeEvidence: { lastSuccessAt: '2026-09-10T22:23:29.243Z' },
					},
				},
			},
			{ app_db: 'timeout' },
			['kv', 'assets'],
			{ executeLastSuccessAt: Date.parse('2026-09-10T22:23:29.243Z') },
		],
		[
			{
				[`${primaryOrigin}/health`]: originUnreachable,
				[`${primaryOrigin}/health/components`]: originUnreachable,
			},
			{ app: 'connection refused' },
			['jobs'],
		],
	]
	for (const [overrides, failing, stillOk, fields = {}] of cases) {
		const result = await probe({ ...healthyRoutes(), ...overrides })
		for (const [component, detail] of Object.entries(failing)) {
			expect(outcome(result, component)).toMatchObject({ ok: false, detail })
		}
		expect(
			stillOk.filter((component) => !outcome(result, component)?.ok),
		).toEqual([])
		expect(result).toMatchObject(fields)
		for (const component of Object.keys(failing)) {
			expect(outcome(result, component)?.skip).toBeUndefined()
		}
	}
})

test('origin-level /health/components failures skip storage cards instead of opening them', async () => {
	const originUnreachable = { error: 'connection refused' }
	const cases: Array<{
		overrides: Record<string, FakeRoute>
		appDetail: string
		storageDetail: string
	}> = [
		{
			overrides: {
				[`${primaryOrigin}/health`]: { status: 503 },
				[`${primaryOrigin}/health/components`]: { status: 503 },
			},
			appDetail: 'HTTP 503',
			storageDetail: 'HTTP 503',
		},
		{
			overrides: {
				[`${primaryOrigin}/health`]: originUnreachable,
				[`${primaryOrigin}/health/components`]: originUnreachable,
			},
			appDetail: 'connection refused',
			storageDetail: 'unreachable',
		},
	]
	for (const { overrides, appDetail, storageDetail } of cases) {
		const result = await probe({ ...healthyRoutes(), ...overrides })
		expect(outcome(result, 'app')).toMatchObject({
			ok: false,
			detail: appDetail,
		})
		for (const component of ['app_db', 'kv', 'assets'] as const) {
			expect(outcome(result, component)).toMatchObject({
				ok: false,
				latencyMs: null,
				detail: storageDetail,
				skip: true,
			})
		}
		expect(outcome(result, 'jobs')?.ok).toBe(true)
		expect(outcome(result, 'package_apps')?.ok).toBe(true)
	}
})

test('public execute-evidence refresh reads lastSuccessAt without following a failed storage card', async () => {
	const requested: Array<{ url: string; cacheControl: string | null }> = []
	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString()
		const headers = new Headers(init?.headers)
		requested.push({
			url,
			cacheControl: headers.get('Cache-Control'),
		})
		return new Response(
			JSON.stringify({
				ok: false,
				components: [{ id: 'app_db', ok: false, error: 'timeout' }],
				executeEvidence: {
					lastSuccessAt: '2026-09-10T22:23:29.243Z',
				},
			}),
			{ status: 503 },
		)
	}) as typeof fetch

	await expect(
		fetchExecuteEvidenceLastSuccessAt({
			primaryOrigin,
			fetcher,
		}),
	).resolves.toBe(Date.parse('2026-09-10T22:23:29.243Z'))
	expect(requested).toEqual([
		{
			url: `${primaryOrigin}/health/components`,
			cacheControl: 'no-cache',
		},
	])

	const failingFetcher = (async () => {
		throw new Error('origin down')
	}) as typeof fetch
	await expect(
		fetchExecuteEvidenceLastSuccessAt({
			primaryOrigin,
			fetcher: failingFetcher,
		}),
	).resolves.toBeNull()
})
