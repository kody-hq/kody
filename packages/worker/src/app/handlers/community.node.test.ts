import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { loadCommunityIndexData } from '#app/community-data.ts'
import { type CommunityIndexLoaderData } from '#universal/loader-data.ts'
import { type CommunityListingWithAggregates } from '#worker/community/types.ts'

const mockModule = vi.hoisted(() => ({
	listCommunityIndexOverview: vi.fn(),
	getCommunityCategoryCounts: vi.fn(),
	listCommunityListingsWithAggregates: vi.fn(),
	searchCommunityListings: vi.fn(),
	readAuthenticatedAppUser: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	listCommunityIndexOverview: (...args: Array<unknown>) =>
		mockModule.listCommunityIndexOverview(...args),
	getCommunityCategoryCounts: (...args: Array<unknown>) =>
		mockModule.getCommunityCategoryCounts(...args),
	listCommunityListingsWithAggregates: (...args: Array<unknown>) =>
		mockModule.listCommunityListingsWithAggregates(...args),
	searchCommunityListings: (...args: Array<unknown>) =>
		mockModule.searchCommunityListings(...args),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

const sampleListing = {
	id: 'listing-1',
	ownerUserId: ownerIdFromStored('owner-mcp-id'),
	packageId: 'pkg-1',
	sourceId: 'src-1',
	kodyId: 'github-triage',
	name: '@kentcdodds/github-triage',
	description: 'Triage GitHub issues.',
	tags: ['github'],
	category: 'integrations',
	searchText: null,
	readmeContent: '# README',
	license: 'MIT',
	pinnedCommit: 'abc1234567890',
	iconCommit: 'abc1234567890',
	status: 'active',
	trustedCommit: null,
	trustedAt: null,
	trusted: false,
	featuredAt: null,
	featured: false,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	publishedAt: '2026-01-01T00:00:00.000Z',
	averageStars: 4.5,
	ratingCount: 2,
	averageAdaptationEffort: 3,
	forkCount: 1,
} satisfies CommunityListingWithAggregates

const env = {} as Env

test('community API lists active listings and searches when q is provided', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.listCommunityIndexOverview.mockResolvedValue({
		listings: [sampleListing],
		groups: [
			{
				category: 'integrations',
				listings: [sampleListing],
				total: 1,
			},
		],
		categoryCounts: {
			integrations: 1,
			examples: 0,
			productivity: 0,
			apps: 0,
			utilities: 0,
			other: 0,
		},
	})
	mockModule.getCommunityCategoryCounts.mockResolvedValue({
		integrations: 1,
		examples: 0,
		productivity: 0,
		apps: 0,
		utilities: 0,
		other: 0,
	})
	mockModule.listCommunityListingsWithAggregates.mockResolvedValue([
		sampleListing,
	])
	mockModule.searchCommunityListings.mockResolvedValue([sampleListing])

	const listResponse = await loadCommunityIndexData(
		env,
		new Request('https://example.com/community.json'),
		{ query: '', sort: null, category: null, limit: 50 },
	)
	const listBody = listResponse as CommunityIndexLoaderData

	expect(listBody.ok).toBe(true)
	expect(listBody.listings).toHaveLength(1)
	expect(listBody.listings[0]).toMatchObject({
		id: 'listing-1',
		name: '@kentcdodds/github-triage',
		ownerUsername: 'kentcdodds',
	})
	expect(listBody.listings[0]).not.toHaveProperty('ownerUserId')
	expect(listBody.listings[0]).not.toHaveProperty('status')
	expect(mockModule.listCommunityIndexOverview).toHaveBeenCalledWith({
		env,
		sort: 'best',
	})

	const searchResponse = await loadCommunityIndexData(
		env,
		new Request('https://example.com/community.json?q=github'),
		{ query: 'github', sort: null, category: null, limit: 50 },
	)
	const searchBody = searchResponse as CommunityIndexLoaderData

	expect(searchBody.ok).toBe(true)
	expect(searchBody.query).toBe('github')
	expect(mockModule.searchCommunityListings).toHaveBeenCalledWith({
		env,
		query: 'github',
		limit: 50,
		sort: 'best',
		category: null,
	})

	const newestResponse = await loadCommunityIndexData(
		env,
		new Request('https://example.com/community.json?sort=newest'),
		{ query: '', sort: 'newest', category: null, limit: 50 },
	)
	const newestBody = newestResponse as CommunityIndexLoaderData
	expect(newestBody.sort).toBe('newest')
	expect(mockModule.listCommunityIndexOverview).toHaveBeenCalledWith({
		env,
		sort: 'newest',
	})
})
