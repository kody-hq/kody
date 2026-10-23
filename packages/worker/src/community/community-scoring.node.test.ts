import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as CommunityRepo from './repo.ts'
import { type CommunityListingRecord } from './types.ts'

const mockModule = vi.hoisted(() => ({
	listCommunityListingCandidates: vi.fn(),
	getCommunityRatingAggregatesByListingIds: vi.fn(),
	countCommunityForksByListingIds: vi.fn(),
}))

vi.mock('./repo.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof CommunityRepo>()
	return {
		// Pure helper used by the service to decide whether the SQL LIKE
		// pre-filter was applied; keep the real implementation.
		extractCommunityListingLikeTokens: actual.extractCommunityListingLikeTokens,
		listCommunityListingCandidates: mockModule.listCommunityListingCandidates,
		getCommunityRatingAggregatesByListingIds:
			mockModule.getCommunityRatingAggregatesByListingIds,
		countCommunityForksByListingIds: mockModule.countCommunityForksByListingIds,
	}
})

const {
	COMMUNITY_SEARCH_CANDIDATE_LIMIT,
	buildCommunityListingSearchDocument,
	computeCommunityBayesianScore,
	isCommunityListingSearchMatch,
	searchCommunityListings,
} = await import('./service.ts')

function githubListing(
	overrides: Partial<CommunityListingRecord> = {},
): CommunityListingRecord {
	return {
		id: 'listing-github',
		ownerUserId: ownerIdFromStored('owner-kody'),
		packageId: 'package-github',
		sourceId: 'source-github',
		kodyId: 'github-triage',
		name: '@kody/github-triage',
		description: 'Triage GitHub issues automatically',
		tags: ['github', 'issues', 'triage'],
		category: 'integrations',
		searchText: 'github issues triage',
		readmeContent: '# GitHub Triage\n\n## Intent\n\nTriage github issues.',
		license: 'MIT',
		pinnedCommit: 'commit-github',
		iconCommit: 'commit-github',
		status: 'active',
		trustedCommit: null,
		trustedAt: null,
		trusted: false,
		featuredAt: null,
		featured: false,
		createdAt: '2026-07-01T00:00:00.000Z',
		updatedAt: '2026-07-01T00:00:00.000Z',
		publishedAt: '2026-07-01T00:00:00.000Z',
		...overrides,
	}
}

const mealListing = githubListing({
	id: 'listing-meal',
	ownerUserId: ownerIdFromStored('owner-jane'),
	packageId: 'package-meal',
	sourceId: 'source-meal',
	kodyId: 'meal-planner',
	name: '@jane/meal-planner',
	description: 'Plan weekly meals and grocery lists',
	tags: ['meal', 'grocery', 'planning'],
	category: 'productivity',
	searchText: 'meal plan grocery shopping',
	readmeContent: '# Meal Planner\n\n## Intent\n\nPlan meals.',
	pinnedCommit: 'commit-meal',
	iconCommit: 'commit-meal',
	createdAt: '2026-07-02T00:00:00.000Z',
	updatedAt: '2026-07-02T00:00:00.000Z',
	publishedAt: '2026-07-02T00:00:00.000Z',
})

function mockListings(
	listings: Array<CommunityListingRecord>,
	ratings: Record<string, [ratingCount: number, averageStars: number | null]>,
) {
	mockModule.listCommunityListingCandidates.mockResolvedValue(listings)
	mockModule.getCommunityRatingAggregatesByListingIds.mockResolvedValue(
		Object.fromEntries(
			listings.map(({ id }) => {
				const [ratingCount, averageStars] = ratings[id] ?? [0, null]
				return [
					id,
					{
						listingId: id,
						ratingCount,
						averageStars,
						averageAdaptationEffort: averageStars === null ? null : 2,
					},
				]
			}),
		),
	)
	mockModule.countCommunityForksByListingIds.mockResolvedValue(
		Object.fromEntries(listings.map((listing) => [listing.id, 1])),
	)
}

function search(
	input: Omit<
		Parameters<typeof searchCommunityListings>[0],
		'env' | 'limit'
	> & {
		limit?: number
	},
) {
	return searchCommunityListings({
		env: {
			APP_DB: {} as D1Database,
			BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
		} as Env,
		limit: 10,
		...input,
	})
}

