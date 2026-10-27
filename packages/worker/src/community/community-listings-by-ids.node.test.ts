import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { ensureCommunityFlowSchema } from './community-flow-test-schema.ts'
import {
	getCommunityListingById,
	insertCommunityBan,
	insertCommunityFork,
	insertCommunityListing,
	upsertCommunityRating,
} from './repo.ts'
import {
	getCommunityListingWithAggregates,
	getCommunityListingsByIds,
} from './service.ts'
import { type CommunityListingStatus } from './types.ts'

async function createListingsDb() {
	const sqlite = new DatabaseSync(':memory:')
	await ensureCommunityFlowSchema(createD1FromSqlite(sqlite))
	await ensureOrgsTestSchema(createD1FromSqlite(sqlite))
	const queries: Array<string> = []
	const db = createD1FromSqlite(sqlite, { queries })
	return { db, queries }
}

async function insertListing(
	db: D1Database,
	id: string,
	kodyId: string,
	input: { status?: CommunityListingStatus; ownerUserId?: string } = {},
) {
	await insertCommunityListing(db, {
		id,
		owner_user_id: input.ownerUserId ?? 'owner-1',
		package_id: `pkg-${id}`,
		source_id: `src-${id}`,
		kody_id: kodyId,
		name: `@owner/${kodyId}`,
		description: `${kodyId} helpers`,
		tags_json: '[]',
		category: 'other',
		search_text: null,
		readme_content: null,
		license: 'MIT',
		pinned_commit: 'commit-1',
		status: input.status ?? 'active',
	})
}

test('getCommunityListingsByIds returns public listings in input order with batched aggregates', async () => {
	const { db, queries } = await createListingsDb()

	queries.length = 0
	expect(
		await getCommunityListingsByIds(db, [], { includeDelisted: false }),
	).toEqual([])
	expect(queries).toEqual([])

	await insertListing(db, 'listing-a', 'alpha')
	await insertListing(db, 'listing-b', 'beta')
	await insertListing(db, 'listing-c', 'gamma')
	await insertListing(db, 'listing-delisted', 'retired', {
		status: 'delisted',
	})
	await insertListing(db, 'listing-banned-owner', 'banned-pkg', {
		ownerUserId: ownerIdFromStored('owner-banned'),
	})
	await insertCommunityBan(db, {
		user_id: ownerIdFromStored('owner-banned'),
		banned_by_user_id: 'admin-1',
		reason: 'spam',
	})
	await upsertCommunityRating(db, {
		id: 'rating-b',
		listing_id: 'listing-b',
		user_id: ownerIdFromStored('rater-1'),
		stars: 4,
		adaptation_effort: 2,
		note: null,
	})
	// Forks 1 and 2 are public copies; fork 3 is private and must not count.
	for (const index of [1, 2, 3]) {
		await db
			.prepare(
				`INSERT INTO orgs (id, slug, created_at, updated_at)
				VALUES (?, ?, '2026-10-01', '2026-10-01')`,
			)
			.bind(`forker-${index}`, `forker-${index}`)
			.run()
		await db
			.prepare(
				`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id, is_private)
				VALUES (?, ?, ?, 'beta', '', ?, ?)`,
			)
			.bind(
				`pkg-fork-b-${index}`,
				`forker-${index}`,
				`@forker-${index}/beta`,
				`src-fork-b-${index}`,
				index === 3 ? 1 : 0,
			)
			.run()
		await insertCommunityFork(db, {
			id: `fork-b-${index}`,
			listing_id: 'listing-b',
			forker_user_id: `forker-${index}`,
			origin_commit: 'commit-1',
			forked_package_id: `pkg-fork-b-${index}`,
			forked_source_id: `src-fork-b-${index}`,
			target_kody_id: 'beta',
			listing_name: '@owner/beta',
			listing_kody_id: 'beta',
		})
	}

	const getById = (listingId: string, includeDelisted: boolean) =>
		getCommunityListingById(db, { listingId, includeDelisted })
	expect(await getById('listing-delisted', false)).toBeNull()
	expect(await getById('missing', false)).toBeNull()
	expect(await getById('listing-banned-owner', false)).toMatchObject({
		id: 'listing-banned-owner',
		status: 'active',
	})
	expect(await getById('listing-delisted', true)).toMatchObject({
		id: 'listing-delisted',
		status: 'delisted',
	})

	queries.length = 0
	const publicRows = await getCommunityListingsByIds(
		db,
		[
			'listing-c',
			'missing',
			'listing-a',
			'listing-delisted',
			'listing-b',
			'listing-banned-owner',
		],
		{ includeDelisted: false },
	)
	expect(publicRows.map((listing) => listing.id)).toEqual([
		'listing-c',
		'listing-a',
		'listing-b',
		'listing-banned-owner',
	])
	const listingB = publicRows.find((listing) => listing.id === 'listing-b')
	expect(listingB).toMatchObject({
		averageStars: 4,
		ratingCount: 1,
		averageAdaptationEffort: 2,
		forkCount: 2,
	})
	expect(queries).toHaveLength(3)
	expect(queries.filter((query) => query.includes(' IN ('))).toHaveLength(3)

	const withDelisted = await getCommunityListingsByIds(
		db,
		['listing-delisted', 'listing-a', 'missing'],
		{ includeDelisted: true },
	)
	expect(withDelisted.map((listing) => listing.id)).toEqual([
		'listing-delisted',
		'listing-a',
	])

	expect(
		await getCommunityListingWithAggregates({
			env: { APP_DB: db } as Env,
			listingId: 'listing-b',
			includeDelisted: false,
		}),
	).toEqual(listingB)
})
