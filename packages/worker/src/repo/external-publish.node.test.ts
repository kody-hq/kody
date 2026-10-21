import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as PublishLock from '#worker/package-registry/package-publish-lock.ts'
import type * as NeedsApproval from '#worker/credentials/credential-needs-approval.ts'
import type * as CommunityIcon from '#worker/community/community-icon.ts'
import type * as PublishedRuntimeArtifacts from '#worker/package-runtime/published-runtime-artifacts.ts'
import type * as EntitySources from './entity-sources.ts'
import type * as IdentityIcon from './identity-icon.ts'

const mockModule = vi.hoisted(() => ({
	getEntitySourceById: vi.fn(),
	updateEntitySource: vi.fn<typeof EntitySources.updateEntitySource>(
		async () => true,
	),
	runRepoChecks: vi.fn(),
	writePublishedSourceSnapshot: vi.fn<
		typeof PublishedRuntimeArtifacts.writePublishedSourceSnapshot
	>(async () => 'snapshot-key'),
	deletePublishedSourceSnapshot: vi.fn<
		typeof PublishedRuntimeArtifacts.deletePublishedSourceSnapshot
	>(async () => undefined),
	loadPublishedSourceSnapshot: vi.fn(),
	refreshSavedPackageProjection: vi.fn(),
	refreshCommunityIconForPackagePublish: vi.fn<
		typeof CommunityIcon.refreshCommunityIconForPackagePublish
	>(async () => undefined),
	refreshIdentityIconForSource: vi.fn<
		typeof IdentityIcon.refreshIdentityIconForSource
	>(async () => undefined),
	hasPublishedRuntimeArtifacts: vi.fn<
		typeof PublishedRuntimeArtifacts.hasPublishedRuntimeArtifacts
	>(() => false),
	loadLockedSavedPackage: vi.fn<typeof PublishLock.loadLockedSavedPackage>(
		async () => null,
	),
	requireCredentialNeedsApproval: vi.fn<
		typeof NeedsApproval.requireCredentialNeedsApproval
	>(async () => null),
	syncActiveCommunityListingToPublishedCommit: vi.fn(
		async (_input?: unknown) => 'skipped' as const,
	),
}))

vi.mock(
	'#worker/credentials/credential-needs-approval.ts',
	async (importOriginal) => ({
		...(await importOriginal<typeof NeedsApproval>()),
		requireCredentialNeedsApproval: (
			...args: Parameters<typeof NeedsApproval.requireCredentialNeedsApproval>
		) => mockModule.requireCredentialNeedsApproval(...args),
	}),
)

vi.mock('./entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
	updateEntitySource: (
		...args: Parameters<typeof EntitySources.updateEntitySource>
	) => mockModule.updateEntitySource(...args),
}))

vi.mock('./checks.ts', () => ({
	runRepoChecks: (...args: Array<unknown>) => mockModule.runRepoChecks(...args),
}))

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	hasPublishedRuntimeArtifacts: (
		...args: Parameters<
			typeof PublishedRuntimeArtifacts.hasPublishedRuntimeArtifacts
		>
	) => mockModule.hasPublishedRuntimeArtifacts(...args),
	loadPublishedSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.loadPublishedSourceSnapshot(...args),
	writePublishedSourceSnapshot: (
		...args: Parameters<
			typeof PublishedRuntimeArtifacts.writePublishedSourceSnapshot
		>
	) => mockModule.writePublishedSourceSnapshot(...args),
	deletePublishedSourceSnapshot: (
		...args: Parameters<
			typeof PublishedRuntimeArtifacts.deletePublishedSourceSnapshot
		>
	) => mockModule.deletePublishedSourceSnapshot(...args),
}))

vi.mock('#worker/package-registry/service.ts', () => ({
	refreshSavedPackageProjection: (...args: Array<unknown>) =>
		mockModule.refreshSavedPackageProjection(...args),
}))

vi.mock('#worker/community/community-icon.ts', () => ({
	refreshCommunityIconForPackagePublish: (
		...args: Parameters<
			typeof CommunityIcon.refreshCommunityIconForPackagePublish
		>
	) => mockModule.refreshCommunityIconForPackagePublish(...args),
}))

