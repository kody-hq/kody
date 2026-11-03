import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { expect, test, vi } from 'vitest'
import { runWithDeferredWork } from '#worker/deferred-work.ts'
import { communityIconCacheControl } from '#worker/community/community-icon.ts'
import type * as CommunityIconModule from '#worker/community/community-icon.ts'
import { type CommunityListingRecord } from '#worker/community/types.ts'
import { silenceExpectedConsoleErrors } from '#worker/test-support/console-spies.ts'
import {
	buildCommunityIconCacheRequest,
	createCommunityIconHandler,
	serveCommunityIconFromCache,
} from './community-icon.ts'

const mocks = vi.hoisted(() => ({
	getCommunityIconObject: vi.fn(),
	getCommunityListingById: vi.fn(),
	renderCommunityIconFallbackPng: vi.fn(),
}))

vi.mock('#worker/community/community-icon.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof CommunityIconModule>()
	return {
		...actual,
		getCommunityIconObject: (...args: Array<unknown>) =>
			mocks.getCommunityIconObject(...args),
		renderCommunityIconFallbackPng: (...args: Array<unknown>) =>
			mocks.renderCommunityIconFallbackPng(...args),
	}
})

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingById: (...args: Array<unknown>) =>
		mocks.getCommunityListingById(...args),
}))

const origin = 'https://test.kody.dev'

function unreadableBinding(name: string) {
	return new Proxy(
		{},
		{
			get() {
				throw new Error(`${name} must not be read on a cache hit`)
			},
		},
	)
}

const bindingsThatThrow = {
	APP_BASE_URL: origin,
	APP_DB: unreadableBinding('APP_DB'),
	BUNDLE_ARTIFACTS_KV: unreadableBinding('BUNDLE_ARTIFACTS_KV'),
	COMMUNITY_ASSETS: unreadableBinding('COMMUNITY_ASSETS'),
} as unknown as Env

function makeListing(): CommunityListingRecord {
	return {
		id: `listing-${crypto.randomUUID()}`,
		ownerUserId: ownerIdFromStored('owner-1'),
		packageId: 'package-1',
		sourceId: 'source-1',
		kodyId: 'icon-tools',
		name: '@example/icon-tools',
		description: 'Icon tools',
		tags: [],
		category: 'integrations',
		searchText: null,
		readmeContent: null,
		license: 'MIT',
		pinnedCommit: 'aaa111',
		iconCommit: 'bbb222',
		status: 'active',
		trustedCommit: null,
		trustedAt: null,
		trusted: false,
		featuredAt: null,
		featured: false,
		createdAt: '2026-07-10T00:00:00.000Z',
		updatedAt: '2026-07-10T00:00:00.000Z',
		publishedAt: '2026-07-10T00:00:00.000Z',
	}
}

const iconBytes = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4])

function iconObject() {
	return {
		descriptor: { byteLength: iconBytes.byteLength, contentType: 'image/webp' },
		object: { body: new Blob([iconBytes]).stream(), httpEtag: '"icon-etag"' },
	}
}

function defaultCache() {
	return (caches as CacheStorage & { default: Cache }).default
}

async function requestIcon(
	env: Env,
	listing: CommunityListingRecord,
	iconCommit: string,
	init?: RequestInit & { search?: string },
) {
	const ctx = createExecutionContext()
	const request = new Request(
		`${origin}/community/${listing.id}/icon/${iconCommit}${init?.search ?? ''}`,
		init,
	)
	const response = await runWithDeferredWork(
		(promise) => ctx.waitUntil(promise),
		() =>
			createCommunityIconHandler(env)({
				request,
				params: { listingId: listing.id, iconCommit },
			}),
	)
	const bytes = new Uint8Array(await response.arrayBuffer())
	await waitOnExecutionContext(ctx)
	return { response, bytes }
}

test('a cached community icon is served without D1, KV, or R2 reads', async () => {
	const listing = makeListing()
	mocks.getCommunityListingById.mockReset().mockResolvedValue(listing)
	mocks.getCommunityIconObject
		.mockReset()
		.mockImplementation(async () => iconObject())

	const miss = await requestIcon(
		{ APP_BASE_URL: origin } as unknown as Env,
		listing,
		listing.iconCommit,
		{ headers: { Cookie: 'kody_session=viewer-a' } },
	)
	expect(miss.response.headers.get('X-Kody-Cache')).toBe('MISS')
	expect(miss.bytes).toEqual(iconBytes)

	mocks.getCommunityListingById.mockReset()
	mocks.getCommunityIconObject.mockReset()
	const hit = await requestIcon(
		bindingsThatThrow,
		listing,
		listing.iconCommit,
		{
			search: '?v=ignored',
			headers: { Authorization: 'Bearer other-viewer' },
		},
	)
	expect(hit.response.status).toBe(200)
	expect(hit.response.headers.get('X-Kody-Cache')).toBe('HIT')
	expect(hit.response.headers.get('Cache-Control')).toBe(
		communityIconCacheControl,
	)
	expect(hit.response.headers.get('Content-Type')).toBe('image/webp')
	expect(hit.response.headers.get('ETag')).toBe('"icon-etag"')
	expect(hit.bytes).toEqual(iconBytes)
	expect(mocks.getCommunityListingById).not.toHaveBeenCalled()
	expect(mocks.getCommunityIconObject).not.toHaveBeenCalled()

	// The pinned commit is a different URL and a different cache entry.
	mocks.getCommunityListingById.mockResolvedValue(listing)
	mocks.getCommunityIconObject.mockImplementation(async () => iconObject())
	const pinned = await requestIcon(
		{ APP_BASE_URL: origin } as unknown as Env,
		listing,
		listing.pinnedCommit,
	)
	expect(pinned.response.headers.get('X-Kody-Cache')).toBe('MISS')
	expect(mocks.getCommunityIconObject).toHaveBeenCalledTimes(1)
})

