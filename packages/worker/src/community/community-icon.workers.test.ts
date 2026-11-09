import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { Resvg } from '@resvg/resvg-wasm'
import {
	buildCommunityIconCacheKey,
	buildCommunityIconR2Key,
	getCommunityIconObject,
	processCommunityIcon,
} from './community-icon.ts'
import type { CommunityListingRecord } from './types.ts'
import { derivedCacheKeyPrefix } from '#worker/kv-cachified.ts'
import { iconFitMaxDimension, uint8ArrayToStream } from './icon-fit.ts'
import { ensureResvgWasmReady } from '#worker/og/resvg-wasm-init.ts'
import { tinyWebpBytes } from '#worker/test-support/images-binding.ts'

test('community icon resolves a cachified descriptor to R2 bytes', async () => {
	const listing = {
		id: `listing-${crypto.randomUUID()}`,
		ownerUserId: ownerIdFromStored('owner-1'),
		packageId: 'package-1',
		sourceId: 'source-1',
		kodyId: 'github-tools',
		name: '@kentcdodds/github-tools',
		description: 'GitHub tools',
		tags: [],
		category: 'integrations',
		searchText: null,
		readmeContent: null,
		license: 'MIT',
		pinnedCommit: 'abc123',
		iconCommit: 'abc123',
		status: 'active',
		trustedCommit: null,
		trustedAt: null,
		trusted: false,
		featuredAt: null,
		featured: false,
		createdAt: '2026-07-10T00:00:00.000Z',
		updatedAt: '2026-07-10T00:00:00.000Z',
		publishedAt: '2026-07-10T00:00:00.000Z',
	} satisfies CommunityListingRecord
	const bytes = tinyWebpBytes
	const r2Key = buildCommunityIconR2Key({
		listingId: listing.id,
		commit: listing.iconCommit,
	})
	const cacheKey =
		derivedCacheKeyPrefix +
		buildCommunityIconCacheKey({
			listingId: listing.id,
			commit: listing.iconCommit,
		})
	await env.COMMUNITY_ASSETS.put(r2Key, bytes, {
		httpMetadata: { contentType: 'image/webp' },
	})
	await env.BUNDLE_ARTIFACTS_KV.put(
		cacheKey,
		JSON.stringify({
			metadata: {
				createdTime: Date.now(),
				ttl: 30 * 24 * 60 * 60 * 1000,
			},
			value: {
				version: 3,
				listingId: listing.id,
				iconCommit: listing.iconCommit,
				r2Key,
				contentType: 'image/webp',
				sourcePath: 'community-icon.png',
				byteLength: bytes.byteLength,
			},
		}),
	)

	const result = await getCommunityIconObject({
		env,
		listing,
		iconCommit: listing.iconCommit,
	})

	expect(result.descriptor.r2Key).toBe(r2Key)
	expect(result.descriptor.contentType).toBe('image/webp')
	expect(new Uint8Array(await result.object.arrayBuffer())).toEqual(bytes)
})

test('community icon ingest fits an oversized PNG to 256px WebP via Images', async () => {
	await ensureResvgWasmReady()
	const svg =
		'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="512"><rect width="1024" height="512" fill="#2563eb"/></svg>'
	const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1024 } })
	const rendered = resvg.render()
	let png: Uint8Array
	try {
		png = rendered.asPng()
	} finally {
		rendered.free()
		resvg.free()
	}
	expect(png.byteLength).toBeGreaterThan(256)

	const processed = await processCommunityIcon({
		path: 'community-icon.png',
		sourceBytes: png,
		images: env.IMAGES,
	})
	expect(processed.contentType).toBe('image/webp')
	expect(processed.bytes.byteLength).toBeGreaterThan(0)
	expect(processed.bytes.byteLength).toBeLessThan(png.byteLength)

	const info = await env.IMAGES.info(uint8ArrayToStream(processed.bytes))
	if (info.format === 'image/svg+xml') {
		throw new Error('Fitted icon info reported SVG instead of a raster.')
	}
	if (!('width' in info)) {
		throw new Error('Fitted icon info is missing raster dimensions.')
	}
	expect(info.format).toBe('image/webp')
	expect(Math.max(info.width, info.height)).toBeLessThanOrEqual(
		iconFitMaxDimension,
	)
	expect(Math.max(info.width, info.height)).toBeGreaterThan(1)
})