vi.mock('#worker/repo/identity-icon.ts', () => ({
	refreshIdentityIconForSource: (
		...args: Parameters<typeof IdentityIcon.refreshIdentityIconForSource>
	) => mockModule.refreshIdentityIconForSource(...args),
}))

vi.mock('#worker/community/sync-active-community-listing.ts', () => ({
	syncActiveCommunityListingToPublishedCommit: (input: unknown) =>
		mockModule.syncActiveCommunityListingToPublishedCommit(input),
}))

vi.mock(
	'#worker/package-registry/package-publish-lock.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof PublishLock>()
		return {
			...actual,
			loadLockedSavedPackage: (
				...args: Parameters<typeof PublishLock.loadLockedSavedPackage>
			) => mockModule.loadLockedSavedPackage(...args),
		}
	},
)

const { finalizePublishedEntitySource, publishFromExternalRef } =
	await import('./external-publish.ts')

const manifest = {
	name: '@scope/demo',
	exports: { '.': './src/index.ts' },
	kody: { id: 'demo', description: 'Demo' },
}
const passingChecks = {
	ok: true,
	results: [{ kind: 'manifest', ok: true, message: 'ok' }],
	manifest,
}
const kvEnv = { APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} as KVNamespace } as Env

function source(overrides: Record<string, unknown> = {}) {
	return {
		id: 'source-1',
		user_id: ownerIdFromStored('user-1'),
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'repo-1',
		published_commit: 'commit-old',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-05-04T00:00:00.000Z',
		updated_at: '2026-05-04T00:00:00.000Z',
		...overrides,
	}
}

function setupPublish(sourceOverrides: Record<string, unknown> = {}) {
	mockModule.writePublishedSourceSnapshot.mockResolvedValue('snapshot-key')
	mockModule.deletePublishedSourceSnapshot.mockResolvedValue(undefined)
	mockModule.loadPublishedSourceSnapshot.mockResolvedValue({
		files: { 'package.json': '{}' },
	})
	mockModule.hasPublishedRuntimeArtifacts.mockReturnValue(false)
	mockModule.loadLockedSavedPackage.mockResolvedValue(null)
	mockModule.requireCredentialNeedsApproval.mockResolvedValue(null)
	mockModule.getEntitySourceById.mockResolvedValue(source(sourceOverrides))
}

function publish(
	overrides: Partial<Parameters<typeof publishFromExternalRef>[0]> = {},
) {
	return publishFromExternalRef({
		env: { APP_DB: {} } as Env,
		sourceId: 'source-1',
		userId: ownerIdFromStored('user-1'),
		newCommit: 'commit-new',
		isFastForward: async () => true,
		workspace: {
			readFile: vi.fn(async () => '{}'),
			glob: vi.fn(async () => []),
		},
		files: { 'package.json': '{}' },
		baseUrl: 'https://kody.test',
		...overrides,
	})
}

