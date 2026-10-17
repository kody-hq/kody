import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { createCommunityIconHandler } from './community-icon.ts'
import type * as CommunityIconModule from '#worker/community/community-icon.ts'
import { type CommunityListingRecord } from '#worker/community/types.ts'

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

const listing = {
	id: 'listing-1',
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
} satisfies CommunityListingRecord

function callHandler(iconCommit = listing.iconCommit) {
	const handler = createCommunityIconHandler({ APP_DB: {} } as Env)
	return handler({
		request: new Request(
			`https://example.com/community/${listing.id}/icon/${iconCommit}`,
		),
		params: { listingId: listing.id, iconCommit },
		url: new URL(
			`https://example.com/community/${listing.id}/icon/${iconCommit}`,
		),
	} as never)
}

test('community icon handler serves cached R2 bytes for current and pinned commits', async () => {
	const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
	const createIconObject = () => ({
		descriptor: {
			byteLength: bytes.byteLength,
			contentType: 'image/png',
		},
		object: {
			body: new Blob([bytes]).stream(),
			httpEtag: '"icon-etag"',
		},
	})
	mocks.getCommunityListingById.mockResolvedValue(listing)
	mocks.getCommunityIconObject.mockImplementation(async () =>
		createIconObject(),
	)

	const currentResponse = await callHandler()
	expect(currentResponse.status).toBe(200)
	expect(currentResponse.headers.get('Content-Type')).toBe('image/png')
	expect(currentResponse.headers.get('Cache-Control')).toBe(
		'public, max-age=31536000, immutable',
	)
	expect(currentResponse.headers.get('ETag')).toBe('"icon-etag"')
	expect(currentResponse.headers.get('X-Content-Type-Options')).toBe('nosniff')
	expect(new Uint8Array(await currentResponse.arrayBuffer())).toEqual(bytes)
	expect(mocks.getCommunityIconObject).toHaveBeenCalledWith(
		expect.objectContaining({ iconCommit: listing.iconCommit }),
	)

	const pinnedResponse = await callHandler(listing.pinnedCommit)
	expect(pinnedResponse.status).toBe(200)
	expect(mocks.getCommunityIconObject).toHaveBeenCalledWith(
		expect.objectContaining({ iconCommit: listing.pinnedCommit }),
	)
})

test('community icon handler rejects stale commit URLs and degrades to a safe fallback', async () => {
	consoleError.mockImplementation(() => {})
	mocks.getCommunityListingById.mockResolvedValue(listing)
	expect((await callHandler('old-commit')).status).toBe(404)

	mocks.getCommunityIconObject.mockRejectedValue(
		new Error('Artifacts unavailable'),
	)
	const fallbackPng = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
	mocks.renderCommunityIconFallbackPng.mockResolvedValue(fallbackPng)
	const response = await callHandler()
	expect(response.status).toBe(200)
	expect(response.headers.get('Content-Type')).toBe('image/png')
	expect(response.headers.get('Cache-Control')).toBe('no-store')
	expect(response.headers.get('Content-Length')).toBe(
		String(fallbackPng.byteLength),
	)
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(fallbackPng)

	mocks.renderCommunityIconFallbackPng.mockRejectedValue(
		new Error('Renderer unavailable'),
	)
	const lastResortResponse = await callHandler()
	expect(lastResortResponse.headers.get('Content-Type')).toBe(
		'image/svg+xml; charset=utf-8',
	)
	expect(lastResortResponse.headers.get('Cache-Control')).toBe('no-store')
	expect(await lastResortResponse.text()).toContain('<svg')
	expect(consoleError).toHaveBeenCalledWith(
		'community-icon-load-failed',
		listing.id,
		expect.any(Error),
	)
	expect(consoleError).toHaveBeenCalledWith(
		'community-icon-fallback-render-failed',
		listing.id,
		expect.any(Error),
	)
})
