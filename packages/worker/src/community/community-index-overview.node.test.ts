import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import type { CommunityListingCategory } from '#universal/community-categories.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureCommunityFlowSchema } from './community-flow-test-schema.ts'
import {
	insertCommunityListing,
	listCommunityIndexOverviewCandidates,
	upsertCommunityRating,
} from './repo.ts'
import { listCommunityIndexOverview } from './service.ts'
import type { CommunityListingStatus } from './types.ts'

async function createOverviewDb() {
	const sqlite = new DatabaseSync(':memory:')
	await ensureCommunityFlowSchema(createD1FromSqlite(sqlite))
	const queries: Array<string> = []
	const db = createD1FromSqlite(sqlite, { queries })
	return { db, queries }
}

async function insertOverviewListing(
	db: D1Database,
	input: {
		id: string
		category: CommunityListingCategory
		publishedAt: string
		status?: CommunityListingStatus
	},
) {
	await insertCommunityListing(db, {
		id: input.id,
		owner_user_id: 'owner-1',
		package_id: `pkg-${input.id}`,
		source_id: `src-${input.id}`,
		kody_id: input.id,
		name: `@owner/${input.id}`,
		description: `${input.id} helpers`,
		tags_json: '[]',
		category: input.category,
		search_text: null,
		readme_content: null,
		license: 'MIT',
		pinned_commit: 'commit-1',
		status: input.status ?? 'active',
		published_at: input.publishedAt,
	})
}

function publishedAtForDay(day: number) {
	return `2026-07-${String(day).padStart(2, '0')}T00:00:00.000Z`
}

test('listCommunityIndexOverview loads shelves with one windowed listing query', async () => {
	const { db, queries } = await createOverviewDb()
	const env = { APP_DB: db } as Env

	queries.length = 0
	const empty = await listCommunityIndexOverview({ env, sort: 'newest' })
	expect(empty).toEqual({
		listings: [],
		groups: [],
		categoryCounts: {
			integrations: 0,
			examples: 0,
			productivity: 0,
			apps: 0,
			utilities: 0,
			other: 0,
		},
	})
	expect(queries).toEqual([
		"SELECT category, COUNT(*) AS listing_count FROM community_listings WHERE status = 'active' AND deleted_at IS NULL GROUP BY category",
	])

	const seeds: Array<
		[id: string, category: CommunityListingCategory, day: number]
	> = [
		...[1, 2, 3, 4, 5, 6, 7, 8].map(
			(day): [string, CommunityListingCategory, number] => [
				`integration-${day}`,
				'integrations',
				day,
			],
		),
		['utility-3', 'utilities', 3],
		['utility-5', 'utilities', 5],
	]
	for (const [id, category, day] of seeds) {
		await insertOverviewListing(db, {
			id,
			category,
			publishedAt: publishedAtForDay(day),
		})
	}
	await insertOverviewListing(db, {
		id: 'integration-delisted',
		category: 'integrations',
		publishedAt: publishedAtForDay(9),
		status: 'delisted',
	})
	await upsertCommunityRating(db, {
		id: 'rating-oldest',
		listing_id: 'integration-1',
		user_id: ownerIdFromStored('rater-1'),
		stars: 5,
		adaptation_effort: 2,
		note: null,
	})

	queries.length = 0
	const newestTwoIntegrations = await listCommunityIndexOverviewCandidates(db, {
		limitPerCategory: 2,
		categories: ['integrations'],
	})
	expect(newestTwoIntegrations.map((listing) => listing.id)).toEqual([
		'integration-8',
		'integration-7',
	])
	expect(queries).toHaveLength(1)
	expect(queries[0]).toContain('ROW_NUMBER()')
	expect(queries[0]).toContain('PARTITION BY category')

	queries.length = 0
	const newest = await listCommunityIndexOverview({ env, sort: 'newest' })
	expect(newest.groups.map((group) => [group.category, group.total])).toEqual([
		['integrations', 8],
		['utilities', 2],
	])
	const newestIntegrations = [8, 7, 6, 5, 4, 3].map(
		(day) => `integration-${day}`,
	)
	const ids = (listings: Array<{ id: string }> = []) =>
		listings.map((listing) => listing.id)
	expect(ids(newest.groups[0]?.listings)).toEqual(newestIntegrations)
	expect(ids(newest.groups[1]?.listings)).toEqual(['utility-5', 'utility-3'])
	expect(ids(newest.listings)).toEqual([
		...newestIntegrations,
		'utility-5',
		'utility-3',
	])
	expect(newest.categoryCounts).toMatchObject({ integrations: 8, examples: 0 })

	expect(queries).toHaveLength(4)
	expect(
		[
			'ROW_NUMBER()',
			'GROUP BY category',
			'FROM community_ratings',
			'FROM community_forks',
		].map(
			(fragment) => queries.filter((query) => query.includes(fragment)).length,
		),
	).toEqual([1, 1, 1, 1])
	expect(queries.find((query) => query.includes('ROW_NUMBER()'))).toContain(
		'category_rank <= ?',
	)

	const best = await listCommunityIndexOverview({ env, sort: 'best' })
	expect(best.groups[0]?.listings[0]).toEqual(
		expect.objectContaining({
			id: 'integration-1',
			averageStars: 5,
			ratingCount: 1,
			forkCount: 0,
		}),
	)
	expect(best.groups[0]?.listings).toHaveLength(6)
})