test('publishes an external fast-forward ref after checks pass', async () => {
	setupPublish({ external_check_until: '2026-05-04T04:00:00.000Z' })
	mockModule.runRepoChecks.mockResolvedValue(passingChecks)
	const phaseTimings = { clone_ms: 9 }

	const published = await publish({
		phaseTimings,
		deferBundleCheckToRebuild: true,
	})

	expect(published.status).toBe('published')
	expect(mockModule.runRepoChecks).toHaveBeenCalledWith(
		expect.objectContaining({ phaseTimings, deferBundleCheckToRebuild: true }),
	)
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			id: 'source-1',
			publishedCommit: 'commit-new',
			externalCheckUntil: null,
		}),
	)
	// A successful package publish refreshes the community listing icon so
	// updated community-icon.* files become publicly visible without a
	// community republish.
	expect(mockModule.refreshCommunityIconForPackagePublish).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			packageId: 'package-1',
			publishedCommit: 'commit-new',
		}),
	)
	expect(mockModule.refreshIdentityIconForSource).toHaveBeenCalledWith(
		expect.objectContaining({ iconCommit: 'commit-new', indexLiveHead: false }),
	)

	setupPublish()
	mockModule.hasPublishedRuntimeArtifacts.mockReturnValue(true)
	const sourceFiles = {
		'package.json': '{"name":"@scope/demo"}',
		'src/index.ts': 'export default async () => null',
	}
	mockModule.runRepoChecks.mockResolvedValue({ ...passingChecks, sourceFiles })

	const withRuntimeArtifacts = await publish({ env: kvEnv, files: undefined })

	expect(withRuntimeArtifacts.status).toBe('published')
	expect(mockModule.writePublishedSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({ files: sourceFiles }),
	)

	// Explicit files win over the UTF-8 check walk (PNG magic must stay 0x89).
	const { bytesToLatin1String } =
		await import('#universal/package-file-media.ts')
	const pngLatin1 = bytesToLatin1String(
		Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	)
	const utf8Corrupted = new TextDecoder().decode(
		Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	)
	setupPublish()
	mockModule.hasPublishedRuntimeArtifacts.mockReturnValue(true)
	mockModule.runRepoChecks.mockResolvedValue({
		...passingChecks,
		sourceFiles: { ...sourceFiles, 'public/mark.png': utf8Corrupted },
	})
	const binarySafe = await publish({
		env: kvEnv,
		files: { ...sourceFiles, 'public/mark.png': pngLatin1 },
	})
	expect(binarySafe.status).toBe('published')
	expect(mockModule.writePublishedSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			files: expect.objectContaining({ 'public/mark.png': pngLatin1 }),
		}),
	)
})

test('returns no-op when commit is already current', async () => {
	setupPublish()
	const alreadyPublished = {
		status: 'already_published',
		published_commit: 'commit-old',
	}

	await expect(
		publish({ newCommit: 'commit-old', files: {} }),
	).resolves.toEqual(alreadyPublished)
	// Re-invoking after a partial/timed-out publish whose D1 published_commit
	// already matches the pushed HEAD must stay a no-op. This is what makes
	// overlapping inline + durable escalation safe: the second attempt cannot
	// double-apply checks or D1 writes.
	await expect(
		publish({
			newCommit: 'commit-old',
			files: {},
			isFastForward: async () => {
				throw new Error('must not check ancestry when already published')
			},
		}),
	).resolves.toEqual(alreadyPublished)
	expect(mockModule.runRepoChecks).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
})

test('non-fast-forward publish requires allowForce, destructive confirmation, and a restorable backup snapshot', async () => {
	setupPublish()
	const rewrite = {
		newCommit: 'commit-rewritten',
		isFastForward: async () => false,
	}

	await expect(publish({ ...rewrite, files: {} })).resolves.toMatchObject({
		status: 'not_fast_forward',
		previous_commit: 'commit-old',
		published_commit: 'commit-rewritten',
	})
	expect(mockModule.runRepoChecks).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()

	await expect(publish({ ...rewrite, allowForce: true })).rejects.toThrow(
		'confirm_destructive_overwrite',
	)

	const confirmed = {
		...rewrite,
		allowForce: true,
		destructiveOverwriteConfirmed: true,
	}
	mockModule.loadPublishedSourceSnapshot.mockResolvedValueOnce(null)
	await expect(publish(confirmed)).rejects.toThrow(
		'Stop and report this source recovery problem',
	)

	mockModule.runRepoChecks.mockResolvedValue(passingChecks)
	await expect(publish(confirmed)).resolves.toEqual(
		expect.objectContaining({
			status: 'published',
			previous_commit: 'commit-old',
			published_commit: 'commit-rewritten',
		}),
	)
	expect(mockModule.runRepoChecks).toHaveBeenCalledTimes(1)
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			id: 'source-1',
			publishedCommit: 'commit-rewritten',
		}),
	)
})

test('rechecks fast-forward against the latest source row before publishing', async () => {
	setupPublish({ published_commit: 'commit-concurrent' })

	await expect(
		publish({
			files: {},
			isFastForward: async ({ previousCommit }) =>
				previousCommit === 'commit-old',
		}),
	).resolves.toMatchObject({
		status: 'not_fast_forward',
		previous_commit: 'commit-concurrent',
		published_commit: 'commit-new',
	})
	expect(mockModule.runRepoChecks).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
})

