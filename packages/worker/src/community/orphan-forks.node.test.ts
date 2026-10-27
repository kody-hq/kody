import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { communityForksDeleteCascadeStatements } from './community-forks-delete-cascade.ts'
import { deleteCommunityForksForPackage, insertCommunityFork } from './repo.ts'
import { cleanupOrphanedCommunityForks } from './service.ts'

async function createSeededDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE saved_packages (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			kody_id TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			source_id TEXT NOT NULL,
			deleted_at TEXT
		);
		CREATE TABLE entity_sources (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			entity_kind TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			deleted_at TEXT
		);
		CREATE TABLE community_listings (
			id TEXT PRIMARY KEY NOT NULL,
			owner_user_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			source_id TEXT NOT NULL,
			kody_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			license TEXT NOT NULL DEFAULT 'MIT',
			pinned_commit TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active',
			deleted_at TEXT
		);
		CREATE TABLE community_forks (
			id TEXT PRIMARY KEY NOT NULL,
			listing_id TEXT NOT NULL,
			forker_user_id TEXT NOT NULL,
			origin_commit TEXT NOT NULL,
			forked_package_id TEXT NOT NULL,
			forked_source_id TEXT NOT NULL,
			target_kody_id TEXT NOT NULL,
			listing_name TEXT,
			listing_kody_id TEXT,
			adopted_at TEXT,
			adoption_note TEXT,
			actor TEXT,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		);
		${communityForksDeleteCascadeStatements.join(';\n')};
		INSERT INTO community_listings (
			id, owner_user_id, package_id, source_id, kody_id, name, pinned_commit
		) VALUES ('listing-plaid', 'owner-1', 'origin-package', 'origin-source',
			'plaid', '@kody/plaid', 'commit-origin');
		INSERT INTO entity_sources (id, user_id, entity_kind, entity_id)
		VALUES ('source-inert', 'user-kent', 'package', 'package-inert'),
			('source-live', 'user-kent', 'package', 'package-live');
		INSERT INTO saved_packages (id, user_id, name, kody_id, source_id)
		VALUES ('package-live', 'user-kent', '@kentcdodds/plaid', 'plaid', 'source-live');
	`)
	const db = createD1FromSqlite(sqlite)
	for (const [id, packageId, sourceId, targetKodyId] of [
		['fork-inert', 'package-inert', 'source-inert', 'plaid-inert'],
		['fork-live', 'package-live', 'source-live', 'plaid'],
		[
			'fork-orphan',
			'package-missing',
			'source-missing',
			'plaid-fork-test-cleanup',
		],
	] as const) {
		await insertCommunityFork(db, {
			id,
			listing_id: 'listing-plaid',
			forker_user_id: 'user-kent',
			origin_commit: 'commit-origin',
			forked_package_id: packageId,
			forked_source_id: sourceId,
			target_kody_id: targetKodyId,
			listing_name: '@kody/plaid',
			listing_kody_id: 'plaid',
		})
	}
	return db
}

test('orphan fork cleanup and package delete drop leftover community_forks without touching healthy forks', async () => {
	const db = await createSeededDb()
	const env = { APP_DB: db } as Env
	const forkCount = async () =>
		Number(
			(
				await db
					.prepare(
						'SELECT COUNT(*) AS count FROM community_forks WHERE listing_id = ?',
					)
					.bind('listing-plaid')
					.first<{ count: number }>()
			)?.count ?? 0,
		)
	const noop = { applied: true, deletedCount: 0, orphans: [] }

	expect(await forkCount()).toBe(3)
	await expect(
		cleanupOrphanedCommunityForks({ env, apply: true, forkIds: [] }),
	).resolves.toEqual(noop)
	expect(await forkCount()).toBe(3)

	await expect(
		cleanupOrphanedCommunityForks({ env, apply: false }),
	).resolves.toMatchObject({
		applied: false,
		deletedCount: 0,
		orphans: [
			expect.objectContaining({
				forkId: 'fork-orphan',
				forkedPackageId: 'package-missing',
				forkedSourceId: 'source-missing',
				targetKodyId: 'plaid-fork-test-cleanup',
			}),
		],
	})
	expect(await forkCount()).toBe(3)

	await expect(
		cleanupOrphanedCommunityForks({
			env,
			apply: true,
			forkIds: ['fork-inert', 'fork-live'],
		}),
	).resolves.toEqual(noop)
	expect(await forkCount()).toBe(3)

	await expect(
		cleanupOrphanedCommunityForks({
			env,
			apply: true,
			forkIds: ['fork-orphan'],
		}),
	).resolves.toMatchObject({
		applied: true,
		deletedCount: 1,
		orphans: [expect.objectContaining({ forkId: 'fork-orphan' })],
	})
	expect(await forkCount()).toBe(2)

	expect(
		await deleteCommunityForksForPackage(db, {
			userId: ownerIdFromStored('user-kent'),
			packageId: 'package-live',
			sourceId: 'source-live',
		}),
	).toBe(1)
	const remaining = await db
		.prepare(`SELECT id, target_kody_id FROM community_forks`)
		.all<{ id: string; target_kody_id: string }>()
	expect(remaining.results).toEqual([
		{ id: 'fork-inert', target_kody_id: 'plaid-inert' },
	])
})
