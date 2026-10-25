/**
 * KodyFetchGateway credential-need checks recompute a package's needs closure
 * when the published KV blob is missing. That walk used to await each
 * import's package-name lookup and then `getEntitySourceById` — serial after
 * await, so the KODY-7H microtask batcher never coalesced (KODY-AK).
 */
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

const kv = new Map<string, unknown>()

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	readPublishedCredentialNeeds: async (input: {
		sourceId: string
		publishedCommit: string
	}) => kv.get(`${input.sourceId}:${input.publishedCommit}`) ?? null,
	writePublishedCredentialNeeds: async () => undefined,
	readPublishedSourceSnapshot: async () => null,
}))

vi.mock('#worker/repo/published-source.ts', () => ({
	loadPublishedEntityManifest: async (input: { sourceId: string }) => ({
		manifest: {
			name: `@org/${input.sourceId}`,
			exports: { '.': './index.js' },
			kody: {
				id: input.sourceId,
				description: 'Batched needs fixture',
				credentials: {},
			},
		},
		content: '{}',
		source: null,
	}),
}))

vi.mock('#worker/credentials/credential-suppliers-flag.ts', () => ({
	isPackageCredentialSuppliersEnabled: async () => false,
}))

const { computeCredentialNeedsClosure } =
	await import('./credential-needs-closure.ts')

function createTables(sqlite: DatabaseSync) {
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
		CREATE TABLE saved_packages (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			kody_id TEXT NOT NULL,
			description TEXT NOT NULL,
			tags_json TEXT NOT NULL DEFAULT '[]',
			search_text TEXT,
			source_id TEXT NOT NULL,
			has_app INTEGER NOT NULL DEFAULT 0,
			has_skills INTEGER NOT NULL DEFAULT 0,
			hidden INTEGER NOT NULL DEFAULT 0,
			is_private INTEGER NOT NULL DEFAULT 1,
			is_internet_visible INTEGER NOT NULL DEFAULT 0,
			locked_at TEXT,
			deleted_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
	`)
}

function insertPackage(
	sqlite: DatabaseSync,
	input: { id: string; name: string; sourceId: string; userId: string },
) {
	sqlite
		.prepare(
			`INSERT INTO entity_sources VALUES
				(?, ?, 'package', ?, ?, 'commit-1', NULL,
				'package.json', '/', NULL, NULL, NULL,
				'2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z')`,
		)
		.run(
			input.sourceId,
			input.userId,
			`package-${input.sourceId}`,
			`repo-${input.sourceId}`,
		)
	sqlite
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, source_id,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, '', ?, '2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z')`,
		)
		.run(
			input.id,
			input.userId,
			input.name,
			input.name.slice(input.name.lastIndexOf('/') + 1),
			input.sourceId,
		)
	kv.set(`${input.sourceId}:commit-1`, [
		{
			key: input.id,
			kind: 'secret',
			provider: input.id,
			description: 'Stored need.',
			multiple: false,
		},
	])
}

test('credential-needs dependency walk issues one entity_sources IN query', async () => {
	const sqlite = new DatabaseSync(':memory:')
	createTables(sqlite)
	const userId = ownerIdFromStored('user-1')
	insertPackage(sqlite, {
		id: 'pkg-a',
		name: '@org/dep-a',
		sourceId: 'source-a',
		userId,
	})
	insertPackage(sqlite, {
		id: 'pkg-b',
		name: '@org/dep-b',
		sourceId: 'source-b',
		userId,
	})
	insertPackage(sqlite, {
		id: 'pkg-c',
		name: '@org/dep-c',
		sourceId: 'source-c',
		userId,
	})

	const queries: Array<string> = []
	const db = createD1FromSqlite(sqlite, { queries })
	const env = { APP_DB: db } as Env

	const { needs } = await computeCredentialNeedsClosure({
		env,
		userId,
		manifest: {
			name: '@org/root',
			exports: { '.': './index.js' },
			kody: { description: 'Root', credentials: {} },
		} as never,
		files: {
			'index.ts': [
				"import a from 'kody:@org/dep-a'",
				"import b from 'kody:@org/dep-b'",
				"import c from 'kody:@org/dep-c'",
			].join('\n'),
		},
	})

	expect(needs.map((need) => need.key).sort()).toEqual([
		'pkg-a',
		'pkg-b',
		'pkg-c',
	])
	const sourceQueries = queries.filter((query) =>
		query.includes('FROM entity_sources'),
	)
	expect(sourceQueries).toEqual([
		'SELECT * FROM entity_sources WHERE id IN (?, ?, ?) AND deleted_at IS NULL',
	])
	expect(
		queries.filter((query) =>
			query.includes('FROM entity_sources WHERE id = ?'),
		),
	).toEqual([])
})

test('credential-needs dependency walk keeps a lone source as id = ?', async () => {
	const sqlite = new DatabaseSync(':memory:')
	createTables(sqlite)
	const userId = ownerIdFromStored('user-1')
	insertPackage(sqlite, {
		id: 'pkg-only',
		name: '@org/dep-only',
		sourceId: 'source-only',
		userId,
	})

	const queries: Array<string> = []
	const db = createD1FromSqlite(sqlite, { queries })
	const env = { APP_DB: db } as Env

	await computeCredentialNeedsClosure({
		env,
		userId,
		manifest: {
			name: '@org/root',
			exports: { '.': './index.js' },
			kody: { description: 'Root', credentials: {} },
		} as never,
		files: { 'index.ts': "import only from 'kody:@org/dep-only'" },
	})

	expect(
		queries.filter((query) => query.includes('FROM entity_sources')),
	).toEqual([
		'SELECT * FROM entity_sources WHERE id = ? AND deleted_at IS NULL',
	])
})
