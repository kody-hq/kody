import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { findPendingCommunityForkForLookup } from './pending-fork-lookup.ts'

const ownerId = 'org-owner-1'
const otherOwnerId = 'org-owner-2'
const packageId = 'pkg-fork-1'
const sourceId = 'src-fork-1'

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		create table community_forks (
			id text primary key,
			listing_id TEXT, upstream_owner_id TEXT, upstream_package_id TEXT,
			forker_user_id text not null,
			origin_commit text not null,
			forked_package_id text not null,
			forked_source_id text not null,
			target_kody_id text not null,
			listing_name text,
			listing_kody_id text,
			created_at text not null,
			adopted_at text,
			adoption_note text,
			actor text
		);
		create table saved_packages (
			id text primary key,
			user_id text not null,
			kody_id text not null,
			deleted_at text
		);
	`)
	sqlite
		.prepare(
			`insert into community_forks (id, listing_id, forker_user_id, origin_commit,
				forked_package_id, forked_source_id, target_kody_id, created_at)
			values (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			'fork-1',
			'listing-1',
			ownerId,
			'abc123',
			packageId,
			sourceId,
			'starter-site',
			'2026-01-01T00:00:00.000Z',
		)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('finds an unpublished fork by the package_id communityFork returned', async () => {
	const { db } = createDb()
	const fork = await findPendingCommunityForkForLookup(db, {
		forkerUserId: ownerId,
		packageIdOrKodyId: packageId,
	})
	expect(fork).toMatchObject({
		forkedPackageId: packageId,
		forkedSourceId: sourceId,
		targetKodyId: 'starter-site',
	})
})

test('finds an unpublished fork by its name leaf', async () => {
	const { db } = createDb()
	const fork = await findPendingCommunityForkForLookup(db, {
		forkerUserId: ownerId,
		packageIdOrKodyId: 'starter-site',
	})
	expect(fork?.forkedSourceId).toBe(sourceId)
})

test('ignores forks owned by another org', async () => {
	const { db } = createDb()
	await expect(
		findPendingCommunityForkForLookup(db, {
			forkerUserId: otherOwnerId,
			packageIdOrKodyId: packageId,
		}),
	).resolves.toBeNull()
})

test('ignores a fork once its saved package exists (published)', async () => {
	const { sqlite, db } = createDb()
	sqlite
		.prepare(
			'insert into saved_packages (id, user_id, kody_id, deleted_at) values (?, ?, ?, null)',
		)
		.run(packageId, ownerId, 'starter-site')
	await expect(
		findPendingCommunityForkForLookup(db, {
			forkerUserId: ownerId,
			packageIdOrKodyId: packageId,
		}),
	).resolves.toBeNull()
})

test('ignores a fork whose saved package was published and later soft-deleted', async () => {
	const { sqlite, db } = createDb()
	sqlite
		.prepare(
			'insert into saved_packages (id, user_id, kody_id, deleted_at) values (?, ?, ?, ?)',
		)
		.run(packageId, ownerId, 'starter-site', '2026-01-02T00:00:00.000Z')
	await expect(
		findPendingCommunityForkForLookup(db, {
			forkerUserId: ownerId,
			packageIdOrKodyId: 'starter-site',
		}),
	).resolves.toBeNull()
})
