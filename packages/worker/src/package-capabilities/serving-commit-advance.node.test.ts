import { DatabaseSync } from 'node:sqlite'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { updateEntitySource } from '#worker/repo/entity-sources.ts'
import { resolveInternetVisibleApprovedCommit } from '#app/package-app-internet-visible.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import { approvedCommitCache } from './approved-commit-cache.ts'
import {
	buildCapabilitySet,
	type CapabilitySetEntry,
} from './capability-set.ts'
import { insertPackageCapabilityApproval } from './capability-approvals-repo.ts'
import { emptyDependencySnapshot } from './dependency-snapshot.ts'
import { advanceServingCommit } from './serving-commit-advance.ts'

const compute = vi.hoisted(() => ({
	entriesByCommit: new Map<string, Array<unknown>>(),
}))

vi.mock('./compute-package-capability-set.ts', () => ({
	computePackageCapabilitySet: async (input: {
		packageId: string
		packageKodyId: string
		sourceId: string
		publishedCommit: string
	}) => {
		const entries = compute.entriesByCommit.get(input.publishedCommit)
		if (!entries)
			throw new Error(`no capability set for ${input.publishedCommit}`)
		return {
			capabilitySet: await buildCapabilitySet(
				entries as Array<CapabilitySetEntry>,
			),
			dependencySnapshot: emptyDependencySnapshot({
				packageId: input.packageId,
				kodyId: input.packageKodyId,
				sourceId: input.sourceId,
				publishedCommit: input.publishedCommit,
			}),
			declarations: { unboundNeeds: [], manifestFields: [] },
		}
	},
}))

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(
			await import('#worker/credentials/cached-migrations.test-support.ts')
		).withCachedMigrations(await importOriginal()),
)

const ownerId = ownerIdFromStored('org-owner')
const packageId = 'pkg-site'
const sourceId = 'source-site'
const now = '2026-11-14T00:00:00.000Z'

const storage: CapabilitySetEntry = {
	kind: 'storage',
	storageId: packageId,
	hosts: [],
	via: ['site'],
}
const mailCredential: CapabilitySetEntry = {
	kind: 'credential',
	credentialId: 'cred-mail',
	credentialKind: 'secret',
	hosts: ['api.mail.example'],
	placement: 'header',
	via: ['site'],
}

beforeEach(() => {
	compute.entriesByCommit.clear()
	approvedCommitCache.delete(packageId)
	vi.spyOn(console, 'warn').mockImplementation(() => {})
})

