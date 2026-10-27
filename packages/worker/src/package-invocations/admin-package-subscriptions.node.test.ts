import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	buildPackageSubscriptionTopicMapKey,
	refreshPackageSubscriptionTopicMap,
} from './subscription-topic-cache.ts'

const mocks = vi.hoisted(() => ({
	listSavedPackagesByUserId: vi.fn(),
	listSavedPackagesByIds: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: mocks.listSavedPackagesByUserId,
	listSavedPackagesByIds: mocks.listSavedPackagesByIds,
}))

vi.mock('#worker/repo/published-source.ts', () => ({
	loadPublishedEntitySource: vi.fn(),
	loadPublishedEntityManifest: vi.fn(async (input: { sourceId: string }) => ({
		content: JSON.stringify({
			name: `@user/${input.sourceId}`,
			exports: { '.': './index.js' },
			kody: {
				id: input.sourceId,
				description: 'Discovery fixture',
				subscriptions: {
					'repo.pushed': {
						handler: './src/on-push.ts',
					},
				},
			},
		}),
	})),
}))

const { loadMatchingPackageSubscriptions } =
	await import('./admin-package-subscriptions.ts')

function createEntitySourcesTable(sqlite: DatabaseSync) {
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
}

function insertSource(
	sqlite: DatabaseSync,
	input: { id: string; userId: string },
) {
	sqlite
		.prepare(
			`INSERT INTO entity_sources VALUES
				(?, ?, 'package', ?, ?, 'commit-1', NULL,
				'package.json', '/', NULL, NULL, NULL,
				'2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z')`,
		)
		.run(input.id, input.userId, `package-${input.id}`, `repo-${input.id}`)
}

function createKv() {
	const store = new Map<string, string>()
	const kv = {
		get: vi.fn(async (key: string, typeOrOpts?: 'json' | { type?: string }) => {
			const value = store.get(key) ?? null
			const asJson =
				typeOrOpts === 'json' ||
				(typeof typeOrOpts === 'object' && typeOrOpts?.type === 'json')
			return asJson && value ? JSON.parse(value) : value
		}),
		put: vi.fn(async (key: string, value: string) => {
			store.set(key, value)
		}),
		delete: vi.fn(async (key: string) => {
			store.delete(key)
		}),
	} as unknown as KVNamespace
	return { store, kv }
}

function savedPackage(input: { id: string; sourceId: string; userId: string }) {
	return {
		id: input.id,
		userId: input.userId,
		name: `@user/${input.id}`,
		kodyId: input.id,
		description: input.id,
		tags: [],
		searchText: null,
		sourceId: input.sourceId,
		hasApp: false,
		hidden: false,
		isPrivate: true,
		isInternetVisible: false,
		lockedAt: null,
		createdAt: '2026-10-02T00:00:00.000Z',
		updatedAt: '2026-10-02T00:00:00.000Z',
		topics: [] as Array<string>,
	}
}

test('discovery over 12 packages issues one entity_sources IN query', async () => {
	const userId = ownerIdFromStored('user-1')
	const sqlite = new DatabaseSync(':memory:')
	createEntitySourcesTable(sqlite)
	const packages = Array.from({ length: 12 }, (_, index) => {
		const id = `pkg-${index}`
		const sourceId = `source-${index}`
		insertSource(sqlite, { id: sourceId, userId })
		return savedPackage({ id, sourceId, userId })
	})
	mocks.listSavedPackagesByUserId.mockResolvedValue(packages)

	const queries: Array<string> = []
	const db = createD1FromSqlite(sqlite, { queries })
	const { kv, store } = createKv()
	const env = {
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: kv,
	} as Env

	const loaded = await loadMatchingPackageSubscriptions({
		env,
		baseUrl: 'https://heykody.dev',
		userId,
		topic: 'repo.pushed',
	})

	expect(loaded.discoveryErrors).toEqual([])
	expect(loaded.subscriptions).toHaveLength(12)
	expect(store.has(buildPackageSubscriptionTopicMapKey(userId))).toBe(true)

	const sourceQueries = queries.filter((query) =>
		query.includes('FROM entity_sources'),
	)
	expect(sourceQueries).toEqual([
		'SELECT * FROM entity_sources WHERE id IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) AND deleted_at IS NULL',
	])
})

test('topic-map refresh over 12 packages issues one entity_sources IN query', async () => {
	const userId = ownerIdFromStored('user-1')
	const sqlite = new DatabaseSync(':memory:')
	createEntitySourcesTable(sqlite)
	const packages = Array.from({ length: 12 }, (_, index) => {
		const id = `pkg-${index}`
		const sourceId = `source-${index}`
		insertSource(sqlite, { id: sourceId, userId })
		return savedPackage({ id, sourceId, userId })
	})
	mocks.listSavedPackagesByUserId.mockResolvedValue(packages)

	const queries: Array<string> = []
	const db = createD1FromSqlite(sqlite, { queries })
	const { kv, store } = createKv()
	const env = {
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: kv,
	} as Env

	const refreshed = await refreshPackageSubscriptionTopicMap({
		env,
		baseUrl: 'https://heykody.dev',
		userId,
	})

	expect(refreshed?.byTopic['repo.pushed']).toHaveLength(12)
	expect(store.has(buildPackageSubscriptionTopicMapKey(userId))).toBe(true)

	const sourceQueries = queries.filter((query) =>
		query.includes('FROM entity_sources'),
	)
	expect(sourceQueries).toEqual([
		'SELECT * FROM entity_sources WHERE id IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) AND deleted_at IS NULL',
	])
})

test('missing source row yields a discovery error without filling the KV map', async () => {
	consoleWarn.mockImplementation(() => {})
	const userId = ownerIdFromStored('user-1')
	const sqlite = new DatabaseSync(':memory:')
	createEntitySourcesTable(sqlite)
	insertSource(sqlite, { id: 'source-ok', userId })
	const packages = [
		savedPackage({ id: 'pkg-ok', sourceId: 'source-ok', userId }),
		savedPackage({ id: 'pkg-missing', sourceId: 'source-missing', userId }),
	]
	mocks.listSavedPackagesByUserId.mockResolvedValue(packages)

	const queries: Array<string> = []
	const db = createD1FromSqlite(sqlite, { queries })
	const { kv, store } = createKv()
	const env = {
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: kv,
	} as Env

	const loaded = await loadMatchingPackageSubscriptions({
		env,
		baseUrl: 'https://heykody.dev',
		userId,
		topic: 'repo.pushed',
	})

	expect(loaded.subscriptions.map((entry) => entry.savedPackage.id)).toEqual([
		'pkg-ok',
	])
	expect(loaded.discoveryErrors).toHaveLength(1)
	expect(String(loaded.discoveryErrors[0])).toContain(
		'Saved package source "source-missing" was not found.',
	)
	expect(store.has(buildPackageSubscriptionTopicMapKey(userId))).toBe(false)
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-package-subscription-manifest-load-failed',
		expect.objectContaining({
			packageId: 'pkg-missing',
			sourceId: 'source-missing',
		}),
	)

	const sourceQueries = queries.filter((query) =>
		query.includes('FROM entity_sources'),
	)
	expect(sourceQueries).toEqual([
		'SELECT * FROM entity_sources WHERE id IN (?, ?) AND deleted_at IS NULL',
	])
})