test('check failure leaves D1 untouched', async () => {
	setupPublish()
	mockModule.runRepoChecks.mockResolvedValue({
		ok: false,
		results: [
			{ kind: 'manifest', ok: true, message: 'ok' },
			{ kind: 'typecheck', ok: false, message: 'bad type' },
		],
		manifest,
	})

	await expect(publish({ files: {}, runId: 'run-1' })).resolves.toEqual({
		status: 'checks_failed',
		failed_checks: [{ kind: 'typecheck', ok: false, message: 'bad type' }],
		manifest,
		run_id: 'run-1',
	})
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
})

test('publishFromExternalRef fails when projection refresh fails after commit', async () => {
	setupPublish()
	mockModule.runRepoChecks.mockResolvedValue(passingChecks)
	mockModule.refreshSavedPackageProjection.mockRejectedValueOnce(
		new Error('projection failed'),
	)

	await expect(publish()).rejects.toThrow('projection failed')
	for (const publishedCommit of ['commit-new', 'commit-old']) {
		expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ publishedCommit }),
		)
	}
	// Failed publishes must not invalidate community icon caches.
	expect(
		mockModule.refreshCommunityIconForPackagePublish,
	).not.toHaveBeenCalled()

	mockModule.hasPublishedRuntimeArtifacts.mockReturnValue(true)
	mockModule.refreshSavedPackageProjection.mockRejectedValueOnce(
		new Error('projection unavailable'),
	)

	await expect(publish({ env: kvEnv })).rejects.toThrow(
		'projection unavailable',
	)
	expect(mockModule.writePublishedSourceSnapshot).toHaveBeenCalled()
	expect(mockModule.deletePublishedSourceSnapshot).toHaveBeenCalledWith({
		env: { APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} },
		sourceId: 'source-1',
		publishedCommit: 'commit-new',
	})
})

test('same-commit finalize keeps the live snapshot when projection fails', async () => {
	mockModule.hasPublishedRuntimeArtifacts.mockReturnValue(true)
	mockModule.writePublishedSourceSnapshot.mockResolvedValue('snapshot-key')
	mockModule.deletePublishedSourceSnapshot.mockClear()
	mockModule.refreshSavedPackageProjection.mockRejectedValueOnce(
		new Error('projection unavailable'),
	)

	await expect(
		finalizePublishedEntitySource({
			env: kvEnv,
			source: source({
				published_commit: 'commit-same',
			}) as ReturnType<typeof source> & { entity_kind: 'package' },
			publishedCommit: 'commit-same',
			files: { 'package.json': '{}' },
			baseUrl: 'https://kody.test',
		}),
	).rejects.toThrow('projection unavailable')

	expect(mockModule.writePublishedSourceSnapshot).toHaveBeenCalled()
	expect(mockModule.deletePublishedSourceSnapshot).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ publishedCommit: 'commit-same' }),
	)
})

test('finalize writes the published snapshot before flipping published_commit', async () => {
	const callOrder: Array<string> = []
	mockModule.hasPublishedRuntimeArtifacts.mockReturnValue(true)
	mockModule.writePublishedSourceSnapshot.mockImplementation(async () => {
		callOrder.push('writePublishedSourceSnapshot')
		return 'snapshot-key'
	})
	mockModule.updateEntitySource.mockImplementation(async () => {
		callOrder.push('updateEntitySource')
		return true
	})
	mockModule.refreshSavedPackageProjection.mockResolvedValue(undefined)

	await finalizePublishedEntitySource({
		env: kvEnv,
		source: source() as ReturnType<typeof source> & { entity_kind: 'package' },
		publishedCommit: 'commit-new',
		files: { 'package.json': '{}' },
		baseUrl: 'https://kody.test',
	})

	expect(callOrder.slice(0, 2)).toEqual([
		'writePublishedSourceSnapshot',
		'updateEntitySource',
	])
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ publishedCommit: 'commit-new' }),
	)
})

