import { consoleError } from '#worker/test-support/console-spies.ts'
import { expect, test } from 'vitest'
import {
	deleteVectorizeIndex,
	ensureVectorizeIndex,
} from './vectorize-resources.ts'

type FakeIndex = { config: unknown; metadataIndexes: Array<string> }

function fakeVectorizeApi(
	options: {
		ignoreDeletes?: boolean
		lookupStatus?: number
		staleReadsAfterRecreate?: number
		/** GET index succeeds; metadata_index/list still 410 for N calls. */
		metadataStaleAfterCreate?: number
		/** 1-based metadata_index/list calls that answer 410 (readiness flap). */
		metadataList410OnCalls?: Array<number>
		/** metadata_index/list omits these properties even when they exist. */
		omitFromMetadataList?: Array<string>
		/** metadata_index/create answers 400 already-exists for these properties. */
		createAlreadyExists?: Array<string>
	} = {},
) {
	const indexes = new Map<string, FakeIndex>()
	const deleted = new Set<string>()
	const staleReads = new Map<string, number>()
	const metadataStaleReads = new Map<string, number>()
	let metadataListCalls = 0
	const requests: Array<string> = []
	const ok = (result: unknown) => Response.json({ success: true, result })
	const fetcher: typeof fetch = async (input, init) => {
		const url = new URL(String(input))
		const method = init?.method ?? 'GET'
		const path = url.pathname.replace(/^.*\/vectorize\/v2\/indexes/, '')
		requests.push(`${method} ${path || '/'}`)
		const body = init?.body ? JSON.parse(String(init.body)) : undefined
		if (path === '' && method === 'POST') {
			indexes.set(body.name, { config: body.config, metadataIndexes: [] })
			if (deleted.has(body.name)) {
				staleReads.set(body.name, options.staleReadsAfterRecreate ?? 0)
			}
			if ((options.metadataStaleAfterCreate ?? 0) > 0) {
				metadataStaleReads.set(body.name, options.metadataStaleAfterCreate!)
			}
			return ok({ name: body.name })
		}
		const match = /^\/([^/]+)(\/.*)?$/.exec(path)
		const name = decodeURIComponent(match?.[1] ?? '')
		const stale = staleReads.get(name) ?? 0
		if (stale > 0) {
			staleReads.set(name, stale - 1)
			return Response.json(
				{ success: false, errors: [{ code: 3001, message: 'index deleted' }] },
				{ status: 410 },
			)
		}
		const metadataStale = metadataStaleReads.get(name) ?? 0
		if (metadataStale > 0 && match?.[2] === '/metadata_index/list') {
			metadataStaleReads.set(name, metadataStale - 1)
			return Response.json(
				{ success: false, errors: [{ code: 3001, message: 'index deleted' }] },
				{ status: 410 },
			)
		}
		if (match?.[2] === '/metadata_index/list') {
			metadataListCalls += 1
			if (options.metadataList410OnCalls?.includes(metadataListCalls)) {
				return Response.json(
					{
						success: false,
						errors: [{ code: 3001, message: 'index deleted' }],
					},
					{ status: 410 },
				)
			}
		}
		if (options.lookupStatus) {
			return Response.json(
				{
					success: false,
					errors: [{ code: 10000, message: 'Authentication error' }],
				},
				{ status: options.lookupStatus },
			)
		}
		const index = indexes.get(name)
		if (!index && deleted.has(name)) {
			return Response.json(
				{
					success: false,
					errors: [
						{
							code: 3001,
							message: `vectorize.index.deleted - Index name "${name}" was deleted`,
						},
					],
				},
				{ status: 410 },
			)
		}
		if (!index) {
			return Response.json(
				{ success: false, errors: [{ code: 3000, message: 'not found' }] },
				{ status: 404 },
			)
		}
		if (match?.[2] === '/metadata_index/list') {
			const omitted = new Set(options.omitFromMetadataList ?? [])
			return ok({
				metadataIndexes: index.metadataIndexes
					.filter((propertyName) => !omitted.has(propertyName))
					.map((propertyName) => ({
						propertyName,
						indexType: 'String',
					})),
			})
		}
		if (match?.[2] === '/metadata_index/create') {
			if (options.createAlreadyExists?.includes(body.propertyName)) {
				return Response.json(
					{
						success: false,
						errors: [
							{
								code: 400,
								message: 'metadata index already exists for this name',
							},
						],
					},
					{ status: 400 },
				)
			}
			index.metadataIndexes.push(body.propertyName)
			return ok({})
		}
		if (!match?.[2] && method === 'GET') return ok({ name })
		if (!match?.[2] && method === 'DELETE') {
			if (!options.ignoreDeletes) {
				indexes.delete(name)
				deleted.add(name)
			}
			return ok({})
		}
		throw new Error(`unexpected request ${method} ${url.pathname}`)
	}
	return { indexes, requests, fetcher }
}

const client = (fetcher: typeof fetch) => ({
	accountId: 'test-account',
	apiToken: 'test-token',
	dryRun: false,
	fetcher,
	sleep: async () => {},
})