test('community scoring and search rank listings and filter by query', async () => {
	const score = (averageStars: number | null, ratingCount: number) =>
		computeCommunityBayesianScore({ averageStars, ratingCount })
	const unrated = score(null, 0)
	const highlyRated = score(5, 20)
	const lightlyRated = score(5, 1)
	expect(unrated).toBe(3.25)
	expect(highlyRated).toBeGreaterThan(lightlyRated)
	expect(lightlyRated).toBeGreaterThan(unrated)
	expect(lightlyRated).toBeCloseTo((3.25 * 5 + 5) / 6, 5)

	const githubDocument = buildCommunityListingSearchDocument(githubListing())
	const matchCases: Array<
		[query: string, document: typeof githubDocument, expected: boolean]
	> = [
		['github', githubDocument, true],
		['github', buildCommunityListingSearchDocument(mealListing), false],
		['zzqqxxy', githubDocument, false],
		['photofklsdafj', githubDocument, false],
		['triag', githubDocument, true],
		['gi', githubDocument, false],
	]
	for (const [query, document, expected] of matchCases) {
		expect(isCommunityListingSearchMatch({ query, document })).toBe(expected)
	}

	mockListings([mealListing, githubListing()], {
		'listing-github': [8, 4.5],
		'listing-meal': [2, 3.5],
	})

	const githubResults = await search({ query: 'github' })
	expect(githubResults.map((listing) => listing.kodyId)).toEqual([
		'github-triage',
	])
	expect(githubResults[0]?.relevance).toBeGreaterThanOrEqual(0.2)
	expect(mockModule.listCommunityListingCandidates).toHaveBeenCalledWith(
		expect.anything(),
		{
			includeDelisted: false,
			limit: COMMUNITY_SEARCH_CANDIDATE_LIMIT,
			query: 'github',
			category: null,
		},
	)

	const mealResults = await search({ query: 'meal plan grocery' })
	expect(mealResults.map((listing) => listing.kodyId)).toEqual(['meal-planner'])
	expect(mealResults[0]?.relevance).toBeGreaterThanOrEqual(0.2)

	for (const query of [
		'zzqqxxy',
		'text to speech audio narration',
		// Nonsense from a real report: hash embeddings used to let unrelated
		// listings through for queries like this.
		'photofklsdafj',
	]) {
		expect({ query, results: await search({ query }) }).toEqual({
			query,
			results: [],
		})
	}

	const allResults = await search({ query: '' })
	expect(allResults.map((listing) => listing.kodyId)).toEqual([
		'github-triage',
		'meal-planner',
	])
	expect(allResults.every((listing) => listing.relevance === null)).toBe(true)
	expect(
		(await search({ query: '', sort: 'newest' })).map((l) => l.kodyId),
	).toEqual(['meal-planner', 'github-triage'])

	mockListings(
		[
			githubListing(),
			githubListing({
				id: 'listing-github-newer',
				kodyId: 'github-newer',
				name: '@kody/github-newer',
				publishedAt: '2026-07-20T00:00:00.000Z',
			}),
		],
		{ 'listing-github': [20, 5] },
	)
	const sortCases: Array<[sort: 'best' | 'newest', expected: Array<string>]> = [
		['best', ['listing-github', 'listing-github-newer']],
		['newest', ['listing-github-newer', 'listing-github']],
	]
	for (const [sort, expected] of sortCases) {
		const ids = (await search({ query: 'github', sort })).map((l) => l.id)
		expect({ sort, ids }).toEqual({ sort, ids: expected })
	}
	expect(
		(await search({ query: '', category: 'integrations' })).map(
			(l) => l.kodyId,
		),
	).toEqual(['github-triage', 'github-newer'])
	expect(await search({ query: '', category: 'productivity' })).toEqual([])
})

test('community search resultFilter applies before limiting', async () => {
	const falsePositives = Array.from({ length: 12 }, (_, index) =>
		githubListing({
			id: `listing-workflow-${String(index + 1).padStart(2, '0')}`,
			kodyId: `workflow-${index + 1}`,
			name: `@owner/workflow-${index + 1}`,
		}),
	)
	const realProviderListing = githubListing({
		id: 'real-provider-listing',
		kodyId: 'github-helpers',
		name: '@owner/github-helpers',
	})
	mockListings([...falsePositives, realProviderListing], {})

	const providerFiltered = await search({
		query: 'github',
		limit: 1,
		resultFilter: (listing) => listing.id === 'real-provider-listing',
	})
	expect(providerFiltered.map((listing) => listing.id)).toEqual([
		'real-provider-listing',
	])
})

test('community search returns nothing for nonsense across a large catalog', async () => {
	// Many unrelated listings: any vector-noise gate lets a few through.
	const catalog = Array.from({ length: 300 }, (_, index) =>
		githubListing({
			id: `listing-${index}`,
			kodyId: `helper-${index}`,
			name: `@owner/helper-${index}`,
			description: `Helper number ${index} for calendars, email, and files`,
			tags: ['helper', `tag${index}`],
			searchText: `helper ${index} automation`,
			readmeContent: `# Helper ${index}\n\nAutomates everyday work.`,
		}),
	)
	mockListings(catalog, {})
	for (const query of ['photofklsdafj', 'zzqqxxnope', 'qwrtplkjh']) {
		expect({ query, results: await search({ query }) }).toEqual({
			query,
			results: [],
		})
	}
	// A partial word still finds real matches.
	mockListings([githubListing(), mealListing], {})
	expect((await search({ query: 'grocer' })).map((l) => l.kodyId)).toEqual([
		'meal-planner',
	])
})
