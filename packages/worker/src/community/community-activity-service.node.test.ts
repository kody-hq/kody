import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { insertCommunityFork, upsertCommunityRating } from './repo.ts'
import {
	getCommunityActivityForAdmin,
	listCommunityActivityForAdmin,
} from './service.ts'

function createCommunityDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`CREATE TABLE users (
		id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
		username TEXT NOT NULL UNIQUE,
		email TEXT NOT NULL UNIQUE,
		password_hash TEXT NOT NULL,
		stable_user_id TEXT,
		personal_org_id TEXT
	)`)
	// Mirrors the community_listings, community_ratings, and community_forks
	// schemas in packages/worker/migrations/0001-squashed-init.sql.
	sqlite.exec(`
CREATE TABLE community_listings (
	id TEXT PRIMARY KEY NOT NULL,
	owner_user_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	source_id TEXT NOT NULL,
	kody_id TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	tags_json TEXT NOT NULL DEFAULT '[]',
	category TEXT NOT NULL DEFAULT 'other',
	search_text TEXT,
	readme_content TEXT,
	license TEXT NOT NULL,
	package_version TEXT,
	pinned_commit TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'delisted')),
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	published_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
, featured_at TEXT);
CREATE TABLE community_ratings (
	id TEXT PRIMARY KEY NOT NULL,
	listing_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
	adaptation_effort INTEGER NOT NULL CHECK (adaptation_effort BETWEEN 1 AND 5),
	note TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE TABLE IF NOT EXISTS "community_forks" (
	id TEXT PRIMARY KEY NOT NULL,
	listing_id TEXT NOT NULL,
	forker_user_id TEXT NOT NULL,
	origin_commit TEXT NOT NULL,
	forked_package_id TEXT NOT NULL,
	forked_source_id TEXT NOT NULL,
	target_kody_id TEXT NOT NULL,
	listing_name TEXT,
	listing_kody_id TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
, adopted_at TEXT, adoption_note TEXT, actor TEXT
CHECK (actor IS NULL OR actor IN ('human', 'agent')));
CREATE UNIQUE INDEX idx_community_listings_owner_package
ON community_listings(owner_user_id, package_id);
CREATE INDEX idx_community_listings_status
ON community_listings(status);
CREATE UNIQUE INDEX idx_community_ratings_listing_user
ON community_ratings(listing_id, user_id);
CREATE INDEX idx_community_forks_listing_id
	ON community_forks(listing_id);
CREATE INDEX idx_community_forks_forker_listing
	ON community_forks(forker_user_id, listing_id);
CREATE INDEX idx_community_forks_forked_package_id
ON community_forks(forked_package_id);
`)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

const listings = {
	'listing-1': { kodyId: 'alpha', name: '@owner/alpha' },
	'listing-2': { kodyId: 'beta', name: '@owner/beta' },
}

const fork3Activity = {
	id: 'fork-3',
	kind: 'fork',
	listingId: 'listing-2',
	listingName: '@owner/beta',
	listingKodyId: 'beta',
	actingUsername: 'forker',
	occurredAt: '2026-07-20T00:03:00.000Z',
}

test('admin community activity reads forks and latest ratings newest-first with pagination and filters', async () => {
	const { sqlite, db } = createCommunityDb()
	sqlite.exec(
		`INSERT INTO users (username, email, password_hash, stable_user_id) VALUES
			('forker', 'forker@example.com', 'hash', 'user-forker'),
			('rater', 'rater@example.com', 'hash', 'user-rater')`,
	)
	for (const [id, listing] of Object.entries(listings)) {
		sqlite
			.prepare(
				`INSERT INTO community_listings (
					id, owner_user_id, package_id, source_id, kody_id, name,
					description, tags_json, license, pinned_commit, status,
					created_at, updated_at, published_at
				) VALUES (?, 'owner', ?, ?, ?, ?, 'description', '[]', 'MIT',
					'commit-1', 'active', '2026-07-20T00:00:00.000Z',
					'2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z')`,
			)
			.run(id, `package-${id}`, `source-${id}`, listing.kodyId, listing.name)
	}

	for (const [id, listingId, minute] of [
		['fork-1', 'listing-1', 1],
		['fork-2', 'listing-1', 2],
		['fork-3', 'listing-2', 3],
	] as const) {
		await insertCommunityFork(db, {
			id,
			listing_id: listingId,
			forker_user_id: 'user-forker',
			origin_commit: 'commit-1',
			forked_package_id: `package-${id}`,
			forked_source_id: `source-${id}`,
			target_kody_id: `target-${id}`,
			listing_name: listings[listingId].name,
			listing_kody_id: listings[listingId].kodyId,
			created_at: `2026-07-20T00:0${minute}:00.000Z`,
		})
	}

	const rate = (id: string, stars: number, effort: number, minute: number) =>
		upsertCommunityRating(db, {
			id,
			listing_id: 'listing-1',
			user_id: ownerIdFromStored('user-rater'),
			stars,
			adaptation_effort: effort,
			note: 'not exposed',
			created_at: `2026-07-20T00:0${minute}:00.000Z`,
			updated_at: `2026-07-20T00:0${minute}:00.000Z`,
		})
	expect((await rate('rating-original', 4, 3, 4)).id).toBe('rating-original')
	expect(await rate('rating-replacement', 5, 1, 5)).toMatchObject({
		id: 'rating-original',
		stars: 5,
		adaptationEffort: 1,
		updatedAt: '2026-07-20T00:05:00.000Z',
	})

	const ratingActivity = {
		id: 'rating-original',
		kind: 'rating',
		listingId: 'listing-1',
		listingName: '@owner/alpha',
		listingKodyId: 'alpha',
		actingUsername: 'rater',
		occurredAt: '2026-07-20T00:05:00.000Z',
		stars: 5,
		adaptationEffort: 1,
	}
	const firstPage = await listCommunityActivityForAdmin({ db, pageSize: 2 })
	expect(firstPage).toMatchObject({ total: 4, page: 1, pageSize: 2 })
	expect(firstPage.items).toEqual([ratingActivity, fork3Activity])

	const clamped = await listCommunityActivityForAdmin({
		db,
		page: 99,
		pageSize: 2,
	})
	expect(clamped.page).toBe(2)
	expect(clamped.items.map((item) => item.id)).toEqual(['fork-2', 'fork-1'])

	const filtered = await listCommunityActivityForAdmin({
		db,
		kind: 'rating',
		listingId: 'listing-1',
	})
	expect(filtered.total).toBe(1)
	expect(filtered.items).toEqual([ratingActivity])
	expect(
		await getCommunityActivityForAdmin({
			db,
			kind: 'rating',
			activityId: 'rating-original',
		}),
	).toEqual(ratingActivity)

	sqlite.prepare(`DELETE FROM community_listings WHERE id = 'listing-2'`).run()
	const deletedListingActivity = await listCommunityActivityForAdmin({
		db,
		kind: 'fork',
		listingId: 'listing-2',
	})
	expect(deletedListingActivity.items).toEqual([fork3Activity])
})