test('ensureVectorizeIndex creates the embedding-shaped index with every filtered metadata index, then is idempotent', async () => {
	consoleError.mockImplementation(() => {})
	const api = fakeVectorizeApi()
	await ensureVectorizeIndex({
		...client(api.fetcher),
		name: 'kody-pr-7-vectors',
	})
	const created = api.indexes.get('kody-pr-7-vectors')
	expect(created?.config).toEqual({
		dimensions: 384,
		metric: 'cosine',
	})
	expect(created?.metadataIndexes).toEqual([
		'kind',
		'userId',
		'status',
		'category',
		'domain',
	])

	created!.metadataIndexes = ['kind', 'userId']
	api.requests.length = 0
	await ensureVectorizeIndex({
		...client(api.fetcher),
		name: 'kody-pr-7-vectors',
	})
	expect(api.requests).toEqual([
		'GET /kody-pr-7-vectors',
		'GET /kody-pr-7-vectors',
		'GET /kody-pr-7-vectors/metadata_index/list',
		'GET /kody-pr-7-vectors/metadata_index/list',
		'POST /kody-pr-7-vectors/metadata_index/create',
		'POST /kody-pr-7-vectors/metadata_index/create',
		'POST /kody-pr-7-vectors/metadata_index/create',
	])
	expect(created!.metadataIndexes).toEqual([
		'kind',
		'userId',
		'status',
		'category',
		'domain',
	])
})

test('deleteVectorizeIndex treats a missing or just-deleted (410) index as success and fails loudly when the index survives the delete', async () => {
	consoleError.mockImplementation(() => {})
	const api = fakeVectorizeApi()
	await deleteVectorizeIndex({
		...client(api.fetcher),
		name: 'kody-pr-8-vectors',
	})
	expect(api.requests).toEqual(['GET /kody-pr-8-vectors'])

	await ensureVectorizeIndex({
		...client(api.fetcher),
		name: 'kody-pr-8-vectors',
	})
	await deleteVectorizeIndex({
		...client(api.fetcher),
		name: 'kody-pr-8-vectors',
	})
	expect(api.indexes.has('kody-pr-8-vectors')).toBe(false)
	api.requests.length = 0
	await deleteVectorizeIndex({
		...client(api.fetcher),
		name: 'kody-pr-8-vectors',
	})
	expect(api.requests).toEqual(['GET /kody-pr-8-vectors'])

	const stubborn = fakeVectorizeApi({ ignoreDeletes: true })
	await ensureVectorizeIndex({
		...client(stubborn.fetcher),
		name: 'kody-pr-9-vectors',
	})
	await expect(
		deleteVectorizeIndex({
			...client(stubborn.fetcher),
			name: 'kody-pr-9-vectors',
		}),
	).rejects.toThrow(
		'Failed to delete Vectorize index kody-pr-9-vectors: index still exists after delete',
	)

	const forbidden = fakeVectorizeApi({ lookupStatus: 403 })
	await expect(
		deleteVectorizeIndex({
			...client(forbidden.fetcher),
			name: 'kody-pr-9-vectors',
		}),
	).rejects.toThrow('Cloudflare API request failed (403)')
	expect(forbidden.requests).not.toContain('DELETE /kody-pr-9-vectors')
})

test('ensureVectorizeIndex waits for a re-created index that still reads as deleted before adding metadata indexes', async () => {
	consoleError.mockImplementation(() => {})
	const api = fakeVectorizeApi({ staleReadsAfterRecreate: 2 })
	const name = 'kody-pr-11-vectors'
	await ensureVectorizeIndex({ ...client(api.fetcher), name })
	await deleteVectorizeIndex({ ...client(api.fetcher), name })
	api.requests.length = 0
	await ensureVectorizeIndex({ ...client(api.fetcher), name })
	expect(api.requests.slice(0, 5)).toEqual([
		`GET /${name}`,
		'POST /',
		`GET /${name}`,
		`GET /${name}`,
		`GET /${name}`,
	])
	expect(api.indexes.get(name)?.metadataIndexes).toEqual([
		'kind',
		'userId',
		'status',
		'category',
		'domain',
	])
})

test('ensureVectorizeIndex waits when GET succeeds but metadata_index/list still returns 410', async () => {
	consoleError.mockImplementation(() => {})
	const api = fakeVectorizeApi({ metadataStaleAfterCreate: 2 })
	const name = 'kody-pr-12-vectors'
	await ensureVectorizeIndex({ ...client(api.fetcher), name })
	expect(api.indexes.get(name)?.metadataIndexes).toEqual([
		'kind',
		'userId',
		'status',
		'category',
		'domain',
	])
	expect(
		api.requests.filter((entry) => entry.includes('metadata_index/list'))
			.length,
	).toBeGreaterThanOrEqual(3)
})

