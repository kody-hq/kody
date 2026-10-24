import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	countStaticDependentBundleArtifactPackages,
	getPublishedBundleArtifactByIdentity,
	insertPublishedBundleArtifactRow,
	isPublishedBundleArtifactIdentityConflict,
	listPublishedBundleArtifactsByIdentities,
	listStaticDependentBundleArtifactRows,
	publishedBundleArtifactIdentityKey,
	upsertPublishedBundleArtifactRow,
	upsertPublishedBundleArtifactRows,
} from './published-bundle-artifacts-repo.ts'

function createPublishedBundleArtifactsDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE published_bundle_artifacts (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			source_id TEXT NOT NULL,
			published_commit TEXT NOT NULL,
			artifact_kind TEXT NOT NULL,
			artifact_name TEXT,
			entry_point TEXT NOT NULL,
			kv_key TEXT NOT NULL,
			dependencies_json TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX idx_published_bundle_artifacts_source_identity
		ON published_bundle_artifacts(
			user_id,
			source_id,
			artifact_kind,
			COALESCE(artifact_name, ''),
			entry_point
		);
		CREATE TABLE entity_sources (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			published_commit TEXT,
			deleted_at TEXT
		);
	`)
	return createD1FromSqlite(sqlite)
}

async function setLivePublishedCommit(
	db: D1Database,
	input: { userId: string; sourceId: string; publishedCommit: string },
) {
	await db
		.prepare(
			`INSERT OR REPLACE INTO entity_sources (id, user_id, published_commit)
			VALUES (?, ?, ?)`,
		)
		.bind(input.sourceId, input.userId, input.publishedCommit)
		.run()
}

function createStaticDependentsDb(input: {
	first?: Record<string, unknown> | null
	results?: Array<Record<string, unknown>>
	onBind?: (query: string, values: Array<unknown>) => void
}) {
	return {
		prepare(query: string) {
			return {
				bind(...values: Array<unknown>) {
					input.onBind?.(query, values)
					return {
						async first() {
							return input.first ?? null
						},
						async all() {
							return { results: input.results ?? [] }
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

test('static dependent bundle artifact queries count and list bounded rows by source id', async () => {
	const onBind = vi.fn()
	const db = createStaticDependentsDb({
		first: {
			total_packages: 2,
			stale_packages: 1,
		},
		results: [
			{
				package_id: 'package-b',
				package_kody_id: 'package-b',
				package_name: '@kentcdodds/package-b',
				source_id: 'source-b',
				published_commit: 'commit-b',
				artifact_kind: 'module',
				artifact_name: '.',
				entry_point: 'src/index.ts',
				package_stale: 1,
				matching_artifact_count: 1,
				matching_entrypoint_count: 1,
				package_bundled_dependency_commit: 'commit-a-old',
				bundled_dependency_commit: 'commit-a-old',
			},
		],
		onBind,
	})
	const queryInput = {
		userId: ownerIdFromStored('user-1'),
		sourceId: 'source-a',
		currentDependencyCommit: 'commit-a-new',
	}

	const counts = await countStaticDependentBundleArtifactPackages(
		db,
		queryInput,
	)
	expect(counts).toEqual({
		totalPackages: 2,
		stalePackages: 1,
	})

	const rows = await listStaticDependentBundleArtifactRows(db, {
		...queryInput,
		packageLimit: 10,
		artifactsPerPackageLimit: 5,
	})
	expect(rows).toEqual([
		{
			packageId: 'package-b',
			packageKodyId: 'package-b',
			packageName: '@kentcdodds/package-b',
			sourceId: 'source-b',
			publishedCommit: 'commit-b',
			artifactKind: 'module',
			artifactName: '.',
			entryPoint: 'src/index.ts',
			packageStale: true,
			matchingArtifactCount: 1,
			matchingEntrypointCount: 1,
			packageBundledDependencyCommit: 'commit-a-old',
			bundledDependencyCommit: 'commit-a-old',
		},
	])

	expect(onBind).toHaveBeenCalledTimes(2)
	expect(onBind).toHaveBeenNthCalledWith(1, expect.any(String), [
		'commit-a-new',
		'user-1',
		'source-a',
		'source-a',
	])
	expect(onBind).toHaveBeenNthCalledWith(2, expect.any(String), [
		'commit-a-new',
		'user-1',
		'source-a',
		'source-a',
		10,
		5,
	])
})

const identity = {
	userId: ownerIdFromStored('user-1'),
	sourceId: 'source-1',
	artifactName: './record-version',
	entryPoint: 'src/record-version.ts',
}

function artifactRow(
	artifactKind: 'module' | 'importable-module',
	publishedCommit: string,
	dependenciesJson = '[]',
) {
	const kvPrefix = artifactKind === 'module' ? 'module' : 'importable'
	return {
		...identity,
		publishedCommit,
		artifactKind,
		kvKey: `kv:${kvPrefix}:${publishedCommit}`,
		dependenciesJson,
	}
}

function lookup(db: D1Database, artifactKind: string) {
	return getPublishedBundleArtifactByIdentity(db, {
		...identity,
		artifactKind,
	})
}

test('upsertPublishedBundleArtifactRow keeps module and importable-module distinct and recovers a raced identity insert', async () => {
	const db = createPublishedBundleArtifactsDb()
	await upsertPublishedBundleArtifactRow(db, artifactRow('module', 'commit-1'))
	const importableId = await upsertPublishedBundleArtifactRow(
		db,
		artifactRow('importable-module', 'commit-1'),
	)
	await expect(lookup(db, 'importable-module')).resolves.toEqual(
		expect.objectContaining({
			id: importableId,
			publishedCommit: 'commit-1',
			artifactKind: 'importable-module',
			kvKey: 'kv:importable:commit-1',
		}),
	)

	const commit2 = artifactRow(
		'importable-module',
		'commit-2',
		'[{"sourceId":"dep-1"}]',
	)
	await expect(insertPublishedBundleArtifactRow(db, commit2)).rejects.toSatisfy(
		isPublishedBundleArtifactIdentityConflict,
	)

	await expect(upsertPublishedBundleArtifactRow(db, commit2)).resolves.toBe(
		importableId,
	)
	await expect(lookup(db, 'importable-module')).resolves.toEqual(
		expect.objectContaining({
			id: importableId,
			publishedCommit: 'commit-2',
			kvKey: 'kv:importable:commit-2',
			dependenciesJson: '[{"sourceId":"dep-1"}]',
		}),
	)
	await expect(lookup(db, 'module')).resolves.toEqual(
		expect.objectContaining({
			publishedCommit: 'commit-1',
			artifactKind: 'module',
			kvKey: 'kv:module:commit-1',
		}),
	)
})

test('upsertPublishedBundleArtifactRow recovers when lookup misses and insert hits the identity unique index', async () => {
	const existingRow = {
		id: 'row-importable',
		user_id: ownerIdFromStored('user-1'),
		source_id: 'source-1',
		published_commit: 'commit-1',
		artifact_kind: 'importable-module',
		artifact_name: './record-version',
		entry_point: 'src/record-version.ts',
		kv_key: 'kv:importable:commit-1',
		dependencies_json: '[]',
		created_at: '2026-09-14T00:00:00.000Z',
		updated_at: '2026-09-14T00:00:00.000Z',
	}
	let lookups = 0
	let updatedValues: Array<unknown> | null = null
	const db = {
		prepare(query: string) {
			return {
				bind(...values: Array<unknown>) {
					return {
						async first() {
							if (query.includes('FROM entity_sources')) {
								return { published_commit: 'commit-2' }
							}
							lookups += 1
							return lookups === 1 ? null : existingRow
						},
						async run() {
							if (query.includes('INSERT INTO published_bundle_artifacts')) {
								throw new Error(
									'D1_ERROR: UNIQUE constraint failed: idx_published_bundle_artifacts_source_identity: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)',
								)
							}
							updatedValues = values.slice(0, 8)
							return { meta: { changes: 1 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	await expect(
		upsertPublishedBundleArtifactRow(
			db,
			artifactRow('importable-module', 'commit-2', '[{"sourceId":"dep-1"}]'),
		),
	).resolves.toBe('row-importable')
	expect(lookups).toBe(2)
	expect(updatedValues).toEqual([
		'user-1',
		'source-1',
		'commit-2',
		'importable-module',
		'./record-version',
		'src/record-version.ts',
		'kv:importable:commit-2',
		'[{"sourceId":"dep-1"}]',
	])
})

test('upsertPublishedBundleArtifactRow leaves a newer live identity alone when a stale persist recovers', async () => {
	const db = createPublishedBundleArtifactsDb()
	await setLivePublishedCommit(db, {
		userId: ownerIdFromStored('user-1'),
		sourceId: 'source-1',
		publishedCommit: 'commit-2',
	})
	const liveId = await upsertPublishedBundleArtifactRow(
		db,
		artifactRow('importable-module', 'commit-2'),
	)
	await expect(
		upsertPublishedBundleArtifactRow(
			db,
			artifactRow('importable-module', 'commit-1'),
		),
	).resolves.toBe(liveId)
	await expect(lookup(db, 'importable-module')).resolves.toEqual(
		expect.objectContaining({
			id: liveId,
			publishedCommit: 'commit-2',
			kvKey: 'kv:importable:commit-2',
		}),
	)
})

test('upsertPublishedBundleArtifactRow does not retarget identity when live commit moves during update', async () => {
	const db = createPublishedBundleArtifactsDb()
	await setLivePublishedCommit(db, {
		userId: ownerIdFromStored('user-1'),
		sourceId: 'source-1',
		publishedCommit: 'commit-2',
	})
	const liveId = await upsertPublishedBundleArtifactRow(
		db,
		artifactRow('importable-module', 'commit-2'),
	)

	// Stale pre-check is lied to (still "commit-1") while the atomic UPDATE
	// EXISTS clause reads the real live commit-2 and refuses to retarget.
	const guarded = {
		prepare(query: string) {
			const stmt = db.prepare(query)
			return {
				bind(...values: Array<unknown>) {
					const bound = stmt.bind(...values)
					return {
						async first() {
							if (
								query.includes('FROM entity_sources') &&
								!query.includes('UPDATE published_bundle_artifacts')
							) {
								return { published_commit: 'commit-1' }
							}
							return await bound.first()
						},
						run: () => bound.run(),
						all: () => bound.all(),
					}
				},
			}
		},
	} as unknown as D1Database

	await expect(
		upsertPublishedBundleArtifactRow(
			guarded,
			artifactRow('importable-module', 'commit-1', '[{"sourceId":"stale"}]'),
		),
	).resolves.toBe(liveId)
	await expect(lookup(db, 'importable-module')).resolves.toEqual(
		expect.objectContaining({
			id: liveId,
			publishedCommit: 'commit-2',
			kvKey: 'kv:importable:commit-2',
			dependenciesJson: '[]',
		}),
	)
})

test('upsertPublishedBundleArtifactRow does not insert when live commit moves during insert', async () => {
	const db = createPublishedBundleArtifactsDb()
	await setLivePublishedCommit(db, {
		userId: ownerIdFromStored('user-1'),
		sourceId: 'source-1',
		publishedCommit: 'commit-2',
	})

	// Pre-check still sees commit-1, but the guarded INSERT EXISTS clause
	// reads the real live commit-2 and refuses to create a stale identity.
	const guarded = {
		prepare(query: string) {
			const stmt = db.prepare(query)
			return {
				bind(...values: Array<unknown>) {
					const bound = stmt.bind(...values)
					return {
						async first() {
							if (
								query.includes('FROM entity_sources') &&
								!query.includes('INSERT INTO published_bundle_artifacts')
							) {
								return { published_commit: 'commit-1' }
							}
							return await bound.first()
						},
						run: () => bound.run(),
						all: () => bound.all(),
					}
				},
			}
		},
	} as unknown as D1Database

	await expect(
		upsertPublishedBundleArtifactRow(
			guarded,
			artifactRow('importable-module', 'commit-1'),
		),
	).resolves.toBeNull()
	await expect(lookup(db, 'importable-module')).resolves.toBeNull()
})

test('upsertPublishedBundleArtifactRow propagates guarded update failures without unguarded fallback', async () => {
	const existingRow = {
		id: 'row-importable',
		user_id: ownerIdFromStored('user-1'),
		source_id: 'source-1',
		published_commit: 'commit-1',
		artifact_kind: 'importable-module',
		artifact_name: './record-version',
		entry_point: 'src/record-version.ts',
		kv_key: 'kv:importable:commit-1',
		dependencies_json: '[]',
		created_at: '2026-09-14T00:00:00.000Z',
		updated_at: '2026-09-14T00:00:00.000Z',
	}
	const queries: Array<string> = []
	const db = {
		prepare(query: string) {
			return {
				bind(..._values: Array<unknown>) {
					return {
						async first() {
							if (query.includes('FROM entity_sources')) {
								return { published_commit: 'commit-1' }
							}
							return existingRow
						},
						async run() {
							queries.push(query)
							if (
								query.includes('UPDATE published_bundle_artifacts') &&
								query.includes('EXISTS')
							) {
								throw new Error('D1_ERROR: network timeout')
							}
							return { meta: { changes: 1 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	await expect(
		upsertPublishedBundleArtifactRow(
			db,
			artifactRow('importable-module', 'commit-1', '[{"sourceId":"dep-1"}]'),
		),
	).rejects.toThrow('D1_ERROR: network timeout')
	expect(queries).toHaveLength(1)
	expect(queries[0]).toContain('UPDATE published_bundle_artifacts')
	expect(queries[0]).toContain('EXISTS')
})

test('upsertPublishedBundleArtifactRows inserts and updates many identities with a fixed query count', async () => {
	const db = createPublishedBundleArtifactsDb()
	const userId = ownerIdFromStored('user-1')
	await setLivePublishedCommit(db, {
		userId,
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
	})

	const firstBatch = [
		artifactRow('module', 'commit-1'),
		{
			...artifactRow('importable-module', 'commit-1'),
			artifactName: './a',
			entryPoint: 'src/a.ts',
			kvKey: 'kv:importable:a:commit-1',
		},
		{
			...artifactRow('importable-module', 'commit-1'),
			artifactName: './b',
			entryPoint: 'src/b.ts',
			kvKey: 'kv:importable:b:commit-1',
		},
	]
	const prepareSpy = vi.spyOn(db, 'prepare')
	const batchSpy = vi.spyOn(db, 'batch')
	const insertedIds = await upsertPublishedBundleArtifactRows(db, firstBatch)
	expect(insertedIds).toHaveLength(3)
	expect(insertedIds.every((id) => typeof id === 'string')).toBe(true)

	const liveCommitSelects = prepareSpy.mock.calls.filter(([query]) => {
		const sql = String(query)
		return (
			sql.includes('FROM entity_sources') &&
			sql.includes('IN (') &&
			!sql.includes('INSERT INTO') &&
			!sql.includes('UPDATE')
		)
	})
	const identitySelects = prepareSpy.mock.calls.filter(([query]) => {
		const sql = String(query)
		return (
			sql.includes('FROM published_bundle_artifacts') &&
			sql.includes('user_id = ? AND (')
		)
	})
	expect(liveCommitSelects).toHaveLength(1)
	expect(identitySelects).toHaveLength(1)
	expect(batchSpy).toHaveBeenCalledTimes(1)
	prepareSpy.mockRestore()
	batchSpy.mockRestore()

	await expect(lookup(db, 'module')).resolves.toEqual(
		expect.objectContaining({
			publishedCommit: 'commit-1',
			kvKey: 'kv:module:commit-1',
		}),
	)
	await expect(
		getPublishedBundleArtifactByIdentity(db, {
			userId,
			sourceId: 'source-1',
			artifactKind: 'importable-module',
			artifactName: './a',
			entryPoint: 'src/a.ts',
		}),
	).resolves.toEqual(
		expect.objectContaining({
			id: insertedIds[1],
			kvKey: 'kv:importable:a:commit-1',
		}),
	)

	const updatedIds = await upsertPublishedBundleArtifactRows(db, [
		{
			...firstBatch[0]!,
			publishedCommit: 'commit-1',
			kvKey: 'kv:module:commit-1-b',
			dependenciesJson: '[{"sourceId":"dep-1"}]',
		},
		{
			...firstBatch[1]!,
			kvKey: 'kv:importable:a:commit-1-b',
		},
		{
			...firstBatch[2]!,
			kvKey: 'kv:importable:b:commit-1-b',
		},
	])
	expect(updatedIds).toEqual(insertedIds)
	await expect(lookup(db, 'module')).resolves.toEqual(
		expect.objectContaining({
			id: insertedIds[0],
			kvKey: 'kv:module:commit-1-b',
			dependenciesJson: '[{"sourceId":"dep-1"}]',
		}),
	)
})

test('upsertPublishedBundleArtifactRows leaves live identities alone for stale commits', async () => {
	const db = createPublishedBundleArtifactsDb()
	const userId = ownerIdFromStored('user-1')
	await setLivePublishedCommit(db, {
		userId,
		sourceId: 'source-1',
		publishedCommit: 'commit-2',
	})
	const liveIds = await upsertPublishedBundleArtifactRows(db, [
		artifactRow('module', 'commit-2'),
		artifactRow('importable-module', 'commit-2'),
	])
	expect(liveIds).toHaveLength(2)

	const staleIds = await upsertPublishedBundleArtifactRows(db, [
		{
			...artifactRow('module', 'commit-1'),
			kvKey: 'kv:module:stale',
			dependenciesJson: '[{"sourceId":"stale"}]',
		},
		{
			...artifactRow('importable-module', 'commit-1'),
			kvKey: 'kv:importable:stale',
			dependenciesJson: '[{"sourceId":"stale"}]',
		},
	])
	expect(staleIds).toEqual(liveIds)
	await expect(lookup(db, 'module')).resolves.toEqual(
		expect.objectContaining({
			id: liveIds[0],
			publishedCommit: 'commit-2',
			kvKey: 'kv:module:commit-2',
			dependenciesJson: '[]',
		}),
	)
	await expect(lookup(db, 'importable-module')).resolves.toEqual(
		expect.objectContaining({
			id: liveIds[1],
			publishedCommit: 'commit-2',
			kvKey: 'kv:importable:commit-2',
			dependenciesJson: '[]',
		}),
	)
})

test('upsertPublishedBundleArtifactRows does not insert when live commit moved before gated write', async () => {
	const db = createPublishedBundleArtifactsDb()
	const userId = ownerIdFromStored('user-1')
	await setLivePublishedCommit(db, {
		userId,
		sourceId: 'source-1',
		publishedCommit: 'commit-2',
	})

	// Prefetch still sees commit-1; guarded INSERT EXISTS reads live commit-2.
	const guarded = {
		prepare(query: string) {
			const stmt = db.prepare(query)
			return {
				bind(...values: Array<unknown>) {
					const bound = stmt.bind(...values)
					return {
						async first() {
							if (
								query.includes('FROM entity_sources') &&
								!query.includes('INSERT INTO published_bundle_artifacts') &&
								query.includes('LIMIT 1')
							) {
								return { published_commit: 'commit-1' }
							}
							return await bound.first()
						},
						async all() {
							if (
								query.includes('FROM entity_sources') &&
								query.includes('IN (')
							) {
								return {
									results: [{ id: 'source-1', published_commit: 'commit-1' }],
								}
							}
							return await bound.all()
						},
						run: () => bound.run(),
					}
				},
			}
		},
		batch: (statements: Array<D1PreparedStatement>) => db.batch(statements),
	} as unknown as D1Database

	const ids = await upsertPublishedBundleArtifactRows(guarded, [
		artifactRow('module', 'commit-1'),
		artifactRow('importable-module', 'commit-1'),
	])
	expect(ids).toEqual([null, null])
	await expect(lookup(db, 'module')).resolves.toBeNull()
	await expect(lookup(db, 'importable-module')).resolves.toBeNull()
})

test('upsertPublishedBundleArtifactRows recovers UNIQUE identity conflicts via single-row fallback', async () => {
	const db = createPublishedBundleArtifactsDb()
	const userId = ownerIdFromStored('user-1')
	await setLivePublishedCommit(db, {
		userId,
		sourceId: 'source-1',
		publishedCommit: 'commit-2',
	})
	// Seed the identity so a batched insert plan races the unique index.
	const liveId = await insertPublishedBundleArtifactRow(
		db,
		artifactRow('importable-module', 'commit-1'),
	)

	const originalBatch = db.batch.bind(db)
	let batchCalls = 0
	db.batch = async (statements) => {
		batchCalls += 1
		if (batchCalls === 1) {
			throw new Error(
				'D1_ERROR: UNIQUE constraint failed: idx_published_bundle_artifacts_source_identity: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)',
			)
		}
		return await originalBatch(statements)
	}

	// Prefetch sees no row (simulate lookup miss), so the plan chooses INSERT.
	const guarded = {
		prepare(query: string) {
			const stmt = db.prepare(query)
			return {
				bind(...values: Array<unknown>) {
					const bound = stmt.bind(...values)
					return {
						first: () => bound.first(),
						async all() {
							if (
								query.includes('FROM published_bundle_artifacts') &&
								query.includes('user_id = ? AND (')
							) {
								return { results: [] }
							}
							return await bound.all()
						},
						run: () => bound.run(),
					}
				},
			}
		},
		batch: (statements: Array<D1PreparedStatement>) => db.batch(statements),
	} as unknown as D1Database

	await expect(
		upsertPublishedBundleArtifactRows(guarded, [
			artifactRow('module', 'commit-2'),
			artifactRow('importable-module', 'commit-2', '[{"sourceId":"dep-1"}]'),
		]),
	).resolves.toEqual([expect.any(String), liveId])
	await expect(lookup(db, 'importable-module')).resolves.toEqual(
		expect.objectContaining({
			id: liveId,
			publishedCommit: 'commit-2',
			kvKey: 'kv:importable:commit-2',
			dependenciesJson: '[{"sourceId":"dep-1"}]',
		}),
	)
	await expect(lookup(db, 'module')).resolves.toEqual(
		expect.objectContaining({
			publishedCommit: 'commit-2',
			artifactKind: 'module',
		}),
	)
})

test('upsertPublishedBundleArtifactRows preserves COALESCE null-vs-empty artifact_name and last-write-wins without entity_sources', async () => {
	const db = createPublishedBundleArtifactsDb()
	// No entity_sources row → liveCommit null → unguarded last-write-wins.
	const ids = await upsertPublishedBundleArtifactRows(db, [
		{
			...artifactRow('module', 'commit-1'),
			artifactName: null,
			entryPoint: 'src/default.ts',
			kvKey: 'kv:null-name',
		},
		{
			...artifactRow('module', 'commit-1'),
			artifactName: '',
			entryPoint: 'src/default.ts',
			kvKey: 'kv:empty-name-should-collide',
		},
	])
	expect(ids[0]).toBe(ids[1])
	await expect(
		getPublishedBundleArtifactByIdentity(db, {
			userId: ownerIdFromStored('user-1'),
			sourceId: 'source-1',
			artifactKind: 'module',
			artifactName: null,
			entryPoint: 'src/default.ts',
		}),
	).resolves.toEqual(
		expect.objectContaining({
			id: ids[0],
			kvKey: 'kv:empty-name-should-collide',
		}),
	)
})

test('listPublishedBundleArtifactsByIdentities matches single-identity lookups including COALESCE null-vs-empty artifact_name', async () => {
	const db = createPublishedBundleArtifactsDb()
	const userId = ownerIdFromStored('user-1')
	const now = '2026-10-24T00:00:00.000Z'
	await db
		.prepare(
			`INSERT INTO published_bundle_artifacts (
				id, user_id, source_id, published_commit, artifact_kind, artifact_name,
				entry_point, kv_key, dependencies_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			'row-null-name',
			userId,
			'source-null',
			'commit-1',
			'module',
			null,
			'src/default.ts',
			'kv:null',
			'[]',
			now,
			now,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO published_bundle_artifacts (
				id, user_id, source_id, published_commit, artifact_kind, artifact_name,
				entry_point, kv_key, dependencies_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			'row-empty-name',
			userId,
			'source-empty',
			'commit-1',
			'module',
			'',
			'src/empty.ts',
			'kv:empty',
			'[]',
			now,
			now,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO published_bundle_artifacts (
				id, user_id, source_id, published_commit, artifact_kind, artifact_name,
				entry_point, kv_key, dependencies_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			'row-named',
			userId,
			'source-named',
			'commit-1',
			'module',
			'./notes',
			'src/notes.ts',
			'kv:named',
			'[]',
			now,
			now,
		)
		.run()

	const identities = [
		{
			sourceId: 'source-null',
			artifactKind: 'module',
			artifactName: null,
			entryPoint: 'src/default.ts',
		},
		{
			sourceId: 'source-null',
			artifactKind: 'module',
			artifactName: '',
			entryPoint: 'src/default.ts',
		},
		{
			sourceId: 'source-empty',
			artifactKind: 'module',
			artifactName: null,
			entryPoint: 'src/empty.ts',
		},
		{
			sourceId: 'source-empty',
			artifactKind: 'module',
			artifactName: '',
			entryPoint: 'src/empty.ts',
		},
		{
			sourceId: 'source-named',
			artifactKind: 'module',
			artifactName: './notes',
			entryPoint: 'src/notes.ts',
		},
		{
			sourceId: 'source-missing',
			artifactKind: 'module',
			artifactName: './gone',
			entryPoint: 'src/gone.ts',
		},
	] as const

	for (const identity of identities) {
		const single = await getPublishedBundleArtifactByIdentity(db, {
			userId,
			...identity,
		})
		const batched = await listPublishedBundleArtifactsByIdentities(db, {
			userId,
			identities: [identity],
		})
		expect(
			batched.get(publishedBundleArtifactIdentityKey(identity)) ?? null,
		).toEqual(single)
	}

	const prepareSpy = vi.spyOn(db, 'prepare')
	const batched = await listPublishedBundleArtifactsByIdentities(db, {
		userId,
		identities: [...identities],
	})
	const identitySelects = prepareSpy.mock.calls.filter(([query]) =>
		String(query).includes('FROM published_bundle_artifacts'),
	)
	expect(identitySelects).toHaveLength(1)
	prepareSpy.mockRestore()

	expect(
		batched.get(publishedBundleArtifactIdentityKey(identities[0])),
	).toEqual(
		expect.objectContaining({ id: 'row-null-name', artifactName: null }),
	)
	expect(
		batched.get(publishedBundleArtifactIdentityKey(identities[1])),
	).toEqual(
		expect.objectContaining({ id: 'row-null-name', artifactName: null }),
	)
	expect(
		batched.get(publishedBundleArtifactIdentityKey(identities[2])),
	).toEqual(expect.objectContaining({ id: 'row-empty-name', artifactName: '' }))
	expect(
		batched.get(publishedBundleArtifactIdentityKey(identities[3])),
	).toEqual(expect.objectContaining({ id: 'row-empty-name', artifactName: '' }))
	expect(
		batched.get(publishedBundleArtifactIdentityKey(identities[4])),
	).toEqual(
		expect.objectContaining({ id: 'row-named', artifactName: './notes' }),
	)
	expect(batched.has(publishedBundleArtifactIdentityKey(identities[5]))).toBe(
		false,
	)
})

test('listPublishedBundleArtifactsByIdentities issues a fixed number of queries regardless of identity count within the bind cap', async () => {
	const db = createPublishedBundleArtifactsDb()
	const userId = ownerIdFromStored('user-1')
	const now = '2026-10-24T00:00:00.000Z'
	const identities = Array.from({ length: 6 }, (_, index) => ({
		sourceId: `source-${index}`,
		artifactKind: 'module',
		artifactName: `./retriever-${index}`,
		entryPoint: `src/retriever-${index}.ts`,
	}))
	for (const [index, identity] of identities.entries()) {
		await db
			.prepare(
				`INSERT INTO published_bundle_artifacts (
					id, user_id, source_id, published_commit, artifact_kind, artifact_name,
					entry_point, kv_key, dependencies_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				`row-${index}`,
				userId,
				identity.sourceId,
				'commit-1',
				identity.artifactKind,
				identity.artifactName,
				identity.entryPoint,
				`kv:${index}`,
				'[]',
				now,
				now,
			)
			.run()
	}

	const prepareSpy = vi.spyOn(db, 'prepare')
	const batched = await listPublishedBundleArtifactsByIdentities(db, {
		userId,
		identities,
	})
	const identitySelects = prepareSpy.mock.calls.filter(([query]) =>
		String(query).includes('FROM published_bundle_artifacts'),
	)
	expect(identitySelects).toHaveLength(1)
	expect(batched.size).toBe(6)
	for (const [index, identity] of identities.entries()) {
		expect(batched.get(publishedBundleArtifactIdentityKey(identity))).toEqual(
			expect.objectContaining({ id: `row-${index}` }),
		)
	}
	prepareSpy.mockRestore()
})
