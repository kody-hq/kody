import { expect, test } from 'vitest'
import {
	isRetryableFirstSweepReindexFailure,
	parseReindexArgs,
	runCapabilityReindex,
} from './reindex-capabilities.ts'

function fakeMaintenanceEndpoint(
	responses: Array<{ status?: number; body: unknown }>,
) {
	const calls: Array<{ url: string; auth: string | null; body: unknown }> = []
	const fetcher: typeof fetch = async (input, init) => {
		const headers = new Headers(init?.headers)
		calls.push({
			url: String(input),
			auth: headers.get('Authorization'),
			body: JSON.parse(String(init?.body)),
		})
		const next = responses.shift()
		if (!next) throw new Error('unexpected extra sweep')
		return Response.json(next.body, { status: next.status ?? 200 })
	}
	return { calls, fetcher }
}

test('runCapabilityReindex threads each cursor into the next sweep until complete', async () => {
	const cursor = { phase: 'capabilities', afterId: 'cap-50' }
	const endpoint = fakeMaintenanceEndpoint([
		{ body: { complete: false, cursor } },
		{ body: { complete: true } },
	])
	const result = await runCapabilityReindex({
		baseUrl: 'https://kody-pr-3.example.workers.dev/',
		secret: 'reindex-secret',
		phases: ['capabilities'],
		force: true,
		fetcher: endpoint.fetcher,
		log: () => {},
	})
	expect(result).toEqual({ sweeps: 2 })
	expect(endpoint.calls).toEqual([
		{
			url: 'https://kody-pr-3.example.workers.dev/__maintenance/reindex-capabilities',
			auth: 'Bearer reindex-secret',
			body: { phases: ['capabilities'], force: true },
		},
		{
			url: 'https://kody-pr-3.example.workers.dev/__maintenance/reindex-capabilities',
			auth: 'Bearer reindex-secret',
			body: { phases: ['capabilities'], force: true, cursor },
		},
	])
})

test('runCapabilityReindex fails loudly on HTTP errors, missing cursors, and sweep exhaustion', async () => {
	const base = {
		baseUrl: 'https://kody-pr-3.example.workers.dev',
		secret: 's',
		log: () => {},
	}
	await expect(
		runCapabilityReindex({
			...base,
			fetcher: fakeMaintenanceEndpoint([
				{ status: 401, body: { error: 'Unauthorized' } },
			]).fetcher,
		}),
	).rejects.toThrow('Capability reindex failed with HTTP 401.')
	await expect(
		runCapabilityReindex({
			...base,
			fetcher: fakeMaintenanceEndpoint([{ body: { complete: false } }]).fetcher,
		}),
	).rejects.toThrow('incomplete but returned no cursor')
	const endless = { complete: false, cursor: { phase: 'jobs', afterId: null } }
	await expect(
		runCapabilityReindex({
			...base,
			maxSweeps: 2,
			fetcher: fakeMaintenanceEndpoint([{ body: endless }, { body: endless }])
				.fetcher,
		}),
	).rejects.toThrow('did not finish after 2 sweeps')
})

test('runCapabilityReindex refuses to send the secret over plain http to a remote host', async () => {
	const endpoint = fakeMaintenanceEndpoint([{ body: { complete: true } }])
	await expect(
		runCapabilityReindex({
			baseUrl: 'http://kody-pr-3.example.workers.dev',
			secret: 's',
			fetcher: endpoint.fetcher,
			log: () => {},
		}),
	).rejects.toThrow('Refusing to send the reindex secret')
	expect(endpoint.calls).toEqual([])
	await expect(
		runCapabilityReindex({
			baseUrl: 'http://localhost:3742',
			secret: 's',
			fetcher: endpoint.fetcher,
			log: () => {},
		}),
	).resolves.toEqual({ sweeps: 1 })
})