test('ensureVectorizeIndex retries metadata setup when readiness flaps back to 410', async () => {
	consoleError.mockImplementation(() => {})
	const api = fakeVectorizeApi({ metadataList410OnCalls: [2] })
	const name = 'kody-pr-13-vectors'
	await ensureVectorizeIndex({ ...client(api.fetcher), name })
	expect(api.indexes.get(name)?.metadataIndexes).toEqual([
		'kind',
		'userId',
		'status',
		'category',
		'domain',
	])
	expect(consoleError).toHaveBeenCalledWith(
		expect.stringContaining('retrying metadata setup'),
	)
})

test('ensureVectorizeIndex recreates once when configure keeps answering 410 past the flap retries', async () => {
	consoleError.mockImplementation(() => {})
	const api = fakeVectorizeApi()
	const name = 'kody-pr-14-vectors'
	const base = api.fetcher
	const fetcher: typeof fetch = async (input, init) => {
		const url = new URL(String(input))
		const method = init?.method ?? 'GET'
		const path = url.pathname.replace(/^.*\/vectorize\/v2\/indexes/, '')
		if (path.endsWith('/metadata_index/list') && method === 'GET') {
			// Poison the first index lifetime; after delete+recreate, succeed.
			const recreated =
				api.requests.filter((entry) => entry === `DELETE /${name}`).length >
					0 && api.requests.filter((entry) => entry === 'POST /').length > 1
			if (!recreated) {
				return Response.json(
					{
						success: false,
						errors: [{ code: 3001, message: 'index deleted' }],
					},
					{ status: 410 },
				)
			}
		}
		return base(input, init)
	}
	await ensureVectorizeIndex({ ...client(fetcher), name })
	expect(api.indexes.get(name)?.metadataIndexes).toEqual([
		'kind',
		'userId',
		'status',
		'category',
		'domain',
	])
	expect(api.requests).toContain(`DELETE /${name}`)
	expect(
		api.requests.filter((entry) => entry === 'POST /').length,
	).toBeGreaterThanOrEqual(2)
	expect(consoleError).toHaveBeenCalledWith(
		expect.stringContaining('Recreating Vectorize index once'),
	)
})

test('ensureVectorizeIndex treats metadata_index/create 400 already exists as success', async () => {
	consoleError.mockImplementation(() => {})
	const name = 'kody-pr-16-vectors'
	const api = fakeVectorizeApi({
		omitFromMetadataList: ['kind', 'domain'],
		createAlreadyExists: ['kind', 'domain'],
	})
	api.indexes.set(name, {
		config: { dimensions: 384, metric: 'cosine' },
		metadataIndexes: ['kind', 'userId', 'status', 'category', 'domain'],
	})
	await ensureVectorizeIndex({ ...client(api.fetcher), name })
	expect(api.indexes.get(name)?.metadataIndexes).toEqual([
		'kind',
		'userId',
		'status',
		'category',
		'domain',
	])
	expect(
		api.requests.filter((entry) => entry.includes('metadata_index/create')),
	).toEqual([
		`POST /${name}/metadata_index/create`,
		`POST /${name}/metadata_index/create`,
	])
	expect(consoleError).toHaveBeenCalledWith(
		`Vectorize metadata index already exists: ${name}.kind`,
	)
	expect(consoleError).toHaveBeenCalledWith(
		`Vectorize metadata index already exists: ${name}.domain`,
	)
})

test('ensureVectorizeIndex still throws on a metadata_index/create 400 that is not already-exists', async () => {
	consoleError.mockImplementation(() => {})
	const name = 'kody-pr-17-vectors'
	const api = fakeVectorizeApi()
	const base = api.fetcher
	const fetcher: typeof fetch = async (input, init) => {
		const url = new URL(String(input))
		const method = init?.method ?? 'GET'
		if (url.pathname.endsWith('/metadata_index/create') && method === 'POST') {
			return Response.json(
				{
					success: false,
					errors: [{ code: 400, message: 'invalid property name' }],
				},
				{ status: 400 },
			)
		}
		return base(input, init)
	}
	await expect(
		ensureVectorizeIndex({ ...client(fetcher), name }),
	).rejects.toThrow('invalid property name')
})

test('ensureVectorizeIndex respects deadlineMs while waiting for readiness', async () => {
	consoleError.mockImplementation(() => {})
	const api = fakeVectorizeApi({ metadataStaleAfterCreate: 20 })
	const name = 'kody-pr-15-vectors'
	let now = 0
	await expect(
		ensureVectorizeIndex({
			...client(api.fetcher),
			name,
			now: () => now,
			deadlineMs: 50,
			sleep: async (ms) => {
				now += ms
			},
		}),
	).rejects.toThrow(/Failed to ensure Vectorize index/)
})

test('dry-run ensure and delete make no Cloudflare requests', async () => {
	consoleError.mockImplementation(() => {})
	const api = fakeVectorizeApi()
	await ensureVectorizeIndex({
		...client(api.fetcher),
		dryRun: true,
		name: 'kody-pr-10-vectors',
	})
	await deleteVectorizeIndex({
		...client(api.fetcher),
		dryRun: true,
		name: 'kody-pr-10-vectors',
	})
	expect(api.requests).toEqual([])
})
