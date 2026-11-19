import { expect, test } from 'vitest'

import { handleNxCacheRequest, parseCacheHash } from './handle-request.ts'
import { createMemoryCacheStore } from './memory-store.ts'
import type { NxCacheEnv } from './nx-cache-types.ts'

const ACCESS_TOKEN = 'test-nx-cache-token'
const READ_TOKEN = 'test-nx-cache-read-token'
const HASH = '0123456789abcdef0123456789abcdef'
const CACHE_PATH = `/v1/cache/${HASH}`

type CacheEnv = Pick<
	NxCacheEnv,
	'CACHE_ACCESS_TOKEN' | 'CACHE_READ_TOKEN' | 'BUILD_COMMIT'
>

function env(overrides: Partial<CacheEnv> = {}): CacheEnv {
	return {
		CACHE_ACCESS_TOKEN: ACCESS_TOKEN,
		BUILD_COMMIT: 'commit-sha',
		...overrides,
	}
}

function handle(
	request: Request,
	store = createMemoryCacheStore(),
	environment = env(),
) {
	return handleNxCacheRequest(request, environment, store)
}

function cacheRequest(
	method: string,
	path: string,
	{
		body,
		token = ACCESS_TOKEN,
		headers = body
			? {
					'content-type': 'application/octet-stream',
					'content-length': String(body.byteLength),
				}
			: {},
	}: {
		body?: ArrayBuffer | Uint8Array<ArrayBuffer>
		token?: string | null
		headers?: Record<string, string>
	} = {},
) {
	return new Request(`https://nx-cache.kody.codes${path}`, {
		method,
		headers: {
			...(token === null ? {} : { authorization: `Bearer ${token}` }),
			...headers,
		},
		body: body ?? null,
	})
}

test('health is public; cache routes require a configured bearer token', async () => {
	expect(parseCacheHash(CACHE_PATH)).toBe(HASH)
	expect(parseCacheHash('/v1/cache/../secrets')).toBeNull()
	expect(parseCacheHash('/v1/cache/not-hex')).toBeNull()
	expect(parseCacheHash('/v1/cache/199855930269886')).toBe('199855930269886')

	const health = await handle(cacheRequest('GET', '/health', { token: null }))
	expect(health.status).toBe(200)
	await expect(health.json()).resolves.toEqual({
		ok: true,
		commit: 'commit-sha',
	})

	const cases: Array<[Request, CacheEnv, number]> = [
		[cacheRequest('GET', CACHE_PATH, { token: null }), env(), 401],
		[cacheRequest('GET', CACHE_PATH, { token: 'wrong-token' }), env(), 401],
		[cacheRequest('GET', CACHE_PATH), env({ CACHE_ACCESS_TOKEN: '   ' }), 503],
		[
			cacheRequest('GET', CACHE_PATH),
			env({ CACHE_ACCESS_TOKEN: undefined }),
			503,
		],
		[
			cacheRequest('PUT', CACHE_PATH),
			env({ CACHE_READ_TOKEN: ACCESS_TOKEN }),
			503,
		],
	]
	const responses = await Promise.all(
		cases.map(([request, environment]) =>
			handle(request, createMemoryCacheStore(), environment),
		),
	)
	expect(responses.map((response) => response.status)).toEqual(
		cases.map(([, , status]) => status),
	)
	expect(await responses.at(-1)!.text()).toBe(
		'Nx cache tokens are misconfigured',
	)
})

test('PUT then GET round-trips an artifact and rejects invalid writes', async () => {
	const store = createMemoryCacheStore()
	const artifact = new TextEncoder().encode('nx-cache-artifact').buffer
	const withReadToken = env({ CACHE_READ_TOKEN: READ_TOKEN })

	const put = () =>
		handle(cacheRequest('PUT', CACHE_PATH, { body: artifact }), store)
	expect((await put()).status).toBe(200)
	expect((await put()).status).toBe(409)

	const fetched = await handle(cacheRequest('GET', CACHE_PATH), store)
	expect(fetched.status).toBe(200)
	expect(fetched.headers.get('content-type')).toBe('application/octet-stream')
	expect(await fetched.text()).toBe('nx-cache-artifact')

	for (const path of [`/v1/cache/${'a'.repeat(32)}`, '/v1/cache/../secrets']) {
		expect((await handle(cacheRequest('GET', path), store)).status).toBe(404)
	}

	const readGet = await handle(
		cacheRequest('GET', CACHE_PATH, { token: READ_TOKEN }),
		store,
		withReadToken,
	)
	expect(readGet.status).toBe(200)
	expect(await readGet.text()).toBe('nx-cache-artifact')

	const readPut = await handle(
		cacheRequest('PUT', `/v1/cache/${'b'.repeat(32)}`, {
			body: artifact,
			token: READ_TOKEN,
		}),
		store,
		withReadToken,
	)
	expect(readPut.status).toBe(403)
	expect(readPut.headers.get('content-type')).toMatch(/^text\/plain/)
	expect(await store.get('b'.repeat(32))).toBeNull()

	const missingLength = await handle(
		new Request(`https://nx-cache.kody.codes${CACHE_PATH}`, {
			method: 'PUT',
			headers: {
				authorization: `Bearer ${ACCESS_TOKEN}`,
				'content-type': 'application/octet-stream',
			},
			// Stream bodies do not get an automatic Content-Length.
			body: new Response(new Uint8Array([1, 2, 3])).body,
			duplex: 'half',
		} as RequestInit),
	)
	expect(missingLength.status).toBe(400)

	const tooLarge = await handle(
		cacheRequest('PUT', CACHE_PATH, {
			body: new Uint8Array([1]),
			headers: {
				'content-type': 'application/octet-stream',
				'content-length': String(100 * 1024 * 1024 + 1),
			},
		}),
	)
	expect(tooLarge.status).toBe(413)
})