test('fallback icons and 404s are never stored', async () => {
	silenceExpectedConsoleErrors(['community-icon-load-failed'])
	const listing = makeListing()
	const env = { APP_BASE_URL: origin } as unknown as Env
	mocks.getCommunityListingById.mockReset().mockResolvedValue(listing)
	mocks.getCommunityIconObject
		.mockReset()
		.mockRejectedValue(new Error('R2 unavailable'))
	mocks.renderCommunityIconFallbackPng
		.mockReset()
		.mockResolvedValue(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))

	for (let attempt = 0; attempt < 2; attempt++) {
		const fallback = await requestIcon(env, listing, listing.iconCommit)
		expect(fallback.response.headers.get('Cache-Control')).toBe('no-store')
		expect(fallback.response.headers.get('X-Kody-Cache')).toBe('MISS')
	}
	expect(mocks.getCommunityIconObject).toHaveBeenCalledTimes(2)

	const stale = await requestIcon(env, listing, 'stale-commit')
	expect(stale.response.status).toBe(404)
	for (const commit of [listing.iconCommit, 'stale-commit']) {
		await expect(
			defaultCache().match(
				buildCommunityIconCacheRequest(new Request(origin), env, {
					listingId: listing.id,
					iconCommit: commit,
				}),
			),
		).resolves.toBeUndefined()
	}
})

test('only 200 responses with the immutable policy are stored, without viewer headers', async () => {
	const env = { APP_BASE_URL: origin }
	const immutable = { 'Cache-Control': communityIconCacheControl }
	const cases: Array<[string, () => Response, boolean]> = [
		[
			'immutable 200',
			() =>
				new Response(iconBytes, {
					headers: {
						...immutable,
						'Content-Type': 'image/webp',
						'X-Viewer': 'viewer-a',
					},
				}),
			true,
		],
		[
			'no-store 200',
			() =>
				new Response(iconBytes, { headers: { 'Cache-Control': 'no-store' } }),
			false,
		],
		['404', () => new Response('Not found', { status: 404 }), false],
		[
			'500 with immutable',
			() => new Response('boom', { status: 500, headers: immutable }),
			false,
		],
		[
			'redirect',
			() =>
				new Response(null, {
					status: 302,
					headers: { ...immutable, Location: `${origin}/` },
				}),
			false,
		],
		[
			'Set-Cookie',
			() =>
				new Response(iconBytes, {
					headers: { ...immutable, 'Set-Cookie': 'kody_session=x' },
				}),
			false,
		],
	]
	for (const [label, upstream, stored] of cases) {
		const params = {
			listingId: `listing-${crypto.randomUUID()}`,
			iconCommit: 'c1',
		}
		const request = new Request(
			`${origin}/community/${params.listingId}/icon/${params.iconCommit}`,
		)
		const ctx = createExecutionContext()
		const response = await serveCommunityIconFromCache({
			request,
			env,
			ctx,
			params,
			next: async () => upstream(),
		})
		await response.arrayBuffer()
		await waitOnExecutionContext(ctx)
		const cached = await defaultCache().match(
			buildCommunityIconCacheRequest(request, env, params),
		)
		expect({ label, stored: Boolean(cached) }).toEqual({ label, stored })
		if (cached) {
			expect(cached.headers.get('X-Viewer')).toBeNull()
			expect(cached.headers.get('Cache-Control')).toBe(
				communityIconCacheControl,
			)
		}
	}
})

test('cache keys split on listing and commit, not on query, cookies, or auth', () => {
	const env = { APP_BASE_URL: origin }
	const params = { listingId: 'listing-1', iconCommit: 'c1' }
	const key = (request: Request, overrides: Partial<typeof params> = {}) =>
		buildCommunityIconCacheRequest(request, env, { ...params, ...overrides })
			.url
	const plain = new Request(`${origin}/community/listing-1/icon/c1`)
	const noisy = new Request(`${origin}/community/listing-1/icon/c1?x=1`, {
		headers: { Cookie: 'kody_session=a', Authorization: 'Bearer b' },
	})
	expect(key(noisy)).toBe(key(plain))
	expect(key(plain, { iconCommit: 'c2' })).not.toBe(key(plain))
	expect(key(plain, { listingId: 'listing-2' })).not.toBe(key(plain))
})