test('runCapabilityReindex retries a first-sweep 401/503 only inside the auth retry window', async () => {
	let clock = 0
	const timing = {
		now: () => clock,
		sleep: async (ms: number) => {
			clock += ms
		},
	}
	const base = {
		baseUrl: 'https://kody-branch-x.example.workers.dev',
		secret: 's',
		log: () => {},
		...timing,
	}
	const propagating = fakeMaintenanceEndpoint([
		{ status: 503, body: { error: 'Capability reindex is not configured' } },
		{ status: 401, body: { error: 'Unauthorized' } },
		{ body: { complete: true } },
	])
	await expect(
		runCapabilityReindex({
			...base,
			authRetrySeconds: 60,
			fetcher: propagating.fetcher,
		}),
	).resolves.toEqual({ sweeps: 1 })
	expect(propagating.calls).toHaveLength(3)
	expect(clock).toBe(10_000)

	clock = 0
	const neverConfigured = fakeMaintenanceEndpoint(
		Array.from({ length: 5 }, () => ({
			status: 503,
			body: { error: 'Capability reindex is not configured' },
		})),
	)
	await expect(
		runCapabilityReindex({
			...base,
			authRetrySeconds: 12,
			fetcher: neverConfigured.fetcher,
		}),
	).rejects.toThrow('Capability reindex failed with HTTP 503.')
	expect(neverConfigured.calls).toHaveLength(3)

	const noWindow = fakeMaintenanceEndpoint([
		{ status: 401, body: { error: 'Unauthorized' } },
	])
	await expect(
		runCapabilityReindex({ ...base, fetcher: noWindow.fetcher }),
	).rejects.toThrow('Capability reindex failed with HTTP 401.')
	expect(noWindow.calls).toHaveLength(1)
})

test('runCapabilityReindex retries a first-sweep workers.dev 1042 until the script appears', async () => {
	let clock = 0
	const timing = {
		now: () => clock,
		sleep: async (ms: number) => {
			clock += ms
		},
	}
	const base = {
		baseUrl: 'https://kody-pr-4287.example.workers.dev',
		secret: 's',
		log: () => {},
		...timing,
	}
	const binding = fakeMaintenanceEndpoint([
		{
			status: 530,
			body: {
				error: 'workers_dev_script_not_found',
				code: 1042,
				retryable: false,
			},
		},
		{ body: { complete: true } },
	])
	await expect(
		runCapabilityReindex({
			...base,
			authRetrySeconds: 90,
			fetcher: binding.fetcher,
		}),
	).resolves.toEqual({ sweeps: 1 })
	expect(binding.calls).toHaveLength(2)
	expect(clock).toBe(5_000)

	clock = 0
	const stillMissing = fakeMaintenanceEndpoint([
		{
			status: 404,
			body: { error: 'Cloudflare Error 1042 workers_dev_script_not_found' },
		},
	])
	await expect(
		runCapabilityReindex({ ...base, fetcher: stillMissing.fetcher }),
	).rejects.toThrow('Capability reindex failed with HTTP 404.')
	expect(stillMissing.calls).toHaveLength(1)
})

test('isRetryableFirstSweepReindexFailure covers secret and workers.dev races', () => {
	expect(isRetryableFirstSweepReindexFailure(401, 'Unauthorized')).toBe(true)
	expect(isRetryableFirstSweepReindexFailure(503, 'not configured')).toBe(true)
	expect(isRetryableFirstSweepReindexFailure(502, 'Bad Gateway')).toBe(true)
	expect(isRetryableFirstSweepReindexFailure(530, 'origin error')).toBe(true)
	expect(
		isRetryableFirstSweepReindexFailure(
			404,
			'Cloudflare Error 1042 workers_dev_script_not_found',
		),
	).toBe(true)
	expect(isRetryableFirstSweepReindexFailure(404, 'not found')).toBe(false)
	expect(isRetryableFirstSweepReindexFailure(500, 'internal')).toBe(false)
})

test('parseReindexArgs accepts known phases and omits phases for a full sweep', () => {
	expect(
		parseReindexArgs([
			'--url',
			'https://x.example',
			'--phases',
			'capabilities,packages',
			'--force',
			'--max-sweeps',
			'3',
			'--auth-retry-seconds',
			'90',
		]),
	).toEqual({
		baseUrl: 'https://x.example',
		phases: ['capabilities', 'packages'],
		force: true,
		maxSweeps: 3,
		authRetrySeconds: 90,
	})
	expect(parseReindexArgs(['--url', 'https://x.example'])).toEqual({
		baseUrl: 'https://x.example',
		phases: undefined,
		force: false,
		maxSweeps: undefined,
		authRetrySeconds: undefined,
	})
})
