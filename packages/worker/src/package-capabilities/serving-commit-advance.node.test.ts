import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { updateEntitySource } from '#worker/repo/entity-sources.ts'
import {
	PackageServingUpdateQueue,
	type PackageServingUpdate,
} from '#worker/repo/package-serving-update.ts'
import { resolveInternetVisibleApprovedCommit } from '#app/package-app-internet-visible.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import { approvedCommitCache } from './approved-commit-cache.ts'
import {
	buildCapabilitySet,
	type CapabilitySetEntry,
} from './capability-set.ts'
import { insertPackageCapabilityApproval } from './capability-approvals-repo.ts'
import { emptyDependencySnapshot } from './dependency-snapshot.ts'
import {
	heldForApprovalFromSource,
	listHeldForApprovalPackages,
	loadHeldForApproval,
} from './held-for-approval.ts'
import { approvePackageCapabilitySet } from './capability-approval-service.ts'
import {
	advanceServingCommit,
	releaseHeldServingCommit,
} from './serving-commit-advance.ts'

const projection = vi.hoisted(() => ({
	refreshSavedPackageProjection: vi.fn(async () => undefined),
}))

vi.mock('#worker/package-registry/service.ts', () => projection)

const jobs = vi.hoisted(() => ({
	syncPublishedPackageJobs: vi.fn(async (_input: unknown) => false),
}))

vi.mock('#worker/jobs/service.ts', () => jobs)

const ownerNotice = vi.hoisted(() => ({
	notifyOwnersOfHeldPublish: vi.fn(async (_input: unknown) => ({
		recipients: 1,
		delivered: 1,
	})),
}))

vi.mock('./held-for-approval-notice.ts', () => ownerNotice)

const compute = vi.hoisted(() => ({
	entriesByCommit: new Map<string, Array<unknown>>(),
	onCompute: undefined as undefined | ((commit: string) => Promise<void>),
}))

