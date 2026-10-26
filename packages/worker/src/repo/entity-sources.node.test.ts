import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryRepoSessionIndexEnv } from '#worker/test-support/repo-session-index.ts'
import { type RepoSessionIndexRpc } from './repo-session-index-do.ts'
import { type RepoSessionRow } from './types.ts'
import {
	deleteEntitySource,
	externalReconcileGraceMs,
	listEntitySourcesByIds,
	listEntitySourcesByIdsForUser,
	listEntitySourcesForExternalReconcile,
	markEntitySourcePendingExternalReconcile,
} from './entity-sources.ts'

function catalogSessionRow(
	overrides: Partial<RepoSessionRow> & Pick<RepoSessionRow, 'id' | 'user_id'>,
): RepoSessionRow {
	return {
		source_id: 'source-1',
		source_repo_id: 'repo-1',
		session_branch: `sessions/${overrides.id}`,
		source_branch: 'main',
		base_commit: 'commit',
		source_root: '/',
		conversation_id: null,
		status: 'active',
		expires_at: null,
		last_checkpoint_at: null,
		last_checkpoint_commit: null,
		last_check_run_id: null,
		last_check_tree_hash: null,
		created_at: '2026-06-24T19:00:00.000Z',
		updated_at: '2026-06-24T19:00:00.000Z',
		...overrides,
	}
}

function entitySourcesSqlite() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE entity_sources (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			entity_kind TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			repo_id TEXT NOT NULL,
			published_commit TEXT,
			indexed_commit TEXT,
			manifest_path TEXT NOT NULL,
			source_root TEXT NOT NULL,
			last_external_check_at TEXT,
			external_check_until TEXT,
			deleted_at TEXT,

			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
	`)
	return sqlite
}

test('source deletion removes only its repo-session storage inventory', async () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE entity_sources (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			deleted_at TEXT
		);
		CREATE TABLE user_storage_buckets (
			user_id TEXT NOT NULL,
			storage_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			deleted_at TEXT,
			PRIMARY KEY (user_id, storage_id)
		);
		INSERT INTO entity_sources VALUES
			('source-a', 'user-a', NULL),
			('source-b', 'user-b', NULL);
		INSERT INTO user_storage_buckets VALUES
			('user-a', 'repo-session:session-a', 'repo_session', NULL),
			('user-a', 'exec:keep', 'execute', NULL),
			('user-b', 'repo-session:session-b', 'repo_session', NULL);
	`)
	const db = createD1FromSqlite(sqlite)
	const indexEnv = createInMemoryRepoSessionIndexEnv(db)
	const indexNamespace = indexEnv.REPO_SESSION_INDEX as unknown as {
		idFromName(name: string): DurableObjectId
		get(id: DurableObjectId): RepoSessionIndexRpc
	}
	const indexFor = (userId: string) =>
		indexNamespace.get(indexNamespace.idFromName(userId))
	await indexFor('user-a').insertSession({
		ownerId: ownerIdFromStored('user-a'),
		row: catalogSessionRow({
			id: 'session-a',
			user_id: ownerIdFromStored('user-a'),
			source_id: 'source-a',
		}),
	})
	await indexFor('user-b').insertSession({
		ownerId: ownerIdFromStored('user-b'),
		row: catalogSessionRow({
			id: 'session-b',
			user_id: ownerIdFromStored('user-b'),
			source_id: 'source-b',
		}),
	})

	await expect(
		deleteEntitySource(
			{ APP_DB: db, REPO_SESSION_INDEX: indexEnv.REPO_SESSION_INDEX },
			{ id: 'source-a', userId: ownerIdFromStored('user-a') },
		),
	).resolves.toBe(true)
	expect(
		sqlite
			.prepare(
				`SELECT user_id, storage_id, kind
				FROM user_storage_buckets
				ORDER BY user_id, storage_id`,
			)
			.all(),
	).toEqual([
		{
			user_id: ownerIdFromStored('user-a'),
			storage_id: 'exec:keep',
			kind: 'execute',
		},
		{
			user_id: ownerIdFromStored('user-b'),
			storage_id: 'repo-session:session-b',
			kind: 'repo_session',
		},
	])
	expect(
		await indexFor('user-a').listByUser({
			ownerId: ownerIdFromStored('user-a'),
		}),
	).toEqual([])
	expect(
		(
			await indexFor('user-b').listByUser({
				ownerId: ownerIdFromStored('user-b'),
			})
		).map((row) => row.id),
	).toEqual(['session-b'])
})

