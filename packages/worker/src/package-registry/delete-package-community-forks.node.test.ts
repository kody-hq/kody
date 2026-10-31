import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { communityForksDeleteCascadeStatements } from '#worker/community/community-forks-delete-cascade.ts'
import { insertCommunityFork } from '#worker/community/repo.ts'
import { resolveViewerListingInstalls } from '#worker/community/viewer-install.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'

const mockModule = vi.hoisted(() => ({
	cleanupArtifactReposForPackage: vi.fn(),
	deleteEntitySource: vi.fn(),
	deleteJobRow: vi.fn(),
	listJobRowsByUserId: vi.fn(),
	syncJobManagerAlarm: vi.fn(),
	deleteSavedPackageVector: vi.fn(),
	deleteAllPackageScopedSecrets: vi.fn(),
	removeAllSecretApprovalsForPackage: vi.fn(),
	clearStorage: vi.fn(async () => ({ ok: true as const })),
	storageRunnerRpc: vi.fn(),
	unpublishCommunityListing: vi.fn(),
}))

vi.mock('#worker/storage-runner.ts', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return {
		...actual,
		storageRunnerRpc: (...args: Array<unknown>) => {
			mockModule.storageRunnerRpc(...args)
			return { clearStorage: mockModule.clearStorage }
		},
	}
})

vi.mock('#worker/package-config-cleanup.ts', () => ({
	deleteAllPackageScopedSecrets: mockModule.deleteAllPackageScopedSecrets,
	removeAllSecretApprovalsForPackage:
		mockModule.removeAllSecretApprovalsForPackage,
}))

vi.mock('./vectorize.ts', () => ({
	deleteSavedPackageVector: mockModule.deleteSavedPackageVector,
	upsertSavedPackageVector: vi.fn(),
}))

vi.mock('#worker/jobs/jobs-data.ts', () => ({
	jobsData: () => ({
		deleteJob: mockModule.deleteJobRow,
		listJobsForUser: mockModule.listJobRowsByUserId,
	}),
}))

vi.mock('#worker/jobs/manager-client.ts', () => ({
	syncJobManagerAlarm: mockModule.syncJobManagerAlarm,
}))

vi.mock('#worker/repo/artifact-repo-cleanup.ts', () => ({
	cleanupArtifactReposForPackage: mockModule.cleanupArtifactReposForPackage,
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	deleteEntitySource: mockModule.deleteEntitySource,
}))

vi.mock('#worker/community/service.ts', () => ({
	unpublishCommunityListing: mockModule.unpublishCommunityListing,
}))

vi.mock('#worker/community/repo.ts', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return {
		...actual,
		getCommunityListingByOwnerAndPackage: vi.fn(async () => null),
	}
})

const { deleteSavedPackageProjection } = await import('./service.ts')

const listingRef = {
	id: 'listing-plaid',
	kodyId: 'plaid',
	pinnedCommit: 'commit-new',
}

function createDeleteForkDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE users (
			stable_user_id TEXT PRIMARY KEY NOT NULL,
			personal_org_id TEXT,
			deleting_at TEXT,
			deleted_at TEXT
		);
		CREATE TABLE orgs (
			id TEXT PRIMARY KEY NOT NULL,
			slug TEXT NOT NULL UNIQUE,
			access_epoch INTEGER NOT NULL DEFAULT 0,
			deleted_at TEXT,
			deleting_at TEXT,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		);
		CREATE TABLE saved_packages (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			kody_id TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
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

			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		);
		CREATE TABLE package_app_rate_limits (
			bucket_key TEXT PRIMARY KEY,
			window_start INTEGER NOT NULL,
			count INTEGER NOT NULL
		);
		CREATE TABLE entity_sources (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			entity_kind TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			deleted_at TEXT
		);
		CREATE TABLE community_forks (
			id TEXT PRIMARY KEY NOT NULL,
			listing_id TEXT, upstream_owner_id TEXT, upstream_package_id TEXT,
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
		CREATE TABLE package_kody_id_redirects (
			user_id TEXT NOT NULL,
			old_kody_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			PRIMARY KEY (user_id, old_kody_id)
		);
		CREATE TABLE package_slug_redirects (
			user_id TEXT NOT NULL,
			old_slug TEXT NOT NULL,
			package_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			PRIMARY KEY (user_id, old_slug)
		);
		CREATE TABLE credential_mappings (
			org_id TEXT NOT NULL,
			package_id TEXT NOT NULL
		);
		CREATE TABLE user_storage_buckets (
			user_id TEXT NOT NULL,
			storage_id TEXT NOT NULL,
			kind TEXT NOT NULL DEFAULT 'package',
			deleted_at TEXT
		);
		${communityForksDeleteCascadeStatements.join(';\n')}
	`)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function forkInput(
	id: string,
	forkerUserId: string,
	packageId: string,
	sourceId: string,
	targetKodyId: string,
) {
	return {
		id,
		listing_id: listingRef.id,
		forker_user_id: forkerUserId,
		origin_commit: 'commit-old',
		forked_package_id: packageId,
		forked_source_id: sourceId,
		target_kody_id: targetKodyId,
		listing_name: '@kody/plaid',
		listing_kody_id: 'plaid',
	}
}

function viewerFork(packageId: string, sourceId: string, targetKodyId: string) {
	return {
		listingId: listingRef.id,
		targetKodyId,
		forkedPackageId: packageId,
		forkedSourceId: sourceId,
		createdAt: '2026-08-13T00:00:00.000Z',
		originCommit: 'commit-old',
	}
}

function resolveKentInstall(input: {
	savedPackages: Parameters<
		typeof resolveViewerListingInstalls
	>[0]['savedPackages']
	forks: Array<ReturnType<typeof viewerFork>>
}) {
	return resolveViewerListingInstalls({
		listings: [listingRef],
		packageScope: 'kentcdodds',
		listingPinIsAncestorByListingId: new Map([[listingRef.id, false]]),
		...input,
	}).get(listingRef.id)
}

test('package delete removes community_forks so Fork outdated does not linger', async () => {
	const { db } = createDeleteForkDb()
	const run = (sql: string) => db.prepare(sql).run()
	const forkExists = async (id: string) =>
		(await db
			.prepare(`SELECT id FROM community_forks WHERE id = ?`)
			.bind(id)
			.first()) !== null
	const env = {
		APP_DB: db,
		USER_METER: createInMemoryUserMeterEnv().env.USER_METER,
	} as Env
	await run(
		`INSERT INTO users (stable_user_id, deleting_at) VALUES ('user-kent', NULL)`,
	)
	await run(
		`INSERT INTO entity_sources (id, user_id, entity_kind, entity_id)
		VALUES ('source-live', 'user-kent', 'package', 'package-live'),
			('source-inert', 'user-kent', 'package', 'package-inert'),
			('source-other', 'user-other', 'package', 'package-other')`,
	)
	await run(
		`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
		VALUES ('package-live', 'user-kent', '@kentcdodds/plaid', 'plaid', 'Kent copy', 'source-live')`,
	)
	for (const fork of [
		forkInput('fork-live', 'user-kent', 'package-live', 'source-live', 'plaid'),
		forkInput(
			'fork-inert',
			'user-kent',
			'package-inert',
			'source-inert',
			'plaid-inert',
		),
		forkInput(
			'fork-other',
			'user-other',
			'package-other',
			'source-other',
			'plaid',
		),
	]) {
		await insertCommunityFork(db, fork)
	}

	expect(
		resolveKentInstall({
			savedPackages: [
				{
					id: 'package-live',
					kodyId: 'plaid',
					name: '@kentcdodds/plaid',
					sourceId: 'source-live',
				},
			],
			forks: [viewerFork('package-live', 'source-live', 'plaid')],
		}),
	).toMatchObject({
		status: 'installed',
		listingAhead: true,
		packageId: 'package-live',
	})

	mockModule.cleanupArtifactReposForPackage.mockResolvedValue(0)
	mockModule.deleteEntitySource.mockResolvedValue(true)
	mockModule.listJobRowsByUserId.mockResolvedValue([])
	for (const cleanup of [
		mockModule.deleteSavedPackageVector,
		mockModule.deleteAllPackageScopedSecrets,
		mockModule.removeAllSecretApprovalsForPackage,
	]) {
		cleanup.mockResolvedValue(undefined)
	}

	await deleteSavedPackageProjection({
		env,
		userId: ownerIdFromStored('user-kent'),
		packageId: 'package-live',
		audit: null,
	})

	const remaining = await db
		.prepare(
			`SELECT id, forker_user_id, forked_package_id FROM community_forks ORDER BY id`,
		)
		.all<{ id: string; forker_user_id: string; forked_package_id: string }>()
	expect(remaining.results).toEqual([
		{
			id: 'fork-inert',
			forker_user_id: 'user-kent',
			forked_package_id: 'package-inert',
		},
		{
			id: 'fork-other',
			forker_user_id: 'user-other',
			forked_package_id: 'package-other',
		},
	])
	expect(
		await db
			.prepare(`SELECT id FROM saved_packages WHERE id = 'package-live'`)
			.first(),
	).toBeNull()
	expect(
		resolveKentInstall({
			savedPackages: [],
			forks: [viewerFork('package-inert', 'source-inert', 'plaid-inert')],
		}),
	).toMatchObject({
		status: 'adaptation_required',
		targetName: '@kentcdodds/plaid-inert',
		packageId: null,
	})

	await run(
		`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
		VALUES ('package-trigger', 'user-kent', '@kentcdodds/plaid-trigger', 'plaid-trigger', 'Trigger copy', 'source-trigger')`,
	)
	await insertCommunityFork(
		db,
		forkInput(
			'fork-trigger-package',
			'user-kent',
			'package-trigger',
			'source-trigger',
			'plaid-trigger',
		),
	)
	await run(`DELETE FROM saved_packages WHERE id = 'package-trigger'`)
	expect(await forkExists('fork-trigger-package')).toBe(false)

	await run(
		`INSERT INTO entity_sources (id, user_id, entity_kind, entity_id)
		VALUES ('source-trigger-2', 'user-kent', 'package', 'package-gone')`,
	)
	await insertCommunityFork(
		db,
		forkInput(
			'fork-trigger-source',
			'user-kent',
			'package-gone',
			'source-trigger-2',
			'plaid-source',
		),
	)
	await run(`DELETE FROM entity_sources WHERE id = 'source-trigger-2'`)
	expect(await forkExists('fork-trigger-source')).toBe(false)
})