test('finalize forwards actorUserId into listing auto-follow sync', async () => {
	mockModule.hasPublishedRuntimeArtifacts.mockReturnValue(false)
	mockModule.updateEntitySource.mockResolvedValue(true)
	mockModule.refreshSavedPackageProjection.mockResolvedValue(undefined)
	mockModule.syncActiveCommunityListingToPublishedCommit.mockClear()

	await finalizePublishedEntitySource({
		env: kvEnv,
		source: source() as ReturnType<typeof source> & { entity_kind: 'package' },
		publishedCommit: 'commit-new',
		files: { 'package.json': '{}' },
		baseUrl: 'https://kody.test',
		actorUserId: 'actor-approver',
	})

	expect(
		mockModule.syncActiveCommunityListingToPublishedCommit,
	).toHaveBeenCalledWith(
		expect.objectContaining({
			packageId: 'package-1',
			publishedCommit: 'commit-new',
			actorUserId: 'actor-approver',
		}),
	)
})

test('finalize leaves published_commit alone when snapshot write fails', async () => {
	mockModule.hasPublishedRuntimeArtifacts.mockReturnValue(true)
	mockModule.writePublishedSourceSnapshot.mockRejectedValueOnce(
		new Error('kv unavailable'),
	)
	mockModule.updateEntitySource.mockClear()

	await expect(
		finalizePublishedEntitySource({
			env: kvEnv,
			source: source() as ReturnType<typeof source> & {
				entity_kind: 'package'
			},
			publishedCommit: 'commit-new',
			files: { 'package.json': '{}' },
			baseUrl: 'https://kody.test',
		}),
	).rejects.toThrow('kv unavailable')

	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
	expect(mockModule.deletePublishedSourceSnapshot).not.toHaveBeenCalled()
})

test('finalize deletes the orphan snapshot when the pointer flip fails', async () => {
	mockModule.hasPublishedRuntimeArtifacts.mockReturnValue(true)
	mockModule.writePublishedSourceSnapshot.mockResolvedValue('snapshot-key')
	mockModule.updateEntitySource.mockRejectedValueOnce(
		new Error('d1 unavailable'),
	)
	// Pointer never moved — live row still on the previous tip.
	mockModule.getEntitySourceById.mockResolvedValueOnce(
		source({ published_commit: 'commit-old' }),
	)
	mockModule.deletePublishedSourceSnapshot.mockClear()

	await expect(
		finalizePublishedEntitySource({
			env: kvEnv,
			source: source() as ReturnType<typeof source> & {
				entity_kind: 'package'
			},
			publishedCommit: 'commit-new',
			files: { 'package.json': '{}' },
			baseUrl: 'https://kody.test',
		}),
	).rejects.toThrow('d1 unavailable')

	expect(mockModule.deletePublishedSourceSnapshot).toHaveBeenCalledWith({
		env: kvEnv,
		sourceId: 'source-1',
		publishedCommit: 'commit-new',
	})
})

test('finalize keeps the snapshot when a concurrent pointer flip already landed', async () => {
	mockModule.hasPublishedRuntimeArtifacts.mockReturnValue(true)
	mockModule.writePublishedSourceSnapshot.mockResolvedValue('snapshot-key')
	mockModule.updateEntitySource.mockRejectedValueOnce(
		new Error('d1 unavailable'),
	)
	// Another writer already advertised commit-new.
	mockModule.getEntitySourceById.mockResolvedValueOnce(
		source({ published_commit: 'commit-new' }),
	)
	mockModule.deletePublishedSourceSnapshot.mockClear()

	await expect(
		finalizePublishedEntitySource({
			env: kvEnv,
			source: source() as ReturnType<typeof source> & {
				entity_kind: 'package'
			},
			publishedCommit: 'commit-new',
			files: { 'package.json': '{}' },
			baseUrl: 'https://kody.test',
		}),
	).rejects.toThrow('d1 unavailable')

	expect(mockModule.deletePublishedSourceSnapshot).not.toHaveBeenCalled()
})

