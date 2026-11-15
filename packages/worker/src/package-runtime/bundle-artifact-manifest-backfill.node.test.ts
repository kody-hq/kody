import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { runBundleArtifactManifestBackfill } from './bundle-artifact-manifest-backfill.ts'
import {
	buildPackageAppWorkerTemplateKvKey,
	readPublishedBundleArtifact,
} from './published-runtime-artifacts.ts'

function storedArtifact(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		kind: 'module',
		artifactName: null,
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		entryPoint: 'src/index.ts',
		mainModule: 'index.js',
		modules: { 'index.js': 'export {}', 'chunk.js': 'export const a = 1' },
		dependencies: [],
		createdAt: '2026-10-31T00:00:00.000Z',
		...overrides,
	}
}

function setup(rows: Array<{ id: string; userId?: string; stored?: unknown }>) {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		`CREATE TABLE published_bundle_artifacts (
			id TEXT PRIMARY KEY, user_id TEXT NOT NULL, source_id TEXT NOT NULL,
			published_commit TEXT NOT NULL, kv_key TEXT NOT NULL, total_bytes INTEGER
		)`,
	)
	const store = new Map<string, string>()
	for (const row of rows) {
		sqlite
			.prepare(
				`INSERT INTO published_bundle_artifacts VALUES (?, ?, 'source-1', 'commit-1', ?, NULL)`,
			)
			.run(row.id, row.userId ?? 'user-1', `key-${row.id}`)
		if (row.stored !== undefined) {
			store.set(`key-${row.id}`, JSON.stringify(row.stored))
		}
	}
	const kv = {
		async put(key: string, value: string) {
			store.set(key, value)
		},
		async get(key: string, type?: string) {
			const value = store.get(key)
			if (value === undefined) return null
			return type === 'json' ? JSON.parse(value) : value
		},
	}
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		BUNDLE_ARTIFACTS_KV: kv,
	} as unknown as Env
	const totals = () =>
		Object.fromEntries(
			sqlite
				.prepare('SELECT id, total_bytes FROM published_bundle_artifacts')
				.all()
				.map((row) => [row['id'], row['total_bytes']]),
		)
	return { env, store, totals }
}

test('an artifact stored without a manifest gains one and its row gains the total, with the stored modules unchanged', async () => {
	const stored = storedArtifact()
	const { env, store, totals } = setup([{ id: 'a', stored }])

	const result = await runBundleArtifactManifestBackfill({
		env,
		dryRun: false,
		afterId: null,
	})

	expect(result).toMatchObject({
		scannedRows: 1,
		filledRows: 1,
		manifestsWritten: 1,
		unbackfillableRows: 0,
		nextCursor: null,
		problems: [],
	})
	const expectedBytes = 'export {}'.length + 'export const a = 1'.length
	expect(totals()).toEqual({ a: expectedBytes })
	const { manifest, ...rest } = JSON.parse(store.get('key-a')!)
	expect(rest).toEqual(stored)
	expect(manifest.totalBytes).toBe(expectedBytes)
	const loaded = await readPublishedBundleArtifact({ env, kvKey: 'key-a' })
	expect(loaded?.manifest?.modules['index.js']).toMatchObject({
		role: 'main',
		owner: { sourceId: 'source-1', publishedCommit: 'commit-1' },
	})
})

test('a dry run reports what it would write and writes nothing', async () => {
	const stored = storedArtifact()
	const { env, store, totals } = setup([{ id: 'a', stored }])

	const result = await runBundleArtifactManifestBackfill({
		env,
		dryRun: true,
		afterId: null,
	})

	expect(result).toMatchObject({ filledRows: 1, manifestsWritten: 1 })
	expect(totals()).toEqual({ a: null })
	expect(JSON.parse(store.get('key-a')!)).toEqual(stored)
})

test('a row whose stored artifact is missing or unusable is reported and left untouched', async () => {
	const { env, store, totals } = setup([
		{ id: 'a' },
		{ id: 'b', stored: storedArtifact({ version: 0 }) },
		{ id: 'c', stored: storedArtifact({ modules: { 'index.js': null } }) },
		{ id: 'd' },
	])
	store.set('key-d', '{not json')

	const result = await runBundleArtifactManifestBackfill({
		env,
		dryRun: false,
		afterId: null,
	})

	expect(result).toMatchObject({ filledRows: 0, unbackfillableRows: 4 })
	expect(
		result.problems.map((problem) => [problem.rowId, problem.status]),
	).toEqual([
		['a', 'missing'],
		['b', 'unusable'],
		['c', 'unusable'],
		['d', 'unusable'],
	])
	expect(totals()).toEqual({ a: null, b: null, c: null, d: null })
})

test("a package app's template copy gains the same manifest", async () => {
	const stored = storedArtifact({ kind: 'app', entryPoint: 'src/app.ts' })
	const { env, store } = setup([{ id: 'a', stored }])
	const templateKey = buildPackageAppWorkerTemplateKvKey({
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
	})
	store.set(templateKey, JSON.stringify(stored))

	await runBundleArtifactManifestBackfill({ env, dryRun: false, afterId: null })

	const expectedBytes = 'export {}'.length + 'export const a = 1'.length
	const { manifest, ...rest } = JSON.parse(store.get(templateKey)!)
	expect(rest).toEqual(stored)
	expect(manifest.totalBytes).toBe(expectedBytes)
	expect(manifest.modules['index.js']).toMatchObject({
		role: 'main',
		owner: { sourceId: 'source-1', publishedCommit: 'commit-1' },
	})
})

test('pages by row id and can be limited to some owners', async () => {
	const { env, totals } = setup([
		{ id: 'a', stored: storedArtifact() },
		{ id: 'b', userId: 'user-2', stored: storedArtifact() },
		{ id: 'c', stored: storedArtifact() },
	])

	const first = await runBundleArtifactManifestBackfill({
		env,
		dryRun: false,
		afterId: null,
		limit: 1,
		userIds: ['user-1'],
	})
	expect(first.nextCursor).toBe('a')
	const second = await runBundleArtifactManifestBackfill({
		env,
		dryRun: false,
		afterId: first.nextCursor,
		limit: 5,
		userIds: ['user-1'],
	})

	expect(second.nextCursor).toBeNull()
	expect(totals()).toMatchObject({ b: null })
	expect(totals()['a']).toBeGreaterThan(0)
	expect(totals()['c']).toBeGreaterThan(0)
})

test('a stored artifact that KV fails to read is reported as a failed read, not as unusable', async () => {
	const { env, totals } = setup([{ id: 'a', stored: storedArtifact() }])
	;(
		env as unknown as { BUNDLE_ARTIFACTS_KV: { get: unknown } }
	).BUNDLE_ARTIFACTS_KV.get = async () => {
		throw new Error('KV GET failed: 503')
	}

	const result = await runBundleArtifactManifestBackfill({
		env,
		dryRun: false,
		afterId: null,
	})

	expect(result).toMatchObject({
		filledRows: 0,
		unbackfillableRows: 0,
		readFailedRows: 1,
	})
	expect(result.problems[0]?.status).toBe('read_failed')
	expect(totals()).toEqual({ a: null })
})
