import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { getStaticPackageDependentsSummary } from '#worker/package-runtime/static-package-dependents.ts'
import { ensureSoftDeleteTestColumns } from '#worker/soft-delete/test-schema.ts'
import { entitySourcesTableSql } from '#worker/repo/entity-sources-test-schema.ts'

async function runSql(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

async function ensurePublishedBundleArtifactDependencySchema() {
	await runSql(entitySourcesTableSql)
	await runSql(`CREATE TABLE IF NOT EXISTS saved_packages (
		id TEXT PRIMARY KEY NOT NULL,
		user_id TEXT NOT NULL,
		name TEXT NOT NULL,
		kody_id TEXT NOT NULL,
		description TEXT NOT NULL,
		tags_json TEXT NOT NULL DEFAULT '[]',
		search_text TEXT,
		source_id TEXT NOT NULL,
		has_app INTEGER NOT NULL DEFAULT 0 CHECK (has_app IN (0, 1)),
		has_skills INTEGER NOT NULL DEFAULT 0 CHECK (has_skills IN (0, 1)),
		hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
		is_private INTEGER NOT NULL DEFAULT 1 CHECK (is_private IN (0, 1)),
		is_internet_visible INTEGER NOT NULL DEFAULT 0,
		locked_at TEXT,
		created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
		updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
	)`)
	for (const column of [
		'is_private INTEGER NOT NULL DEFAULT 1',
		'is_internet_visible INTEGER NOT NULL DEFAULT 0',
		'locked_at TEXT',
	]) {
		try {
			await runSql(`ALTER TABLE saved_packages ADD COLUMN ${column}`)
		} catch {
			// Column already present on newer schemas.
		}
	}
	await runSql(`CREATE TABLE IF NOT EXISTS published_bundle_artifacts (
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
	)`)
	await ensureSoftDeleteTestColumns(env.APP_DB)
}

async function insertPackage(input: {
	userId: string
	packageId: string
	kodyId: string
	name: string
	sourceId: string
	publishedCommit: string
}) {
	const now = new Date().toISOString()
	await runSql(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, '[]', NULL, ?, 0, ?, ?)`,
		input.packageId,
		input.userId,
		input.name,
		input.kodyId,
		`${input.name} package`,
		input.sourceId,
		now,
		now,
	)
	await runSql(
		`INSERT INTO entity_sources (
			id, user_id, entity_kind, entity_id, repo_id, published_commit,
			indexed_commit, manifest_path, source_root, created_at, updated_at
		) VALUES (?, ?, 'package', ?, ?, ?, NULL, 'package.json', '/', ?, ?)`,
		input.sourceId,
		input.userId,
		input.packageId,
		`repo-${input.sourceId}`,
		input.publishedCommit,
		now,
		now,
	)
}

async function insertArtifact(input: {
	userId: string
	sourceId: string
	publishedCommit: string
	artifactName: string
	entryPoint: string
	dependencies: Array<Record<string, unknown>>
}) {
	const now = new Date().toISOString()
	await runSql(
		`INSERT INTO published_bundle_artifacts (
			id, user_id, source_id, published_commit, artifact_kind, artifact_name,
			entry_point, kv_key, dependencies_json, created_at, updated_at
		) VALUES (?, ?, ?, ?, 'module', ?, ?, ?, ?, ?, ?)`,
		crypto.randomUUID(),
		input.userId,
		input.sourceId,
		input.publishedCommit,
		input.artifactName,
		input.entryPoint,
		`kv:${input.sourceId}:${input.artifactName}`,
		JSON.stringify(input.dependencies),
		now,
		now,
	)
}

test('static dependent summary runs JSON dependency queries against D1', async () => {
	await ensurePublishedBundleArtifactDependencySchema()
	const unique = crypto.randomUUID()
	const userId = `user-${unique}`
	const sourceOf = (letter: string) => `source-${letter}-${unique}`
	const packages = [
		['a', 'commit-a-new'],
		['b', 'commit-b'],
		['c', 'commit-c'],
		['d', 'commit-d-current'],
	] as const
	for (const [letter, publishedCommit] of packages) {
		await insertPackage({
			userId,
			packageId: `package-${letter}-${unique}`,
			kodyId: `package-${letter}-${unique}`,
			name: `@kentcdodds/package-${letter}-${unique}`,
			sourceId: sourceOf(letter),
			publishedCommit,
		})
	}
	const dependsOnA = (publishedCommit?: string) => [
		{
			sourceId: sourceOf('a'),
			...(publishedCommit ? { publishedCommit } : {}),
			kodyId: `package-a-${unique}`,
			packageName: `@kentcdodds/package-a-${unique}`,
		},
	]
	const artifacts: Array<
		[letter: string, commit: string, name: string, entry: string, dep?: string]
	> = [
		...[0, 1, 2, 3, 4].map(
			(index) =>
				[
					'b',
					'commit-b',
					`a-current-${index}`,
					`src/current-${index}.ts`,
					'commit-a-new',
				] as [string, string, string, string, string],
		),
		[
			'b',
			'commit-b',
			'a-current-0-importable',
			'src/current-0.ts',
			'commit-a-new',
		],
		['b', 'commit-b', 'z-stale', 'src/stale.ts', 'commit-a-old'],
		['c', 'commit-c', 'missing-commit', 'src/missing.ts'],
		[
			'd',
			'commit-d-obsolete',
			'removed-import',
			'src/removed-import.ts',
			'commit-a-old',
		],
	]
	for (const [
		letter,
		publishedCommit,
		artifactName,
		entryPoint,
		dep,
	] of artifacts) {
		await insertArtifact({
			userId,
			sourceId: sourceOf(letter),
			publishedCommit,
			artifactName,
			entryPoint,
			dependencies: dependsOnA(dep),
		})
	}

	const summary = await getStaticPackageDependentsSummary({
		db: env.APP_DB,
		userId,
		sourceId: sourceOf('a'),
		currentDependencyCommit: 'commit-a-new',
	})

	expect(summary).toEqual(
		expect.objectContaining({
			total: 2,
			stale: 2,
			truncated: false,
		}),
	)
	expect(summary.items[0]).toEqual(
		expect.objectContaining({
			name: `@kentcdodds/package-b-${unique}`,
			stale: true,
			artifact_count: 7,
			entrypoints_truncated: true,
			bundled_dependency_commit: null,
		}),
	)
	expect(summary.items[0]?.entrypoints).toHaveLength(5)
	expect(summary.items[0]?.entrypoints[0]).toBe('src/stale.ts')
	expect(summary.items[1]).toEqual(
		expect.objectContaining({
			name: `@kentcdodds/package-c-${unique}`,
			stale: true,
			bundled_dependency_commit: null,
		}),
	)
})
