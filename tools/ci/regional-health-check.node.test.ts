import { expect, test } from 'vitest'
import {
	classifyProbe,
	evaluateMeasurement,
	globalpingApi,
	runRegionalHealthCheck,
} from './regional-health-check.ts'

const sha = '15aef800d763098eb7b7e68ce83cdf9e4d48572d'
const oldSha = 'a9ca24217b33ba870f2179a69d6130822acfe84c'

function healthy(city: string, colo: string, commitSha = sha) {
	return {
		probe: { city, country: 'XX' },
		result: {
			status: 'finished',
			statusCode: 200,
			rawHeaders: `Content-Type: application/json\nCF-RAY: a5d5abc-${colo}`,
			rawBody: JSON.stringify({ ok: true, commitSha }),
		},
	}
}

function error1105(city: string, colo: string) {
	return {
		probe: { city, country: 'XX' },
		result: {
			status: 'finished',
			statusCode: 503,
			headers: { 'cf-ray': `a5d5135e2d7e98a1-${colo}` },
			rawHeaders: `Server: cloudflare\nCF-RAY: a5d5135e2d7e98a1-${colo}`,
			rawBody: 'error code: 1105',
		},
	}
}

const europeDown = [
	error1105('Paris', 'CDG'),
	error1105('London', 'LHR'),
	error1105('Amsterdam', 'AMS'),
	healthy('Frankfurt', 'FRA'),
	healthy('Chicago', 'ORD'),
	healthy('Ashburn', 'IAD'),
]

test('classifies Cloudflare 1105 pages, stale commits, and failed probes', () => {
	expect(classifyProbe(error1105('Paris', 'CDG'), sha)).toMatchObject({
		kind: 'outage',
		colo: 'CDG',
		cfRay: 'a5d5135e2d7e98a1-CDG',
		status: 503,
		bodySnippet: 'error code: 1105',
	})
	expect(classifyProbe(healthy('Chicago', 'ORD', oldSha), sha)).toMatchObject({
		kind: 'stale',
		commitSha: oldSha,
	})
	expect(classifyProbe(healthy('Chicago', 'ORD'), sha).kind).toBe('ok')
	expect(
		classifyProbe(
			{ probe: { city: 'Paris' }, result: { status: 'failed' } },
			sha,
		).kind,
	).toBe('probe-failed')
})

test('two or more outage probes or any stale commit fail; one outage passes', () => {
	expect(evaluateMeasurement(europeDown, sha)).toMatchObject({
		kind: 'fail',
		reasons: ['3 probes got a Cloudflare 503 or error code 1105'],
	})
	expect(
		evaluateMeasurement(
			[error1105('Paris', 'CDG'), healthy('London', 'LHR')],
			sha,
		).kind,
	).toBe('pass')
	expect(
		evaluateMeasurement([healthy('London', 'LHR', oldSha)], sha).kind,
	).toBe('fail')
	expect(
		evaluateMeasurement([{ result: { status: 'offline' } }], sha).kind,
	).toBe('inconclusive')
})

function fakeGlobalping(measurements: Array<Array<unknown> | 'rate-limited'>) {
	const calls: Array<string> = []
	let index = -1
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input.toString()
		calls.push(`${init?.method ?? 'GET'} ${url}`)
		if (url === globalpingApi) {
			index++
			if (measurements[index] === 'rate-limited') {
				return new Response('{}', { status: 429 })
			}
			return Response.json({ id: `m${index}` }, { status: 202 })
		}
		return Response.json({
			status: 'finished',
			results: measurements[index],
		})
	}) as typeof fetch
	return { calls, fetchImpl }
}

function clock() {
	let current = 0
	return {
		now: () => current,
		sleep: async (ms: number) => {
			current += ms
		},
	}
}

test('retries through propagation and passes once every region serves the deploy', async () => {
	const { calls, fetchImpl } = fakeGlobalping([
		europeDown,
		[healthy('Paris', 'CDG'), healthy('Chicago', 'ORD')],
	])
	const outcome = await runRegionalHealthCheck({
		url: 'https://kody.codes/health',
		expectedCommitSha: sha,
		windowMs: 150_000,
		fetchImpl,
		...clock(),
	})
	expect(outcome.exitCode).toBe(0)
	expect(calls.filter((call) => call.startsWith('POST'))).toHaveLength(2)
})

test('a persistent regional outage fails loudly with colo, CF-RAY, status, and body', async () => {
	const { fetchImpl } = fakeGlobalping(
		Array.from({ length: 20 }, () => europeDown),
	)
	const outcome = await runRegionalHealthCheck({
		url: 'https://kody.codes/health',
		expectedCommitSha: sha,
		windowMs: 150_000,
		fetchImpl,
		...clock(),
	})
	expect(outcome.exitCode).toBe(1)
	const errors = outcome.lines.filter((line) => line.startsWith('::error'))
	expect(errors[0]).toContain(
		'3 probes got a Cloudflare 503 or error code 1105',
	)
	expect(errors).toContainEqual(
		expect.stringContaining(
			'colo=CDG cf-ray=a5d5135e2d7e98a1-CDG status=503 kind=outage body="error code: 1105"',
		),
	)
	expect(errors.at(-1)).toContain('Re-run this deploy job')
})

test('an unavailable or rate-limited Globalping API warns without failing', async () => {
	const { fetchImpl } = fakeGlobalping(
		Array.from({ length: 20 }, () => 'rate-limited' as const),
	)
	const outcome = await runRegionalHealthCheck({
		url: 'https://kody.codes/health',
		expectedCommitSha: sha,
		windowMs: 150_000,
		fetchImpl,
		...clock(),
	})
	expect(outcome.exitCode).toBe(0)
	expect(outcome.lines.at(-1)).toMatch(
		/^::warning title=Regional health check skipped::.*HTTP 429/,
	)

	const offline = await runRegionalHealthCheck({
		url: 'https://kody.codes/health',
		expectedCommitSha: sha,
		windowMs: 60_000,
		fetchImpl: (async () => {
			throw new TypeError('fetch failed')
		}) as typeof fetch,
		...clock(),
	})
	expect(offline.exitCode).toBe(0)
})