test('locked package finishes checks then withholds published_commit unless allowLockedPublish', async () => {
	setupPublish()
	mockModule.runRepoChecks.mockResolvedValue(passingChecks)
	mockModule.loadLockedSavedPackage.mockResolvedValue({
		id: 'package-1',
		userId: ownerIdFromStored('user-1'),
		name: '@scope/demo',
		kodyId: 'demo',
		description: 'Demo',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hasSkills: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		lockedAt: '2026-08-28T12:00:00.000Z',
		createdAt: '2026-05-04T00:00:00.000Z',
		updatedAt: '2026-05-04T00:00:00.000Z',
	})

	await expect(
		publish({ deferBundleCheckToRebuild: true }),
	).resolves.toMatchObject({
		status: 'locked',
		previous_commit: 'commit-old',
		pending_commit: 'commit-new',
		packageId: 'package-1',
		packageName: '@scope/demo',
	})
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
	expect(mockModule.refreshSavedPackageProjection).not.toHaveBeenCalled()
	expect(
		mockModule.runRepoChecks.mock.calls[0]?.[0]?.deferBundleCheckToRebuild,
	).toBeUndefined()

	mockModule.runRepoChecks.mockClear()
	const published = await publish({
		allowLockedPublish: true,
		deferBundleCheckToRebuild: true,
	})
	expect(mockModule.runRepoChecks).toHaveBeenCalledWith(
		expect.objectContaining({ deferBundleCheckToRebuild: true }),
	)
	expect(published.status).toBe('published')
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ id: 'source-1', publishedCommit: 'commit-new' }),
	)
})

test('changed credential needs pause the publish unless the owner approved them', async () => {
	setupPublish()
	mockModule.runRepoChecks.mockResolvedValue(passingChecks)
	const approval = {
		requestId: 'request-1',
		packageId: 'package-1',
		packageName: '@scope/demo',
		kodyId: 'demo',
		pendingCommit: 'commit-new',
		changes: [
			{
				key: 'MAIL',
				change: 'added' as const,
				after: { kind: 'secret' as const, provider: 'resend', multiple: false },
			},
		],
		message: 'needs changed',
	}
	mockModule.requireCredentialNeedsApproval.mockResolvedValue(approval)

	await expect(publish()).resolves.toEqual({
		status: 'approval_required',
		previous_commit: 'commit-old',
		pending_commit: 'commit-new',
		message: 'needs changed',
		approval,
	})
	expect(mockModule.requireCredentialNeedsApproval).toHaveBeenCalledWith(
		expect.objectContaining({
			pendingCommit: 'commit-new',
			files: { 'package.json': '{}' },
			pausedExternalPublish: {
				allowForce: false,
				destructiveOverwriteConfirmed: false,
			},
		}),
	)
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
	expect(mockModule.refreshSavedPackageProjection).not.toHaveBeenCalled()

	mockModule.requireCredentialNeedsApproval.mockClear()
	const approved = await publish({ credentialNeedsApproved: true })
	expect(approved.status).toBe('published')
	expect(mockModule.requireCredentialNeedsApproval).not.toHaveBeenCalled()
})

test('locked package with failing checks answers checks_failed, never locked or approval_required', async () => {
	setupPublish()
	const stampFailure = {
		kind: 'credentials',
		ok: false,
		message:
			'Credential stamp publish gate (issue #3836 phase 1):\nPublish failed. src/index.ts uses |scope=',
	}
	mockModule.runRepoChecks.mockResolvedValue({
		ok: false,
		results: [{ kind: 'manifest', ok: true, message: 'ok' }, stampFailure],
		manifest,
		sourceFiles: {},
	})
	mockModule.loadLockedSavedPackage.mockResolvedValue({
		id: 'package-1',
		userId: ownerIdFromStored('user-1'),
		name: '@scope/demo',
		kodyId: 'demo',
		description: 'Demo',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hasSkills: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		lockedAt: '2026-08-28T12:00:00.000Z',
		createdAt: '2026-05-04T00:00:00.000Z',
		updatedAt: '2026-05-04T00:00:00.000Z',
	})

	const result = await publish()
	// The approval link comes from the locked / approval_required answers.
	// A commit that fails checks must never reach either.
	expect(result).toMatchObject({
		status: 'checks_failed',
		failed_checks: [stampFailure],
	})
	expect(mockModule.requireCredentialNeedsApproval).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
})