vi.mock('./compute-package-capability-set.ts', () => ({
	computePackageCapabilitySet: async (input: {
		packageId: string
		packageKodyId: string
		sourceId: string
		publishedCommit: string
	}) => {
		await compute.onCompute?.(input.publishedCommit)
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
	compute.onCompute = undefined
	projection.refreshSavedPackageProjection.mockClear()
	ownerNotice.notifyOwnersOfHeldPublish.mockClear()
	jobs.syncPublishedPackageJobs.mockReset()
	jobs.syncPublishedPackageJobs.mockResolvedValue(false)
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
	const queue = new PackageServingUpdateQueue()
	const env = {
		APP_DB: db,
		REPO_SESSION: {
			idFromName: (name: string) => name,
			get: () => ({
				updatePackageServing: (update: PackageServingUpdate) =>
					queue.run(env, update),
			}),
		},
	} as unknown as Env
	const savedPackage = {
		id: packageId,
		userId: ownerId,
		kodyId: 'site',
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
	const heldCommit = () =>
		sqlite
			.prepare('SELECT held_commit FROM entity_sources WHERE id = ?')
			.get(sourceId)?.['held_commit']
	// The owner approves the live capability set from the approval page.
	const approveLive = async () => {
		const commit = sqlite
			.prepare('SELECT published_commit FROM entity_sources WHERE id = ?')
			.get(sourceId)?.['published_commit']
		const entries = compute.entriesByCommit.get(String(commit))
		const capabilitySet = await buildCapabilitySet(
			(entries ?? []) as Array<CapabilitySetEntry>,
		)
		await approvePackageCapabilitySet({
			env,
			ownerUserId: ownerId,
			actorUserId: 'person-owner',
			savedPackage,
			requestUrl: 'https://kody.test/',
			expectedFingerprint: capabilitySet.fingerprint,
			recordPin: true,
		})
	}
	// Members, the owner and jobs read the serving commit; anonymous
	// visitors read the approved commit. On an internet-visible app they
	// must always match.
	const expectEveryoneOn = async (commit: string) => {
		expect(servingCommit()).toBe(commit)
		await expect(publicCommit()).resolves.toBe(commit)
	}
	return {
		heldCommit,
		approveLive,
		expectEveryoneOn,
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
	// Publish already projected commit-b; nothing needs settling.
	expect(projection.refreshSavedPackageProjection).not.toHaveBeenCalled()
})

test('a wider republish holds everyone on the approved version until it is approved', async () => {
	const site = await setUp({ approvedEntries: [storage] })
	compute.entriesByCommit.set('commit-b', [storage, mailCredential])
	await site.publish('commit-b')

	await expect(
		advanceServingCommit({
			env: site.env,
			sourceId,
			userId: ownerId,
			commit: 'commit-b',
		}),
	).resolves.toBe(false)
	// Members, the owner and visitors all keep commit-a.
	await site.expectEveryoneOn('commit-a')
	expect(site.heldCommit()).toBe('commit-b')
	expect(site.approvalCommits()).toEqual(['commit-a'])
	// Jobs, subscriptions and skills settle back to the commit everyone runs.
	expect(projection.refreshSavedPackageProjection).toHaveBeenCalledTimes(1)
	expect(projection.refreshSavedPackageProjection).toHaveBeenCalledWith(
		expect.objectContaining({
			packageId,
			sourceId,
			rebuildArtifacts: false,
		}),
	)
	projection.refreshSavedPackageProjection.mockClear()
	// Held: no job is added, removed, or rewritten.
	expect(jobs.syncPublishedPackageJobs).not.toHaveBeenCalled()

	// A rebuild of the held commit keeps holding it without a new check.
	compute.entriesByCommit.delete('commit-b')
	await advanceServingCommit({
		env: site.env,
		sourceId,
		userId: ownerId,
		commit: 'commit-b',
	})
	await site.expectEveryoneOn('commit-a')

	// Approving releases everyone to commit-b at once, definitions included.
	compute.entriesByCommit.set('commit-b', [storage, mailCredential])
	projection.refreshSavedPackageProjection.mockClear()
	await site.approveLive()
	await site.expectEveryoneOn('commit-b')
	expect(site.heldCommit()).toBeNull()
	expect(projection.refreshSavedPackageProjection).toHaveBeenCalledTimes(1)
	// Jobs switch with the code, enabled as the approver.
	expect(jobs.syncPublishedPackageJobs).toHaveBeenCalledWith(
		expect.objectContaining({
			packageId,
			sourceId,
			commit: 'commit-b',
			actorUserId: 'person-owner',
		}),
	)
})

test('a job sync that fails on approval keeps the hold so approving again releases it', async () => {
	const site = await setUp({ approvedEntries: [storage] })
	compute.entriesByCommit.set('commit-b', [storage, mailCredential])
	await site.publish('commit-b')
	await advanceServingCommit({
		env: site.env,
		sourceId,
		userId: ownerId,
		commit: 'commit-b',
	})
	jobs.syncPublishedPackageJobs.mockRejectedValueOnce(new Error('d1 busy'))

	await expect(site.approveLive()).rejects.toThrow('d1 busy')
	await site.expectEveryoneOn('commit-a')
	expect(site.heldCommit()).toBe('commit-b')

	await site.approveLive()
	await site.expectEveryoneOn('commit-b')
	expect(site.heldCommit()).toBeNull()
})

test('a newer publish waits for an overlapping job sync and is the only commit that serves', async () => {
	const site = await setUp({})
	const started = Promise.withResolvers<void>()
	const finish = Promise.withResolvers<boolean>()
	const advance = (commit: string) =>
		advanceServingCommit({ env: site.env, sourceId, userId: ownerId, commit })
	jobs.syncPublishedPackageJobs.mockImplementationOnce(async () => {
		started.resolve()
		return await finish.promise
	})
	await site.publish('commit-b')
	const older = advance('commit-b')
	await started.promise

	await site.publish('commit-c')
	const newer = advance('commit-c')
	await new Promise<void>((resolve) => setImmediate(resolve))
	expect(jobs.syncPublishedPackageJobs).toHaveBeenCalledTimes(1)
	expect(site.servingCommit()).toBe('commit-a')
	finish.resolve(true)

	await expect(older).resolves.toBe(false)
	await expect(newer).resolves.toBe(true)
	expect(jobs.syncPublishedPackageJobs).toHaveBeenNthCalledWith(
		2,
		expect.objectContaining({ commit: 'commit-c' }),
	)
	expect(site.servingCommit()).toBe('commit-c')
})

test('an approval that lands while a wider build is being checked still releases it', async () => {
	const site = await setUp({ approvedEntries: [storage] })
	compute.entriesByCommit.set('commit-b', [storage, mailCredential])
	await site.publish('commit-b')
	let approving = false
	compute.onCompute = async () => {
		if (approving) return
		approving = true
		await site.approveLive()
	}

	await expect(
		advanceServingCommit({
			env: site.env,
			sourceId,
			userId: ownerId,
			commit: 'commit-b',
		}),
	).resolves.toBe(true)
	await site.expectEveryoneOn('commit-b')
	expect(site.heldCommit()).toBeNull()
})

test('turning internet-visible off releases a held republish', async () => {
	const site = await setUp({ approvedEntries: [storage] })
	compute.entriesByCommit.set('commit-b', [storage, mailCredential])
	await site.publish('commit-b')
	await advanceServingCommit({
		env: site.env,
		sourceId,
		userId: ownerId,
		commit: 'commit-b',
	})
	expect(site.servingCommit()).toBe('commit-a')

	site.sqlite
		.prepare('UPDATE saved_packages SET is_internet_visible = 0 WHERE id = ?')
		.run(packageId)
	await expect(
		releaseHeldServingCommit({ env: site.env, sourceId, userId: ownerId }),
	).resolves.toBe(true)
	expect(site.servingCommit()).toBe('commit-b')
	expect(site.heldCommit()).toBeNull()
	expect(projection.refreshSavedPackageProjection).toHaveBeenCalledTimes(2)
})

test('an app that is not internet-visible serves a wider republish right away', async () => {
	const site = await setUp({ approvedEntries: [storage] })
	site.sqlite
		.prepare('UPDATE saved_packages SET is_internet_visible = 0 WHERE id = ?')
		.run(packageId)
	compute.entriesByCommit.set('commit-b', [storage, mailCredential])
	await site.publish('commit-b')
	await expect(
		advanceServingCommit({
			env: site.env,
			sourceId,
			userId: ownerId,
			commit: 'commit-b',
		}),
	).resolves.toBe(true)
	expect(site.servingCommit()).toBe('commit-b')
	expect(site.heldCommit()).toBeNull()
})

test('members never run a different commit from the public across republishes', async () => {
	const site = await setUp({ approvedEntries: [storage, mailCredential] })
	const republish = async (commit: string, entries: Array<unknown>) => {
		compute.entriesByCommit.set(commit, entries)
		await site.publish(commit)
		// Building: nobody moves yet.
		await site.expectEveryoneOn(String(site.servingCommit()))
		await advanceServingCommit({
			env: site.env,
			sourceId,
			userId: ownerId,
			commit,
		})
	}
	await republish('commit-b', [storage])
	await site.expectEveryoneOn('commit-b')
	await republish('commit-c', [storage, mailCredential])
	await site.expectEveryoneOn('commit-b')
	// A newer narrower publish replaces the hold and goes live for everyone.
	await republish('commit-d', [storage])
	await site.expectEveryoneOn('commit-d')
	expect(site.heldCommit()).toBeNull()
	await republish('commit-e', [storage, mailCredential])
	await site.expectEveryoneOn('commit-d')
	await site.approveLive()
	await site.expectEveryoneOn('commit-e')
})

test('a failed capability check holds everyone on the approved version', async () => {
	const site = await setUp({ approvedEntries: [storage] })
	await site.publish('commit-b')

	await advanceServingCommit({
		env: site.env,
		sourceId,
		userId: ownerId,
		commit: 'commit-b',
	})
	await site.expectEveryoneOn('commit-a')
	expect(site.heldCommit()).toBe('commit-b')
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
	// Everyone stays on commit-a, the last approved commit that served.
	await site.expectEveryoneOn('commit-a')
	expect(site.heldCommit()).toBe('commit-c')

	// Approving commit-c releases it and marks it served.
	await approve('commit-c', '2026-11-14T00:10:00.000Z')
	await releaseHeldServingCommit({
		env: site.env,
		sourceId,
		userId: ownerId,
	})
	await site.expectEveryoneOn('commit-c')
	const servedAt = (id: string) =>
		site.sqlite
			.prepare(
				'SELECT served_at FROM package_capability_approvals WHERE id = ?',
			)
			.get(id)?.['served_at']
	expect(servedAt('approval-commit-b')).toBeNull()
	expect(servedAt('approval-commit-c')).toEqual(expect.any(String))
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
	await site.expectEveryoneOn('commit-b')
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
	await site.publish('commit-c')
	await advanceServingCommit({
		env: site.env,
		sourceId,
		userId: ownerId,
		commit: 'commit-c',
	})
	await site.expectEveryoneOn('commit-a')
})

test('the owner is told everyone is held only while a wider republish waits', async () => {
	const held = (env: Env) =>
		loadHeldForApproval({ env, packageId, ownerUserId: ownerId })

	const firstTime = await setUp({})
	await expect(held(firstTime.env)).resolves.toBe(null)

	const same = await setUp({ approvedEntries: [storage] })
	compute.entriesByCommit.set('commit-b', [storage])
	await same.publish('commit-b')
	await advanceServingCommit({
		env: same.env,
		sourceId,
		userId: ownerId,
		commit: 'commit-b',
	})
	await expect(held(same.env)).resolves.toBe(null)

	const wider = await setUp({ approvedEntries: [storage] })
	compute.entriesByCommit.set('commit-b', [storage, mailCredential])
	await wider.publish('commit-b')
	// Still building: nothing is held yet.
	await expect(held(wider.env)).resolves.toBe(null)
	await advanceServingCommit({
		env: wider.env,
		sourceId,
		userId: ownerId,
		commit: 'commit-b',
	})
	await expect(held(wider.env)).resolves.toEqual({
		servingCommit: 'commit-a',
		heldCommit: 'commit-b',
	})

	wider.sqlite
		.prepare('UPDATE saved_packages SET is_internet_visible = 0 WHERE id = ?')
		.run(packageId)
	await expect(held(wider.env)).resolves.toBe(null)
	wider.sqlite
		.prepare('UPDATE saved_packages SET is_internet_visible = 1 WHERE id = ?')
		.run(packageId)

	// A newer publish that is still building replaces the notice.
	await wider.publish('commit-c')
	await expect(held(wider.env)).resolves.toBe(null)
	await wider.publish('commit-b')

	await wider.approveLive()
	await expect(held(wider.env)).resolves.toBe(null)
})

test('the owners are told once when a commit is held, whoever caused the publish', async () => {
	const site = await setUp({ approvedEntries: [storage] })
	const advance = (commit: string) =>
		advanceServingCommit({
			env: site.env,
			sourceId,
			userId: ownerId,
			commit,
			// An automatic republish or a teammate, not the package owner.
			actor: { userId: personIdFromStored('person-someone-else') },
		})

	// A republish that serves right away notifies nobody.
	compute.entriesByCommit.set('commit-b', [storage])
	await site.publish('commit-b')
	await advance('commit-b')
	expect(ownerNotice.notifyOwnersOfHeldPublish).not.toHaveBeenCalled()

	compute.entriesByCommit.set('commit-c', [storage, mailCredential])
	await site.publish('commit-c')
	await advance('commit-c')
	expect(ownerNotice.notifyOwnersOfHeldPublish).toHaveBeenCalledTimes(1)
	expect(ownerNotice.notifyOwnersOfHeldPublish).toHaveBeenCalledWith({
		env: site.env,
		ownerUserId: ownerId,
		packageId,
	})

	// Rebuilding the same held commit does not send a second notice.
	await advance('commit-c')
	expect(ownerNotice.notifyOwnersOfHeldPublish).toHaveBeenCalledTimes(1)

	// A newer commit that is held too is a new thing to approve.
	compute.entriesByCommit.set('commit-d', [storage, mailCredential])
	await site.publish('commit-d')
	await advance('commit-d')
	expect(ownerNotice.notifyOwnersOfHeldPublish).toHaveBeenCalledTimes(2)
})

test('the held list names the serving and held commits until approval clears it', async () => {
	const site = await setUp({ approvedEntries: [storage] })
	const packages = [
		{
			id: packageId,
			name: '@owner/site',
			kodyId: 'site',
			sourceId,
			hasApp: true,
			isInternetVisible: true,
		},
	]
	await expect(listHeldForApprovalPackages(site.db, packages)).resolves.toEqual(
		[],
	)

	compute.entriesByCommit.set('commit-b', [storage, mailCredential])
	await site.publish('commit-b')
	await advanceServingCommit({
		env: site.env,
		sourceId,
		userId: ownerId,
		commit: 'commit-b',
	})
	await expect(listHeldForApprovalPackages(site.db, packages)).resolves.toEqual(
		[
			{
				packageId,
				name: '@owner/site',
				kodyId: 'site',
				servingCommit: 'commit-a',
				heldCommit: 'commit-b',
			},
		],
	)
	// Only internet-visible apps hold a commit.
	await expect(
		listHeldForApprovalPackages(
			site.db,
			packages.map((pkg) => ({ ...pkg, isInternetVisible: false })),
		),
	).resolves.toEqual([])

	await site.approveLive()
	await expect(listHeldForApprovalPackages(site.db, packages)).resolves.toEqual(
		[],
	)
	await site.expectEveryoneOn('commit-b')
})

test('a source is held only while its held commit is the latest publish and not serving', () => {
	expect(
		heldForApprovalFromSource({
			published_commit: 'b',
			serving_commit: 'a',
			held_commit: 'b',
		}),
	).toEqual({ servingCommit: 'a', heldCommit: 'b' })
	// A live publish reports no held commit.
	expect(
		heldForApprovalFromSource({
			published_commit: 'b',
			serving_commit: 'b',
			held_commit: null,
		}),
	).toBeNull()
	// A newer publish replaced the held commit.
	expect(
		heldForApprovalFromSource({
			published_commit: 'c',
			serving_commit: 'a',
			held_commit: 'b',
		}),
	).toBeNull()
	// Nothing served before, so there is nothing to stay on.
	expect(
		heldForApprovalFromSource({
			published_commit: 'b',
			serving_commit: null,
			held_commit: 'b',
		}),
	).toBeNull()
	expect(heldForApprovalFromSource(null)).toBeNull()
})