async function setUp(input: { approvedEntries?: Array<CapabilitySetEntry> }) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	sqlite
		.prepare(
			`INSERT INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, published_commit,
				serving_commit, manifest_path, source_root, created_at, updated_at
			) VALUES (?, ?, 'package', ?, 'repo-site', 'commit-a', 'commit-a',
				'package.json', '/', ?, ?)`,
		)
		.run(sourceId, ownerId, packageId, now, now)
	sqlite
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, source_id, has_app,
				is_internet_visible, created_at, updated_at
			) VALUES (?, ?, '@owner/site', 'site', 'A public site', ?, 1, 1, ?, ?)`,
		)
		.run(packageId, ownerId, sourceId, now, now)
	if (input.approvedEntries) {
		const approved = await buildCapabilitySet(input.approvedEntries)
		sqlite
			.prepare(
				`INSERT INTO package_capability_approvals (
					id, package_id, owner_user_id, published_commit, fingerprint,
					capability_set_json, dependency_snapshot_json,
					approved_by_user_id, approved_at, created_at, served_at
				) VALUES ('approval-a', ?, ?, 'commit-a', ?, ?, '{}', 'person-owner', ?, ?, ?)`,
			)
			.run(
				packageId,
				ownerId,
				approved.fingerprint,
				JSON.stringify(approved.entries),
				now,
				now,
				now,
			)
	}
	const env = { APP_DB: db } as unknown as Env
	const savedPackage = {
		id: packageId,
		userId: ownerId,
		sourceId,
		hasApp: true,
		isInternetVisible: true,
	} as SavedPackageRecord
	const publicCommit = async () => {
		approvedCommitCache.delete(packageId)
		return await resolveInternetVisibleApprovedCommit({
			env,
			lookup: { savedPackage, retired: false },
		})
	}
	const publish = async (commit: string) => {
		await updateEntitySource(db, {
			id: sourceId,
			userId: ownerId,
			publishedCommit: commit,
			manifestPath: 'package.json',
			sourceRoot: '/',
			externalCheckUntil: null,
		})
	}
	const approvalCommits = () =>
		sqlite
			.prepare(
				`SELECT published_commit FROM package_capability_approvals
				ORDER BY approved_at, published_commit`,
			)
			.all()
			.map((row) => row['published_commit'])
	const servingCommit = () =>
		sqlite
			.prepare('SELECT serving_commit FROM entity_sources WHERE id = ?')
			.get(sourceId)?.['serving_commit']
	return {
		db,
		env,
		sqlite,
		publicCommit,
		publish,
		approvalCommits,
		servingCommit,
	}
}

test('a republish with the same capabilities carries its approval forward with no gap', async () => {
	const site = await setUp({ approvedEntries: [storage, mailCredential] })
	compute.entriesByCommit.set('commit-b', [mailCredential, storage])

	// The pointer moves before the build finishes: visitors keep commit-a.
	await site.publish('commit-b')
	await expect(site.publicCommit()).resolves.toBe('commit-a')

	await expect(
		advanceServingCommit({
			env: site.env,
			sourceId,
			userId: ownerId,
			commit: 'commit-b',
		}),
	).resolves.toBe(true)
	expect(site.servingCommit()).toBe('commit-b')
	expect(site.approvalCommits()).toEqual(['commit-a', 'commit-b'])
	await expect(site.publicCommit()).resolves.toBe('commit-b')
})

test('a narrower republish is carried forward too', async () => {
	const site = await setUp({ approvedEntries: [storage, mailCredential] })
	compute.entriesByCommit.set('commit-b', [storage])
	await site.publish('commit-b')

	await advanceServingCommit({
		env: site.env,
		sourceId,
		userId: ownerId,
		commit: 'commit-b',
	})
	await expect(site.publicCommit()).resolves.toBe('commit-b')
})

test('a republish that asks for more keeps visitors on the approved version', async () => {
	const site = await setUp({ approvedEntries: [storage] })
	compute.entriesByCommit.set('commit-b', [storage, mailCredential])
	await site.publish('commit-b')

	await advanceServingCommit({
		env: site.env,
		sourceId,
		userId: ownerId,
		commit: 'commit-b',
	})
	// Members run commit-b; visitors keep commit-a until the owner approves.
	expect(site.servingCommit()).toBe('commit-b')
	expect(site.approvalCommits()).toEqual(['commit-a'])
	await expect(site.publicCommit()).resolves.toBe('commit-a')

	site.sqlite
		.prepare(
			`INSERT INTO package_capability_approvals (
				id, package_id, owner_user_id, published_commit, fingerprint,
				capability_set_json, dependency_snapshot_json,
				approved_by_user_id, approved_at, created_at
			) VALUES ('approval-b', ?, ?, 'commit-b', 'wider', '[]', '{}',
				'person-owner', '2026-11-14T00:10:00.000Z', '2026-11-14T00:10:00.000Z')`,
		)
		.run(packageId, ownerId)
	await expect(site.publicCommit()).resolves.toBe('commit-b')
})

test('a failed capability check advances serving but carries nothing forward', async () => {
	const site = await setUp({ approvedEntries: [storage] })
	await site.publish('commit-b')

	await advanceServingCommit({
		env: site.env,
		sourceId,
		userId: ownerId,
		commit: 'commit-b',
	})
	expect(site.servingCommit()).toBe('commit-b')
	await expect(site.publicCommit()).resolves.toBe('commit-a')
})

test('a superseded commit neither serves nor gets an approval', async () => {
	const site = await setUp({ approvedEntries: [storage] })
	compute.entriesByCommit.set('commit-b', [storage])
	await site.publish('commit-b')
	await site.publish('commit-c')

	await expect(
		advanceServingCommit({
			env: site.env,
			sourceId,
			userId: ownerId,
			commit: 'commit-b',
		}),
	).resolves.toBe(false)
	expect(site.servingCommit()).toBe('commit-a')
	expect(site.approvalCommits()).toEqual(['commit-a'])
	// commit-c is still building, so visitors keep commit-a.
	await expect(site.publicCommit()).resolves.toBe('commit-a')
})

test('an app approved for the first time keeps today’s behavior', async () => {
	const site = await setUp({})
	compute.entriesByCommit.set('commit-b', [storage])
	await site.publish('commit-b')

	await advanceServingCommit({
		env: site.env,
		sourceId,
		userId: ownerId,
		commit: 'commit-b',
	})
	expect(site.servingCommit()).toBe('commit-b')
	expect(site.approvalCommits()).toEqual([])
	await expect(site.publicCommit()).resolves.toBe(null)

	// The owner's first approval pins the serving commit.
	site.sqlite
		.prepare(
			`INSERT INTO package_capability_approvals (
				id, package_id, owner_user_id, published_commit, fingerprint,
				capability_set_json, dependency_snapshot_json,
				approved_by_user_id, approved_at, created_at
			) VALUES ('approval-b', ?, ?, 'commit-b', 'first', '[]', '{}',
				'person-owner', ?, ?)`,
		)
		.run(packageId, ownerId, now, now)
	await expect(site.publicCommit()).resolves.toBe('commit-b')
})

test('an approval for a commit superseded before it served never reaches visitors', async () => {
	const site = await setUp({ approvedEntries: [storage] })
	compute.entriesByCommit.set('commit-b', [storage])
	compute.entriesByCommit.set('commit-c', [storage, mailCredential])
	const approve = (commit: string, approvedAt: string) =>
		insertPackageCapabilityApproval(site.db, {
			id: `approval-${commit}`,
			package_id: packageId,
			owner_user_id: ownerId,
			published_commit: commit,
			fingerprint: `fingerprint-${commit}`,
			capability_set_json: '[]',
			dependency_snapshot_json: '{}',
			approved_by_user_id: 'person-owner',
			approved_at: approvedAt,
		})

	// The owner approves commit-b while it builds, then commit-c (wider and
	// unapproved) supersedes it before commit-b serves.
	await site.publish('commit-b')
	await approve('commit-b', '2026-11-14T00:05:00.000Z')
	await site.publish('commit-c')
	await expect(
		advanceServingCommit({
			env: site.env,
			sourceId,
			userId: ownerId,
			commit: 'commit-b',
		}),
	).resolves.toBe(false)
	await advanceServingCommit({
		env: site.env,
		sourceId,
		userId: ownerId,
		commit: 'commit-c',
	})
	expect(site.servingCommit()).toBe('commit-c')
	await expect(site.publicCommit()).resolves.toBe('commit-a')

	// Approving the serving commit marks it served at once.
	await approve('commit-c', '2026-11-14T00:10:00.000Z')
	await expect(site.publicCommit()).resolves.toBe('commit-c')
	const servedAt = (id: string) =>
		site.sqlite
			.prepare(
				'SELECT served_at FROM package_capability_approvals WHERE id = ?',
			)
			.get(id)?.['served_at']
	expect(servedAt('approval-commit-b')).toBeNull()
	expect(servedAt('approval-commit-c')).toBe('2026-11-14T00:10:00.000Z')
})

test('an approval recorded while its commit builds is marked served when it serves', async () => {
	const site = await setUp({ approvedEntries: [storage] })
	compute.entriesByCommit.set('commit-b', [storage, mailCredential])
	await site.publish('commit-b')
	await insertPackageCapabilityApproval(site.db, {
		id: 'approval-b',
		package_id: packageId,
		owner_user_id: ownerId,
		published_commit: 'commit-b',
		fingerprint: 'wider',
		capability_set_json: '[]',
		dependency_snapshot_json: '{}',
		approved_by_user_id: 'person-owner',
		approved_at: '2026-11-14T00:05:00.000Z',
	})
	// Still building: visitors stay on commit-a.
	await expect(site.publicCommit()).resolves.toBe('commit-a')
	await advanceServingCommit({
		env: site.env,
		sourceId,
		userId: ownerId,
		commit: 'commit-b',
	})
	await expect(site.publicCommit()).resolves.toBe('commit-b')

	// A later wider republish that serves unapproved falls back to commit-b,
	// the commit that served most recently.
	compute.entriesByCommit.set('commit-c', [storage, mailCredential])
	await site.publish('commit-c')
	await advanceServingCommit({
		env: site.env,
		sourceId,
		userId: ownerId,
		commit: 'commit-c',
	})
	expect(site.servingCommit()).toBe('commit-c')
	await expect(site.publicCommit()).resolves.toBe('commit-b')
})

test('approving a first build before it serves does not mark it served', async () => {
	const site = await setUp({})
	site.sqlite
		.prepare('UPDATE entity_sources SET serving_commit = NULL WHERE id = ?')
		.run(sourceId)
	await insertPackageCapabilityApproval(site.db, {
		id: 'approval-first',
		package_id: packageId,
		owner_user_id: ownerId,
		published_commit: 'commit-a',
		fingerprint: 'first',
		capability_set_json: '[]',
		dependency_snapshot_json: '{}',
		approved_by_user_id: 'person-owner',
		approved_at: now,
	})
	expect(
		site.sqlite
			.prepare(
				"SELECT served_at FROM package_capability_approvals WHERE id = 'approval-first'",
			)
			.get()?.['served_at'],
	).toBeNull()
})

test('a commit that serves again counts as the most recently served', async () => {
	const site = await setUp({ approvedEntries: [storage] })
	compute.entriesByCommit.set('commit-a', [storage])
	compute.entriesByCommit.set('commit-b', [storage])
	compute.entriesByCommit.set('commit-c', [storage, mailCredential])
	const serve = async (commit: string) => {
		await site.publish(commit)
		await advanceServingCommit({
			env: site.env,
			sourceId,
			userId: ownerId,
			commit,
		})
		expect(site.servingCommit()).toBe(commit)
	}
	await serve('commit-b')
	await new Promise((resolve) => setTimeout(resolve, 5))
	await serve('commit-a')
	await serve('commit-c')
	await expect(site.publicCommit()).resolves.toBe('commit-a')
})
