import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { type CommunityListingWithAggregates } from '#worker/community/types.ts'
import type * as IconFitModule from '#worker/community/icon-fit.ts'
import { createCommunityDetailOgImageHandler } from './community-detail.ts'

const mocks = vi.hoisted(() => ({
	getCommunityIconObject: vi.fn(),
	getCommunityListingWithAggregates: vi.fn(),
	renderCommunityIconFallbackPng: vi.fn(),
	renderCommunityOgImage: vi.fn(),
	convertIconRasterToPng: vi.fn(),
}))

vi.mock('#worker/community/community-icon.ts', () => ({
	getCommunityIconObject: (...args: Array<unknown>) =>
		mocks.getCommunityIconObject(...args),
	renderCommunityIconFallbackPng: (...args: Array<unknown>) =>
		mocks.renderCommunityIconFallbackPng(...args),
}))

vi.mock('#worker/community/service.ts', () => ({
	getCommunityListingWithAggregates: (...args: Array<unknown>) =>
		mocks.getCommunityListingWithAggregates(...args),
	reportCommunityListing: vi.fn(),
}))

vi.mock('#worker/community/icon-fit.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof IconFitModule>()
	return {
		...actual,
		convertIconRasterToPng: (...args: Array<unknown>) =>
			mocks.convertIconRasterToPng(...args),
	}
})

vi.mock('#worker/community/og-image.ts', () => ({
	renderCommunityOgImage: (...args: Array<unknown>) =>
		mocks.renderCommunityOgImage(...args),
}))

const listing = {
	id: 'listing-1',
	ownerUserId: ownerIdFromStored('owner-1'),
	packageId: 'package-1',
	sourceId: 'source-1',
	kodyId: 'github-triage',
	name: '@kody/github-triage',
	description: 'triage GitHub issues',
	tags: [],
	category: 'integrations',
	searchText: null,
	readmeContent: null,
	license: 'MIT',
	pinnedCommit: 'abc123',
	iconCommit: 'def456',
	status: 'active',
	trustedCommit: null,
	trustedAt: null,
	trusted: false,
	featuredAt: null,
	featured: false,
	createdAt: '2026-07-10T00:00:00.000Z',
	updatedAt: '2026-07-10T00:00:00.000Z',
	publishedAt: '2026-07-10T00:00:00.000Z',
	averageStars: 4.6,
	ratingCount: 12,
	averageAdaptationEffort: null,
	forkCount: 37,
} satisfies CommunityListingWithAggregates

const tinyPng = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
	0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02,
	0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44,
	0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00,
	0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
	0x44, 0xae, 0x42, 0x60, 0x82,
])

test('community detail OG image embeds PNG icons and converts WebP for satori', async () => {
	mocks.getCommunityListingWithAggregates.mockResolvedValue(listing)
	mocks.getCommunityIconObject.mockResolvedValue({
		descriptor: {
			version: 1,
			listingId: listing.id,
			iconCommit: listing.iconCommit,
			r2Key: 'community-icon:v1/listing-1/def456/asset',
			contentType: 'image/png',
			sourcePath: 'community-icon.png',
			byteLength: tinyPng.byteLength,
		},
		object: {
			arrayBuffer: async () => tinyPng.buffer.slice(0),
		},
	})
	mocks.renderCommunityOgImage.mockResolvedValue(tinyPng)

	const handler = createCommunityDetailOgImageHandler({} as Env)
	const pngResponse = await handler({
		request: new Request('https://example.com/community/listing-1/og.png'),
		params: { listingId: listing.id },
		url: new URL('https://example.com/community/listing-1/og.png'),
	} as never)

	expect(pngResponse.status).toBe(200)
	expect(pngResponse.headers.get('Content-Type')).toBe('image/png')
	expect(mocks.renderCommunityOgImage).toHaveBeenCalledWith(
		expect.objectContaining({
			name: listing.name,
			forkCount: listing.forkCount,
			iconDataUri: expect.stringMatching(/^data:image\/png;base64,/),
		}),
	)
	expect(mocks.renderCommunityIconFallbackPng).not.toHaveBeenCalled()

	mocks.renderCommunityOgImage.mockClear()
	mocks.renderCommunityIconFallbackPng.mockClear()
	mocks.convertIconRasterToPng.mockResolvedValue(tinyPng)
	mocks.getCommunityIconObject.mockResolvedValue({
		descriptor: {
			version: 2,
			listingId: listing.id,
			iconCommit: listing.iconCommit,
			r2Key: 'community-icon:v2/listing-1/def456/asset',
			contentType: 'image/webp',
			sourcePath: 'community-icon.webp',
			byteLength: 12,
		},
		object: {
			arrayBuffer: async () => new ArrayBuffer(12),
		},
	})
	mocks.renderCommunityOgImage.mockResolvedValue(tinyPng)

	const webpResponse = await handler({
		request: new Request('https://example.com/community/listing-1/og.png'),
		params: { listingId: listing.id },
		url: new URL('https://example.com/community/listing-1/og.png'),
	} as never)

	expect(webpResponse.status).toBe(200)
	expect(mocks.convertIconRasterToPng).toHaveBeenCalled()
	expect(mocks.renderCommunityIconFallbackPng).not.toHaveBeenCalled()
	expect(mocks.renderCommunityOgImage).toHaveBeenCalledWith(
		expect.objectContaining({
			iconDataUri: expect.stringMatching(/^data:image\/png;base64,/),
		}),
	)
})