test('external reconcile selects token-pending packages and the daily backstop covers the fleet', async () => {
	const sqlite = entitySourcesSqlite()
	sqlite.exec(`
		INSERT INTO entity_sources VALUES
			(
				'dormant', 'user-1', 'package', 'package-1', 'repo-1',
				'commit-1', NULL, 'package.json', '/', NULL, NULL, NULL,
				'2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'
			),
			(
				'pending', 'user-2', 'package', 'package-2', 'repo-2',
				'commit-2', NULL, 'package.json', '/',
				'2026-05-04T01:00:00.000Z', '2026-05-04T04:00:00.000Z', NULL,
				'2026-05-02T00:00:00.000Z', '2026-05-02T00:00:00.000Z'
			),
			(
				'plain-repo', 'user-1', 'repo', 'repo-1', 'repo-3',
				'commit-3', NULL, 'package.json', '/', NULL, NULL,
				'2026-05-04T04:00:00.000Z',
				'2026-05-03T00:00:00.000Z', '2026-05-03T00:00:00.000Z'
			);
	`)
	const db = createD1FromSqlite(sqlite)
	const before = '2026-05-04T01:55:00.000Z'

	const initial = await listEntitySourcesForExternalReconcile(db, {
		before,
		limit: 50,
	})
	expect(initial.map((row) => row.id)).toEqual(['pending'])

	const tokenExpiresAt = '2026-05-04T03:00:00.000Z'
	await markEntitySourcePendingExternalReconcile(db, {
		id: 'dormant',
		userId: ownerIdFromStored('user-1'),
		tokenExpiresAt,
	})
	const marked = sqlite
		.prepare(
			`SELECT external_check_until
			FROM entity_sources
			WHERE id = 'dormant' AND user_id = 'user-1'`,
		)
		.get() as { external_check_until: string }
	expect(marked.external_check_until).toBe(
		new Date(
			new Date(tokenExpiresAt).getTime() + externalReconcileGraceMs,
		).toISOString(),
	)

	const afterMint = await listEntitySourcesForExternalReconcile(db, {
		before,
		limit: 50,
	})
	expect(afterMint.map((row) => row.id)).toEqual(['dormant', 'pending'])

	const dailyBackstop = await listEntitySourcesForExternalReconcile(db, {
		before,
		limit: 50,
		includeAll: true,
	})
	expect(dailyBackstop.map((row) => row.id)).toEqual(['dormant', 'pending'])
})

test('listEntitySourcesByIds batches ids into IN queries and skips missing rows', async () => {
	const sqlite = entitySourcesSqlite()
	for (const id of ['source-a', 'source-b', 'source-c']) {
		sqlite
			.prepare(
				`INSERT INTO entity_sources VALUES
					(?, 'user-1', 'package', ?, ?, 'commit-1', NULL,
					'package.json', '/', NULL, NULL, NULL,
					'2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z')`,
			)
			.run(id, `package-${id}`, `repo-${id}`)
	}

	const queries: Array<string> = []
	const db = createD1FromSqlite(sqlite, { queries, maxBindings: 100 })

	expect(await listEntitySourcesByIds(db, [])).toEqual([])
	expect(queries).toEqual([])

	const loaded = await listEntitySourcesByIds(db, [
		'source-b',
		'source-missing',
		'source-a',
		'source-b',
	])
	expect(loaded.map((row) => row.id).sort()).toEqual(['source-a', 'source-b'])
	expect(loaded.find((row) => row.id === 'source-a')?.entity_id).toBe(
		'package-source-a',
	)
	expect(queries).toEqual([
		'SELECT * FROM entity_sources WHERE id IN (?, ?, ?) AND deleted_at IS NULL',
	])

	const manyIds = Array.from({ length: 101 }, (_, index) => `missing-${index}`)
	await listEntitySourcesByIds(db, manyIds)
	expect(
		queries.filter((query) => query.includes('WHERE id IN (')).length,
	).toBe(3)
})

test('listEntitySourcesByIdsForUser scopes by user_id and skips other users', async () => {
	const sqlite = entitySourcesSqlite()
	sqlite
		.prepare(
			`INSERT INTO entity_sources VALUES
				('source-mine', 'user-1', 'package', 'package-mine', 'repo-mine',
				'commit-1', NULL, 'package.json', '/', NULL, NULL, NULL,
				'2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z')`,
		)
		.run()
	sqlite
		.prepare(
			`INSERT INTO entity_sources VALUES
				('source-theirs', 'user-2', 'package', 'package-theirs', 'repo-theirs',
				'commit-1', NULL, 'package.json', '/', NULL, NULL, NULL,
				'2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z')`,
		)
		.run()

	const queries: Array<string> = []
	const db = createD1FromSqlite(sqlite, { queries, maxBindings: 100 })

	expect(
		await listEntitySourcesByIdsForUser(db, {
			userId: ownerIdFromStored('user-1'),
			ids: [],
		}),
	).toEqual([])
	expect(queries).toEqual([])

	const loaded = await listEntitySourcesByIdsForUser(db, {
		userId: ownerIdFromStored('user-1'),
		ids: ['source-mine', 'source-theirs', 'source-missing', 'source-mine'],
	})
	expect(loaded.map((row) => row.id)).toEqual(['source-mine'])
	expect(queries).toEqual([
		'SELECT * FROM entity_sources WHERE user_id = ? AND id IN (?, ?, ?) AND deleted_at IS NULL',
	])

	const manyIds = Array.from({ length: 100 }, (_, index) => `missing-${index}`)
	await listEntitySourcesByIdsForUser(db, {
		userId: ownerIdFromStored('user-1'),
		ids: manyIds,
	})
	expect(
		queries.filter((query) => query.includes('WHERE user_id = ? AND id IN ('))
			.length,
	).toBe(3)
})
