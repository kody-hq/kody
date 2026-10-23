import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureCommunityFlowSchema } from './community-flow-test-schema.ts'
import {
	insertCommunityListing,
	listCommunityListingCandidates,
} from './repo.ts'

async function createListingsDb() {
	const sqlite = new DatabaseSync(':memory:')
	await ensureCommunityFlowSchema(createD1FromSqlite(sqlite))
	return createD1FromSqlite(sqlite)
}

async function insertListing(
	db: D1Database,
	id: string,
	input: { kodyId: string; description: string },
) {
	await insertCommunityListing(db, {
		id,
		owner_user_id: 'owner-1',
		package_id: `pkg-${id}`,
		source_id: `src-${id}`,
		kody_id: input.kodyId,
		name: `@owner/${input.kodyId}`,
		description: input.description,
		tags_json: '[]',
		category: 'other',
		search_text: null,
		readme_content: null,
		license: 'MIT',
		pinned_commit: 'commit-1',
		status: 'active',
		// Same timestamp for every row: paging must still be deterministic.
		published_at: '2026-10-01T00:00:00.000Z',
	})
}

test('community search candidates prefilter on camelCase parts and page in a stable order', async () => {
	const db = await createListingsDb()
	await insertListing(db, 'listing-photo', {
		kodyId: 'gallery',
		description: 'A photo portfolio site',
	})
	await insertListing(db, 'listing-other', {
		kodyId: 'standup',
		description: 'Daily standup notes',
	})
	for (const index of [1, 2, 3, 4]) {
		await insertListing(db, `listing-tie-${index}`, {
			kodyId: `tie-${index}`,
			description: 'Shared helper',
		})
	}

	// "photoPortfolio" is one LIKE token unless camelCase parts are added.
	const camel = await listCommunityListingCandidates(db, {
		includeDelisted: false,
		limit: 10,
		query: 'photoPortfolio',
	})
	expect(camel.map((listing) => listing.id)).toEqual(['listing-photo'])

	const read = (offset: number) =>
		listCommunityListingCandidates(db, {
			includeDelisted: false,
			limit: 2,
			offset,
			query: 'shared',
		})
	const pages = [await read(0), await read(2), await read(4)].map((page) =>
		page.map((listing) => listing.id),
	)
	expect(pages).toEqual([
		['listing-tie-4', 'listing-tie-3'],
		['listing-tie-2', 'listing-tie-1'],
		[],
	])
})
