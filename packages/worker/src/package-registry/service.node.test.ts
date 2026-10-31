import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#universal/plans.ts'
import {
	createInMemoryUserMeterEnv,
	createPermissiveAccountWriteLeaseDbHooks,
} from '#worker/test-support/user-meter.ts'
import {
	isLiveSeatCountQuery,
	mockLiveSeatCountRow,
} from '#worker/test-support/live-seat-count-query.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const { mockModule, pickMocks } = vi.hoisted(() => {
	const mockModule = {
		buildPackageSearchProjection: vi.fn(),
		buildSavedPackageEmbedText: vi.fn(),
		buildPublishedPackageArtifacts: vi.fn(),
		writePackageSkillsIndex: vi.fn(),
		removePackageSkillsIndexEntries: vi.fn(),
		collectPackageSkills: vi.fn(),
		buildPackageSkillsIndex: vi.fn(),
		refreshPackageSubscriptionTopicMap: vi.fn(),
		deleteJobRow: vi.fn(),
		deleteEntitySource: vi.fn(),
		deleteSavedPackage: vi.fn(),
		deletePackageAppRateLimits: vi.fn(),
		deleteSavedPackageVector: vi.fn(),
		getSavedPackageById: vi.fn(),
		insertSavedPackage: vi.fn(),
		listJobRowsByUserId: vi.fn(),
		loadPackageManifestBySourceId: vi.fn(),
		loadPackageSourceBySourceId: vi.fn(),
		loadPackageSourceFromFiles: vi.fn(),
		syncJobManagerAlarm: vi.fn(),
		syncPackageJobsForPackage: vi.fn(),
		updateSavedPackage: vi.fn(),
		upsertSavedPackageVector: vi.fn(),
		scheduleSavedPackageSearchIndexUpsert: vi.fn(),
		cleanupArtifactReposForPackage: vi.fn(),
		deleteAllPackageScopedSecrets: vi.fn(),
		removeAllSecretApprovalsForPackage: vi.fn(),
		clearStorage: vi.fn(async () => ({ ok: true as const })),
		storageRunnerRpc: vi.fn(),
		getCommunityListingByOwnerAndPackage: vi.fn(),
		deleteCommunityForksForPackage: vi.fn(),
		unpublishCommunityListing: vi.fn(),
		invalidateCommunityPublicCache: vi.fn(),
		scheduleKitSubscriberSync: vi.fn(),
		stampFirstSavedPackage: vi.fn(),
	}
	const pickMocks = (...names: Array<keyof typeof mockModule>) =>
		Object.fromEntries(names.map((name) => [name, mockModule[name]]))
	return { mockModule, pickMocks }
})

vi.mock('./manifest.ts', () => pickMocks('buildPackageSearchProjection'))
vi.mock('./embed.ts', () => pickMocks('buildSavedPackageEmbedText'))
vi.mock('#worker/package-runtime/published-bundle-artifacts.ts', () => ({
	rebuildPublishedPackageArtifacts: mockModule.buildPublishedPackageArtifacts,
}))
vi.mock('#worker/package-runtime/module-graph.ts', () => ({
	buildKodyAppBundle: vi.fn(),
	buildKodyModuleBundle: vi.fn(),
}))
vi.mock('#worker/storage-runner.ts', async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	storageRunnerRpc: (...args: Array<unknown>) => {
		mockModule.storageRunnerRpc(...args)
		return { clearStorage: mockModule.clearStorage }
	},
}))
vi.mock('#worker/package-config-cleanup.ts', () =>
	pickMocks(
		'deleteAllPackageScopedSecrets',
		'removeAllSecretApprovalsForPackage',
	),
)
vi.mock('#worker/package-registry/skills-index-cache.ts', () =>
	pickMocks('writePackageSkillsIndex', 'removePackageSkillsIndexEntries'),
)
vi.mock('#worker/package-registry/package-skills.ts', () =>
	pickMocks('collectPackageSkills', 'buildPackageSkillsIndex'),
)
vi.mock('#worker/package-invocations/subscription-topic-cache.ts', () =>
	pickMocks('refreshPackageSubscriptionTopicMap'),
)
vi.mock('./repo.ts', () =>
	pickMocks(
		'deleteSavedPackage',
		'getSavedPackageById',
		'insertSavedPackage',
		'updateSavedPackage',
	),
)
vi.mock('./source.ts', () =>
	pickMocks(
		'loadPackageManifestBySourceId',
		'loadPackageSourceBySourceId',
		'loadPackageSourceFromFiles',
	),
)
vi.mock('./vectorize.ts', () =>
	pickMocks('deleteSavedPackageVector', 'upsertSavedPackageVector'),
)
vi.mock('./search-index-debt.ts', () =>
	pickMocks('scheduleSavedPackageSearchIndexUpsert'),
)
vi.mock('#worker/jobs/jobs-data.ts', () => ({
	jobsData: () => ({
		deleteJob: mockModule.deleteJobRow,
		listJobsForUser: mockModule.listJobRowsByUserId,
	}),
}))
vi.mock('#worker/jobs/manager-client.ts', () =>
	pickMocks('syncJobManagerAlarm'),
)
vi.mock('#worker/jobs/service.ts', () => pickMocks('syncPackageJobsForPackage'))
vi.mock('#worker/repo/artifact-repo-cleanup.ts', () =>
	pickMocks('cleanupArtifactReposForPackage'),
)
vi.mock('#worker/repo/entity-sources.ts', () => pickMocks('deleteEntitySource'))
vi.mock('#worker/community/repo.ts', () =>
	pickMocks(
		'getCommunityListingByOwnerAndPackage',
		'deleteCommunityForksForPackage',
	),
)
vi.mock('#app/data-cache.ts', () => pickMocks('invalidateCommunityPublicCache'))
vi.mock('#worker/community/service.ts', () =>
	pickMocks('unpublishCommunityListing'),
)
vi.mock('#worker/kit/subscriber-sync.ts', () =>
	pickMocks('scheduleKitSubscriberSync'),
)
vi.mock('#worker/identity/activation-stamps.ts', () =>
	pickMocks('stampFirstSavedPackage'),
)

const {
	deleteSavedPackageProjection,
	filterPackageOwnedStorageIdsFromInventory,
	refreshSavedPackageProjection,
} = await import('./service.ts')

type StorageBucket = { userId: string; storageId: string }

function createEnv(
	userId = 'user-1',
	options?: {
		storageBuckets?: Array<StorageBucket>
		users?: Array<{ email: string; plan: string | null }>
		savedPackageCount?: number
		failStorageInventory?: boolean
	},
) {
	// Projection refresh asserts finite storage bytes (default/missing plan →
	// `max`). Stub DB answers storage SUM queries with 0 so unplanned unit
	// fixtures keep focusing on job/artifact side effects.
	return {
		APP_DB: createEntitlementsDatabase({
			users: options?.users ?? [],
			userId,
			storageBuckets: options?.storageBuckets,
			savedPackageCount: options?.savedPackageCount,
			failStorageInventory: options?.failStorageInventory,
		}),
		USER_METER: createInMemoryUserMeterEnv().env.USER_METER,
	} as Env
}

function createProjection() {
	return {
		name: '@kentcdodds/shade-automation',
		kodyId: 'shade-automation',
		description: 'Shade automation package',
		tags: ['home', 'shades'],
		searchText: 'shade automation',
		hasApp: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
	}
}

function savedPackageRecord(overrides: Record<string, unknown> = {}) {
	return {
		id: 'package-1',
		userId: ownerIdFromStored('user-1'),
		name: '@kentcdodds/shade-automation',
		kodyId: 'shade-automation',
		description: 'Old description',
		tags: ['home'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		createdAt: '2026-04-20T00:00:00.000Z',
		updatedAt: '2026-04-20T00:00:00.000Z',
		...overrides,
	}
}

function shadeManifest(kody: Record<string, unknown> = {}) {
	return {
		name: '@kentcdodds/shade-automation',
		kody: {
			id: 'shade-automation',
			description: 'Shade automation package',
			...kody,
		},
	}
}

function mockSource(manifest: unknown = shadeManifest()) {
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		manifest,
		files: { 'package.json': '{}' },
		source: {
			id: 'source-1',
			published_commit: 'commit-1',
		},
	})
}

function setupDefaultMocks() {
	mockModule.buildPackageSearchProjection.mockReturnValue(createProjection())
	mockModule.buildSavedPackageEmbedText.mockReturnValue('saved package embed')
	mockModule.upsertSavedPackageVector.mockResolvedValue(undefined)
	mockModule.scheduleSavedPackageSearchIndexUpsert.mockResolvedValue(undefined)
	mockModule.buildPublishedPackageArtifacts.mockResolvedValue(undefined)
	mockModule.syncPackageJobsForPackage.mockResolvedValue(false)
	mockModule.syncJobManagerAlarm.mockResolvedValue(undefined)
	mockModule.refreshPackageSubscriptionTopicMap.mockResolvedValue(undefined)
	mockModule.collectPackageSkills.mockResolvedValue([])
	mockModule.buildPackageSkillsIndex.mockReturnValue({
		version: 1,
		packageId: 'package-1',
		kodyId: '@owner/pkg',
		publishedCommit: 'commit',
		skills: [],
	})
	mockModule.writePackageSkillsIndex.mockResolvedValue(undefined)
	mockModule.removePackageSkillsIndexEntries.mockResolvedValue(undefined)
	mockModule.updateSavedPackage.mockResolvedValue(undefined)
	mockModule.insertSavedPackage.mockResolvedValue(true)
	mockModule.deleteEntitySource.mockResolvedValue(undefined)
	mockModule.deleteSavedPackage.mockResolvedValue(undefined)
	mockModule.deleteSavedPackageVector.mockResolvedValue(undefined)
	mockModule.deleteJobRow.mockResolvedValue(undefined)
	mockModule.cleanupArtifactReposForPackage.mockResolvedValue(0)
	mockModule.clearStorage.mockResolvedValue({ ok: true as const })
	mockModule.listJobRowsByUserId.mockResolvedValue([])
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue(null)
	mockModule.unpublishCommunityListing.mockResolvedValue(undefined)
	mockModule.deleteCommunityForksForPackage.mockResolvedValue(0)
	mockModule.scheduleKitSubscriberSync.mockReset()
	mockModule.stampFirstSavedPackage.mockReset()
	mockModule.stampFirstSavedPackage.mockResolvedValue(true)
}

function refresh(env: Env, overrides: Record<string, unknown> = {}) {
	return refreshSavedPackageProjection({
		env,
		baseUrl: 'https://heykody.dev',
		userId: ownerIdFromStored('user-1'),
		packageId: 'package-1',
		sourceId: 'source-1',
		...overrides,
		audit: null,
	})
}

function mockPackageRow(id = 'package-1', sourceId = 'source-1') {
	mockModule.getSavedPackageById.mockResolvedValue({
		id,
		name: '@kentcdodds/shade-automation',
		kodyId: 'shade-automation',
		sourceId,
	})
}

function deletePackage(
	env: Env,
	packageId = 'package-1',
	actorUserId?: string,
) {
	return deleteSavedPackageProjection({
		env,
		userId: ownerIdFromStored('user-1'),
		packageId,
		...(actorUserId ? { actorUserId } : {}),
		audit: null,
	})
}

function clearedStorageIds() {
	return mockModule.storageRunnerRpc.mock.calls.map(
		(call) => (call[0] as { storageId: string }).storageId,
	)
}

test('refreshSavedPackageProjection defers search-index and skills index via waitUntil', async () => {
	setupDefaultMocks()
	const waitUntilPromises: Array<Promise<unknown>> = []
	mockSource(shadeManifest({ tags: ['home'] }))
	mockModule.getSavedPackageById.mockResolvedValue(savedPackageRecord())

	await refresh(createEnv(), {
		waitUntil: (promise: Promise<unknown>) => {
			waitUntilPromises.push(promise)
		},
	})

	expect(mockModule.scheduleSavedPackageSearchIndexUpsert).toHaveBeenCalledWith(
		expect.objectContaining({
			packageId: 'package-1',
			userId: ownerIdFromStored('user-1'),
			waitUntil: expect.any(Function),
		}),
	)
	expect(waitUntilPromises.length).toBeGreaterThanOrEqual(1)
	await Promise.all(waitUntilPromises)
})

test('refreshSavedPackageProjection uses caller-supplied source files instead of reloading KV', async () => {
	setupDefaultMocks()
	const env = createEnv()
	const sourceFiles = {
		'package.json': '{"name":"@kentcdodds/shade-automation"}',
		'src/index.ts': 'export default async function main() {}',
	}
	mockModule.loadPackageSourceFromFiles.mockResolvedValue({
		manifest: shadeManifest({ tags: ['home'] }),
		files: sourceFiles,
		source: { id: 'source-1', published_commit: 'commit-1' },
	})
	mockModule.getSavedPackageById.mockResolvedValue(savedPackageRecord())

	await refresh(env, { sourceFiles })

	expect(mockModule.loadPackageSourceFromFiles).toHaveBeenCalledWith({
		env,
		userId: ownerIdFromStored('user-1'),
		sourceId: 'source-1',
		files: sourceFiles,
	})
	expect(mockModule.loadPackageSourceBySourceId).not.toHaveBeenCalled()
	expect(mockModule.buildPublishedPackageArtifacts).toHaveBeenCalled()
})

test('refreshSavedPackageProjection syncs the job manager only when package jobs change', async () => {
	setupDefaultMocks()
	mockModule.syncPackageJobsForPackage.mockResolvedValue(true)
	const env = createEnv()
	const manifest = shadeManifest({
		tags: ['home', 'shades'],
		searchText: 'shade automation',
		jobs: {
			'event-runner': {
				entry: './src/jobs/event-runner.ts',
				schedule: { type: 'interval', every: '1m' },
				timezone: 'America/Denver',
				enabled: true,
			},
		},
	})
	mockSource(manifest)
	mockModule.getSavedPackageById.mockResolvedValue(savedPackageRecord())

	await refresh(env)

	expect(mockModule.syncPackageJobsForPackage).toHaveBeenCalledWith({
		env,
		userId: ownerIdFromStored('user-1'),
		baseUrl: 'https://heykody.dev',
		packageId: 'package-1',
		sourceId: 'source-1',
		manifest,
		actorUserId: undefined,
		actorCredential: null,
	})
	expect(mockModule.buildPublishedPackageArtifacts).toHaveBeenCalledWith({
		env,
		userId: ownerIdFromStored('user-1'),
		source: expect.objectContaining({
			id: 'source-1',
			published_commit: 'commit-1',
		}),
		savedPackage: expect.objectContaining({
			...savedPackageRecord({
				description: 'Shade automation package',
				tags: ['home', 'shades'],
				searchText: 'shade automation',
			}),
			updatedAt: expect.any(String),
		}),
		manifest,
		buildAppBundle: expect.any(Function),
		buildAppClientBundle: expect.any(Function),
		buildModuleBundle: expect.any(Function),
		buildImportableModuleBundle: expect.any(Function),
	})
	const savedPackageArg = mockModule.buildPublishedPackageArtifacts.mock
		.calls[0]?.[0]?.savedPackage as { updatedAt: string } | undefined
	expect(savedPackageArg?.updatedAt).toMatch(
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
	)
	expect(savedPackageArg?.updatedAt).not.toBe('2026-04-20T00:00:00.000Z')
	expect(mockModule.syncJobManagerAlarm).toHaveBeenCalledWith({
		env,
		userId: ownerIdFromStored('user-1'),
	})
	expect(mockModule.getSavedPackageById).toHaveBeenCalledTimes(1)
	expect(
		mockModule.syncJobManagerAlarm.mock.invocationCallOrder[0],
	).toBeGreaterThan(
		mockModule.syncPackageJobsForPackage.mock.invocationCallOrder[0]!,
	)

	mockModule.syncPackageJobsForPackage.mockResolvedValue(false)
	mockModule.syncJobManagerAlarm.mockClear()
	mockSource({
		name: '@kentcdodds/cloudflare',
		kody: { id: 'cloudflare', description: 'Inert community fork' },
	})
	mockModule.getSavedPackageById.mockResolvedValue(null)
	await refresh(env)
	expect(mockModule.syncJobManagerAlarm).not.toHaveBeenCalled()
})

test('refreshSavedPackageProjection omits files when artifact rebuild is skipped', async () => {
	setupDefaultMocks()
	mockModule.loadPackageManifestBySourceId.mockResolvedValue({
		source: { id: 'source-1', entity_id: 'package-1', entity_kind: 'package' },
		manifest: shadeManifest(),
	})
	mockModule.getSavedPackageById.mockResolvedValue(
		savedPackageRecord({ description: 'Shade automation package', tags: [] }),
	)

	const refreshed = await refresh(createEnv(), { rebuildArtifacts: false })

	expect(refreshed).not.toHaveProperty('files')
	expect(mockModule.loadPackageSourceBySourceId).not.toHaveBeenCalled()
	expect(mockModule.buildPublishedPackageArtifacts).not.toHaveBeenCalled()
	expect(mockModule.collectPackageSkills).not.toHaveBeenCalled()
})

test('refreshSavedPackageProjection indexes skills from sourceFiles even when artifact rebuild is skipped', async () => {
	setupDefaultMocks()
	const skillFiles = {
		'package.json': JSON.stringify(shadeManifest()),
		'skills/ship-it/SKILL.md':
			'---\nname: ship-it\ndescription: Ship it.\n---\n\n# Ship\n',
	}
	mockModule.loadPackageSourceFromFiles.mockResolvedValue({
		source: {
			id: 'source-1',
			entity_id: 'package-1',
			entity_kind: 'package',
			published_commit: 'commit-1',
		},
		manifest: shadeManifest(),
		files: skillFiles,
	})
	mockModule.getSavedPackageById.mockResolvedValue(
		savedPackageRecord({ description: 'Shade automation package', tags: [] }),
	)
	mockModule.collectPackageSkills.mockResolvedValue([
		{ name: 'ship-it', resources: [] },
	])
	mockModule.buildPackageSkillsIndex.mockReturnValue({
		version: 1,
		packageId: 'package-1',
		kodyId: '@kentcdodds/shade-automation',
		publishedCommit: 'commit-1',
		skills: [{ name: 'ship-it' }],
	})

	const refreshed = await refresh(createEnv(), {
		rebuildArtifacts: false,
		sourceFiles: skillFiles,
	})

	expect(refreshed).not.toHaveProperty('files')
	expect(mockModule.buildPublishedPackageArtifacts).not.toHaveBeenCalled()
	expect(mockModule.collectPackageSkills).toHaveBeenCalled()
	expect(mockModule.writePackageSkillsIndex).toHaveBeenCalled()
	expect(mockModule.updateSavedPackage).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ hasSkills: true }),
	)
})

test('refreshSavedPackageProjection continues best-effort cleanup when dependent steps fail', async () => {
	consoleError.mockImplementation(() => {})
	setupDefaultMocks()
	const manifest = shadeManifest({
		tags: ['home', 'shades'],
		searchText: 'shade automation',
	})
	mockSource(manifest)
	mockModule.getSavedPackageById.mockResolvedValue(savedPackageRecord())
	mockModule.writePackageSkillsIndex.mockRejectedValue(
		new Error('kv unavailable'),
	)
	const env = createEnv()

	await refresh(env)

	expect(mockModule.syncPackageJobsForPackage).toHaveBeenCalledWith({
		env,
		userId: ownerIdFromStored('user-1'),
		baseUrl: 'https://heykody.dev',
		packageId: 'package-1',
		sourceId: 'source-1',
		manifest,
		actorUserId: undefined,
		actorCredential: null,
	})
	expect(mockModule.syncJobManagerAlarm).not.toHaveBeenCalled()
	// The swallowed skills-index failure is still logged for operators.
	expect(consoleError).toHaveBeenCalledTimes(1)
})

test('refreshSavedPackageProjection preserves hidden and isPrivate across projection refresh', async () => {
	setupDefaultMocks()
	mockModule.buildPackageSearchProjection.mockReturnValue({
		...createProjection(),
		isPrivate: true,
		isInternetVisible: false,
		description: 'Updated description',
	})
	mockSource({
		...shadeManifest({ description: 'Updated description', tags: ['home'] }),
		private: true,
	})
	mockModule.getSavedPackageById.mockResolvedValue(
		savedPackageRecord({ hidden: true }),
	)

	const refreshed = await refresh(createEnv())

	expect(mockModule.updateSavedPackage).toHaveBeenCalled()
	const updateArg = mockModule.updateSavedPackage.mock.calls[0]?.[1] as Record<
		string,
		unknown
	>
	expect(updateArg).not.toHaveProperty('hidden')
	expect(updateArg).not.toHaveProperty('isPrivate')
	expect(updateArg).not.toHaveProperty('kodyId')
	expect(updateArg).toMatchObject({
		userId: ownerIdFromStored('user-1'),
		packageId: 'package-1',
		description: 'Updated description',
	})
	expect(refreshed.record).toMatchObject({
		hidden: true,
		isPrivate: false,
		isInternetVisible: false,
		description: 'Updated description',
	})
})

test('refreshSavedPackageProjection Kit-syncs the actor on a team insert, not the owning org', async () => {
	setupDefaultMocks()
	const teamId = ownerIdFromStored('acme-org')
	const actorUserId = 'person-member-1'
	const env = createEnv(teamId)
	mockSource()
	mockModule.getSavedPackageById.mockResolvedValue(null)
	mockModule.insertSavedPackage.mockResolvedValueOnce(true)

	await refresh(env, {
		userId: teamId,
		actorUserId,
		userEmail: null,
		packageId: 'package-team',
		sourceId: 'source-team',
	})

	expect(mockModule.insertSavedPackage).toHaveBeenCalledWith(
		env.APP_DB,
		expect.objectContaining({ user_id: teamId, id: 'package-team' }),
		env,
		{ actorUserId },
	)
	expect(mockModule.scheduleKitSubscriberSync).toHaveBeenCalledWith({
		env,
		stableUserId: actorUserId,
	})
	expect(mockModule.scheduleKitSubscriberSync).not.toHaveBeenCalledWith(
		expect.objectContaining({ stableUserId: teamId }),
	)
})

test('refreshSavedPackageProjection skips Kit sync on insert when the actor was already stamped', async () => {
	setupDefaultMocks()
	const teamId = ownerIdFromStored('acme-org')
	const actorUserId = 'person-member-already'
	const env = createEnv(teamId)
	mockSource()
	mockModule.getSavedPackageById.mockResolvedValue(null)
	mockModule.insertSavedPackage.mockResolvedValueOnce(false)

	await refresh(env, {
		userId: teamId,
		actorUserId,
		packageId: 'package-team-2',
		sourceId: 'source-team-2',
	})

	expect(mockModule.insertSavedPackage).toHaveBeenCalled()
	expect(mockModule.scheduleKitSubscriberSync).not.toHaveBeenCalled()
})

test('refreshSavedPackageProjection stamps the actor when updating an existing team package', async () => {
	setupDefaultMocks()
	const teamId = ownerIdFromStored('acme-org')
	const actorUserId = 'person-member-2'
	const env = createEnv(teamId)
	mockSource()
	mockModule.getSavedPackageById.mockResolvedValue(
		savedPackageRecord({ userId: teamId }),
	)
	mockModule.stampFirstSavedPackage.mockResolvedValueOnce(true)

	await refresh(env, {
		userId: teamId,
		actorUserId,
		packageId: 'package-1',
		sourceId: 'source-1',
	})

	expect(mockModule.updateSavedPackage).toHaveBeenCalled()
	expect(mockModule.insertSavedPackage).not.toHaveBeenCalled()
	expect(mockModule.stampFirstSavedPackage).toHaveBeenCalledWith(
		env.APP_DB,
		{ stableUserId: actorUserId },
		env,
	)
	expect(mockModule.scheduleKitSubscriberSync).toHaveBeenCalledWith({
		env,
		stableUserId: actorUserId,
	})
})

test('refreshSavedPackageProjection skips Kit sync when the actor was already stamped on update', async () => {
	setupDefaultMocks()
	const teamId = ownerIdFromStored('acme-org')
	const actorUserId = 'person-member-3'
	const env = createEnv(teamId)
	mockSource()
	mockModule.getSavedPackageById.mockResolvedValue(
		savedPackageRecord({ userId: teamId }),
	)
	mockModule.stampFirstSavedPackage.mockResolvedValueOnce(false)

	await refresh(env, {
		userId: teamId,
		actorUserId,
	})

	expect(mockModule.stampFirstSavedPackage).toHaveBeenCalled()
	expect(mockModule.scheduleKitSubscriberSync).not.toHaveBeenCalled()
})

test('refreshSavedPackageProjection does not stamp anyone on actor-free updates', async () => {
	setupDefaultMocks()
	const env = createEnv()
	mockSource()
	mockModule.getSavedPackageById.mockResolvedValue(savedPackageRecord())

	await refresh(env)

	expect(mockModule.updateSavedPackage).toHaveBeenCalled()
	expect(mockModule.stampFirstSavedPackage).not.toHaveBeenCalled()
	expect(mockModule.scheduleKitSubscriberSync).not.toHaveBeenCalled()
})

test('refreshSavedPackageProjection enforces the saved packages entitlement on insert but not on update', async () => {
	setupDefaultMocks()
	const email = 'planned@example.com'
	const userId = testStableUserIdFromEmail(email)
	const limit = planLimits.pro.maxSavedPackages
	if (limit === null) throw new Error('Expected a numeric pro package limit.')
	const env = createEnv(userId, {
		users: [{ email, plan: 'pro' }],
		savedPackageCount: limit,
	})
	mockSource()
	mockModule.getSavedPackageById.mockResolvedValue(null)

	const error = await refresh(env, {
		userId,
		userEmail: email,
		packageId: 'package-new',
		sourceId: 'source-new',
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!isEntitlementLimitError(error)) {
		throw new Error(
			'Expected an EntitlementLimitError from refreshSavedPackageProjection.',
		)
	}
	expect(error.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'saved_packages',
		plan: 'pro',
		limit,
		current: limit,
	})
	expect(mockModule.insertSavedPackage).not.toHaveBeenCalled()

	mockModule.getSavedPackageById.mockResolvedValue(
		savedPackageRecord({ userId, description: 'Shade automation package' }),
	)
	await refresh(env, { userId, userEmail: email })
	expect(mockModule.updateSavedPackage).toHaveBeenCalled()
	expect(mockModule.insertSavedPackage).not.toHaveBeenCalled()
})

test('deleteSavedPackageProjection resyncs the job manager after removing package jobs', async () => {
	setupDefaultMocks()
	const env = createEnv()
	mockPackageRow()
	mockModule.listJobRowsByUserId.mockResolvedValue([
		{ id: 'job-1', source_id: 'source-1' },
		{ id: 'job-2', source_id: 'source-other' },
	])
	mockModule.deleteCommunityForksForPackage.mockResolvedValue(1)

	await deletePackage(env)

	const scoped = {
		env,
		userId: ownerIdFromStored('user-1'),
		packageId: 'package-1',
	}
	expect(mockModule.cleanupArtifactReposForPackage).toHaveBeenCalledWith({
		env,
		userId: ownerIdFromStored('user-1'),
		sourceId: 'source-1',
	})
	expect(mockModule.deleteEntitySource).toHaveBeenCalledWith(env, {
		id: 'source-1',
		userId: ownerIdFromStored('user-1'),
	})
	expect(
		mockModule.deleteEntitySource.mock.invocationCallOrder[0],
	).toBeGreaterThan(
		mockModule.cleanupArtifactReposForPackage.mock.invocationCallOrder[0]!,
	)
	expect(mockModule.deleteJobRow).toHaveBeenCalledTimes(1)
	expect(mockModule.deleteJobRow).toHaveBeenCalledWith({
		userId: ownerIdFromStored('user-1'),
		jobId: 'job-1',
	})
	expect(mockModule.deleteAllPackageScopedSecrets).toHaveBeenCalledWith(scoped)
	expect(mockModule.removeAllSecretApprovalsForPackage).toHaveBeenCalledWith(
		scoped,
	)
	expect(mockModule.deleteSavedPackage).toHaveBeenCalledWith(env.APP_DB, {
		userId: ownerIdFromStored('user-1'),
		packageId: 'package-1',
	})
	expect(mockModule.deleteCommunityForksForPackage).toHaveBeenCalledWith(
		env.APP_DB,
		{
			userId: ownerIdFromStored('user-1'),
			packageId: 'package-1',
			sourceId: 'source-1',
		},
	)
	expect(mockModule.invalidateCommunityPublicCache).toHaveBeenCalledTimes(1)
	expect(mockModule.deleteSavedPackageVector).toHaveBeenCalledWith(
		env,
		'package-1',
	)
	expect(mockModule.syncJobManagerAlarm).toHaveBeenCalledWith({
		env,
		userId: ownerIdFromStored('user-1'),
	})
	expect(
		mockModule.syncJobManagerAlarm.mock.invocationCallOrder[0],
	).toBeGreaterThan(mockModule.deleteSavedPackage.mock.invocationCallOrder[0]!)
	expect(mockModule.unpublishCommunityListing).not.toHaveBeenCalled()
})

test('deleteSavedPackageProjection removes app rate-limit counters after deleting a package', async () => {
	setupDefaultMocks()
	const env = createEnv()
	mockPackageRow()
	mockModule.deleteSavedPackage.mockResolvedValue(true)

	await deletePackage(env)

	expect(mockModule.deletePackageAppRateLimits).toHaveBeenCalledWith(
		'package-1:',
		'package-1;',
	)
})

test('deleteSavedPackageProjection unpublishes an active listing before removing the package', async () => {
	setupDefaultMocks()
	const env = createEnv()
	mockPackageRow()
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue({
		id: 'listing-1',
		status: 'active',
	})

	await deletePackage(env, 'package-1', 'actor-1')

	expect(mockModule.getCommunityListingByOwnerAndPackage).toHaveBeenCalledWith(
		env.APP_DB,
		{ ownerUserId: ownerIdFromStored('user-1'), packageId: 'package-1' },
	)
	expect(mockModule.unpublishCommunityListing).toHaveBeenCalledWith({
		env,
		userId: ownerIdFromStored('user-1'),
		actorUserId: 'actor-1',
		listingId: 'listing-1',
	})
	expect(
		mockModule.unpublishCommunityListing.mock.invocationCallOrder[0],
	).toBeLessThan(mockModule.deleteSavedPackage.mock.invocationCallOrder[0]!)

	mockModule.unpublishCommunityListing.mockClear()
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue({
		id: 'listing-2',
		status: 'delisted',
	})
	await deletePackage(env)
	expect(mockModule.unpublishCommunityListing).not.toHaveBeenCalled()
	expect(mockModule.deleteSavedPackage).toHaveBeenCalled()
})

test('deleteSavedPackageProjection continues best-effort cleanup when dependent steps fail', async () => {
	consoleWarn.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
	setupDefaultMocks()
	const env = createEnv()
	mockPackageRow()
	mockModule.deleteEntitySource.mockRejectedValueOnce(
		new Error('d1 unavailable'),
	)

	await deletePackage(env)

	expect(mockModule.deleteSavedPackage).toHaveBeenCalledWith(env.APP_DB, {
		userId: ownerIdFromStored('user-1'),
		packageId: 'package-1',
	})
	expect(mockModule.deleteSavedPackageVector).toHaveBeenCalledWith(
		env,
		'package-1',
	)
	expect(mockModule.syncJobManagerAlarm).not.toHaveBeenCalled()
	// The swallowed entity source cleanup failure is still logged.
	expect(consoleWarn).toHaveBeenCalledTimes(1)

	mockModule.deleteSavedPackageVector.mockClear()
	mockModule.removePackageSkillsIndexEntries.mockRejectedValue(
		new Error('kv unavailable'),
	)
	await deletePackage(env)
	expect(mockModule.deleteSavedPackageVector).toHaveBeenCalledWith(
		env,
		'package-1',
	)
	expect(mockModule.syncJobManagerAlarm).not.toHaveBeenCalled()
	expect(consoleError).toHaveBeenCalledWith(
		expect.stringContaining(
			'"message":"package skills projection update failed"',
		),
	)
})

const uuidPackageId = 'b2fda105-005a-4e2b-9f22-1513b6752da2'
const otherPackageId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const packageStorageId = `package:${encodeURIComponent(uuidPackageId)}`
const facetStorageId = `${uuidPackageId}:facet:main`
const jobStorageId = `job:package-job:${uuidPackageId}:event-runner`
const otherJobStorageId = `job:package-job:${otherPackageId}:nightly`
const bucket = (storageId: string, userId = 'user-1') => ({
	userId,
	storageId,
})

test('deleteSavedPackageProjection clears package-owned storage buckets and inventory rows', async () => {
	setupDefaultMocks()
	const otherUserBucket = bucket(packageStorageId, 'user-2')
	const otherPackageBucket = bucket(
		`package:${encodeURIComponent(otherPackageId)}`,
	)
	const ownedIds = [
		packageStorageId,
		uuidPackageId,
		jobStorageId,
		facetStorageId,
	]
	const storageBuckets = [
		...ownedIds.map((id) => bucket(id)),
		otherUserBucket,
		otherPackageBucket,
		bucket(otherJobStorageId),
	]
	const env = createEnv('user-1', { storageBuckets })
	mockPackageRow(uuidPackageId)
	mockModule.listJobRowsByUserId.mockResolvedValue([
		{
			id: `package-job:${uuidPackageId}:event-runner`,
			source_id: 'source-1',
			storage_id: jobStorageId,
		},
	])

	await deletePackage(env, uuidPackageId)

	expect(clearedStorageIds()).toEqual(expect.arrayContaining(ownedIds))
	expect(clearedStorageIds()).not.toContain(otherPackageBucket.storageId)
	expect(clearedStorageIds()).not.toContain(otherJobStorageId)
	for (const call of mockModule.storageRunnerRpc.mock.calls) {
		expect(call[0]).toMatchObject({ userId: ownerIdFromStored('user-1') })
	}
	// Other users' and other packages' inventory rows survive.
	expect(storageBuckets).toEqual([
		otherUserBucket,
		otherPackageBucket,
		bucket(otherJobStorageId),
	])
})

test('deleteSavedPackageProjection aborts before source cleanup when clearStorage fails', async () => {
	consoleWarn.mockImplementation(() => {})
	setupDefaultMocks()
	const storageBuckets = [
		bucket(packageStorageId),
		bucket(facetStorageId),
		bucket(uuidPackageId),
	]
	const env = createEnv('user-1', { storageBuckets })
	mockPackageRow(uuidPackageId)
	mockModule.listJobRowsByUserId.mockResolvedValue([
		{
			id: `package-job:${uuidPackageId}:event-runner`,
			source_id: 'source-1',
			storage_id: jobStorageId,
		},
	])
	mockModule.clearStorage.mockImplementation(async () => {
		const call = mockModule.storageRunnerRpc.mock.calls.at(-1)?.[0] as
			| { storageId: string }
			| undefined
		if (call?.storageId === facetStorageId) {
			throw new Error('do unavailable')
		}
		return { ok: true as const }
	})

	await expect(deletePackage(env, uuidPackageId)).rejects.toThrow(
		/Package storage cleanup failed/,
	)

	expect(mockModule.deleteSavedPackage).not.toHaveBeenCalled()
	expect(mockModule.deleteEntitySource).not.toHaveBeenCalled()
	expect(mockModule.deleteCommunityForksForPackage).not.toHaveBeenCalled()
	expect(mockModule.deleteJobRow).not.toHaveBeenCalled()
	expect(storageBuckets.map((row) => row.storageId)).toEqual([facetStorageId])
	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining('"message":"package storage clear failed"'),
	)
})

test('deleteSavedPackageProjection aborts when storage inventory lookup fails', async () => {
	consoleWarn.mockImplementation(() => {})
	setupDefaultMocks()
	const env = createEnv('user-1', { failStorageInventory: true })
	mockPackageRow(uuidPackageId)

	await expect(deletePackage(env, uuidPackageId)).rejects.toThrow(
		/Package storage cleanup failed/,
	)

	expect(mockModule.deleteSavedPackage).not.toHaveBeenCalled()
	expect(mockModule.deleteEntitySource).not.toHaveBeenCalled()
	expect(mockModule.deleteCommunityForksForPackage).not.toHaveBeenCalled()
	expect(mockModule.clearStorage).not.toHaveBeenCalled()
	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining(
			'"message":"package storage inventory lookup failed"',
		),
	)
})

test('deleteSavedPackageProjection cleans secrets and deterministic storage when the projection is missing', async () => {
	setupDefaultMocks()
	const storageBuckets = [
		bucket(packageStorageId),
		bucket(uuidPackageId),
		bucket(facetStorageId),
	]
	const env = createEnv('user-1', { storageBuckets })
	mockModule.getSavedPackageById.mockResolvedValue(null)

	await deletePackage(env, uuidPackageId)

	const scoped = {
		env,
		userId: ownerIdFromStored('user-1'),
		packageId: uuidPackageId,
	}
	expect(mockModule.deleteAllPackageScopedSecrets).toHaveBeenCalledWith(scoped)
	expect(mockModule.removeAllSecretApprovalsForPackage).toHaveBeenCalledWith(
		scoped,
	)
	expect(clearedStorageIds()).toEqual(
		expect.arrayContaining([packageStorageId, uuidPackageId, facetStorageId]),
	)
	expect(mockModule.clearStorage).toHaveBeenCalled()
	expect(storageBuckets).toEqual([])
})

test('filterPackageOwnedStorageIdsFromInventory exact-matches non-UUIDs and UUID-gates prefixes', () => {
	const inventory = [
		'job',
		'package:job',
		'job:ad-hoc-1',
		otherJobStorageId,
		'job:facet:main',
		'%',
		'package:%25',
		'exec:scratch-1',
		`${otherPackageId}:facet:main`,
	]
	const cases: Array<[string, Array<string>, Array<string>]> = [
		['job', inventory, ['job', 'package:job']],
		['%', inventory, ['%', 'package:%25']],
		['exec', [...inventory, 'exec', 'package:exec'], ['exec', 'package:exec']],
		[
			uuidPackageId,
			[
				uuidPackageId,
				packageStorageId,
				facetStorageId,
				jobStorageId,
				'job:ad-hoc-1',
				otherJobStorageId,
				`${otherPackageId}:facet:main`,
				'exec:scratch-1',
			],
			[uuidPackageId, packageStorageId, facetStorageId, jobStorageId],
		],
	]
	expect(
		cases.map(([packageId, storageIds]) =>
			filterPackageOwnedStorageIdsFromInventory({
				packageId,
				storageIds,
			}).toSorted(),
		),
	).toEqual(cases.map(([, , owned]) => owned.toSorted()))
})

test('deleteSavedPackageProjection does not clear unrelated buckets for exact-match package ids', async () => {
	setupDefaultMocks()
	const storageBuckets = [
		'job',
		'package:job',
		'job:ad-hoc-1',
		otherJobStorageId,
		'job:facet:main',
	].map((id) => bucket(id))
	const env = createEnv('user-1', { storageBuckets })
	mockPackageRow('job', 'source-job')

	await deletePackage(env, 'job')

	expect(clearedStorageIds().toSorted()).toEqual(
		['job', 'package:job'].toSorted(),
	)
	expect(storageBuckets.map((row) => row.storageId).toSorted()).toEqual(
		['job:ad-hoc-1', otherJobStorageId, 'job:facet:main'].toSorted(),
	)
})

function createEntitlementsDatabase(input: {
	users?: Array<{ email: string; plan: string | null }>
	savedPackageCount?: number
	userId: string
	storageBuckets?: Array<{ userId: string; storageId: string }>
	failStorageInventory?: boolean
}) {
	const users = input.users ?? []
	const savedPackageCount = input.savedPackageCount ?? 0
	const storageBuckets = input.storageBuckets ?? []
	const writeLeaseDb = createPermissiveAccountWriteLeaseDbHooks()

	return {
		async batch(statements: Array<{ run: () => Promise<unknown> }>) {
			const results = []
			for (const statement of statements) {
				results.push(await statement.run())
			}
			return results
		},
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async run() {
							if (
								query.includes(
									'DELETE FROM user_storage_buckets WHERE user_id = ? AND storage_id = ?',
								)
							) {
								const userId = String(params[0])
								const storageId = String(params[1])
								const before = storageBuckets.length
								for (
									let index = storageBuckets.length - 1;
									index >= 0;
									index--
								) {
									const row = storageBuckets[index]
									if (
										row &&
										row.userId === userId &&
										row.storageId === storageId
									) {
										storageBuckets.splice(index, 1)
									}
								}
								return { meta: { changes: before - storageBuckets.length } }
							}
							// Deleting a package releases the slugs it retired and its
							// credential mappings.
							if (
								query.includes('DELETE FROM package_slug_redirects') ||
								query.includes('DELETE FROM package_kody_id_redirects') ||
								query.includes('DELETE FROM credential_mappings')
							) {
								return { meta: { changes: 0 } }
							}
							if (query.includes('DELETE FROM package_app_rate_limits')) {
								mockModule.deletePackageAppRateLimits(...params)
								return { meta: { changes: 0 } }
							}
							throw new Error(`Unsupported run query: ${query}`)
						},
						async first<T>() {
							if (writeLeaseDb.supportsDeletingAtQuery(query)) {
								return writeLeaseDb.deletingAtFirstResult() as T
							}
							if (
								query.includes('SELECT plan, stripe_plan') ||
								query.includes('entitlement_ladder')
							) {
								const pairLookup = query.includes('email = ?')
								const user = pairLookup
									? users.find(
											(row) =>
												row.email === params[0] && input.userId === params[1],
										)
									: users.find((row) => row.email === params[0])
								return (user ? { plan: user.plan } : null) as T | null
							}
							if (query.includes('SELECT first_saved_package_at FROM users')) {
								return { first_saved_package_at: null } as T
							}
							// Synthetic-context probe: no users row in this mock, so the
							// storage reserve path applies free-plan semantics without a DO.
							if (query.includes('SELECT 1 AS present FROM users')) {
								if (query.includes('email = ?')) {
									const user = users.find(
										(row) =>
											row.email === params[0] && input.userId === params[1],
									)
									return user ? ({ present: 1 } as T) : null
								}
								return null
							}
							if (
								query.includes('SELECT COUNT(*) AS count FROM saved_packages')
							) {
								return { count: savedPackageCount } as T
							}
							if (isLiveSeatCountQuery(query)) {
								return mockLiveSeatCountRow() as T
							}
							const storageByteTables = [
								'email_attachments',
								'email_messages',
								'secret_entries',
								'mcp_memories',
								'saved_packages',
								'entity_sources',
								'jobs',
								'published_bundle_artifacts',
							]
							if (
								storageByteTables.some((table) =>
									query.includes(`FROM ${table}`),
								)
							) {
								return { count: 0 } as T
							}
							throw new Error(`Unsupported first query: ${query}`)
						},
						async all<T>() {
							if (query.includes('FROM org_limit_overrides')) {
								return { results: [] as Array<T> }
							}
							if (
								query.includes('FROM user_storage_buckets') &&
								query.includes('SELECT storage_id AS storageId') &&
								query.includes('WHERE user_id = ?')
							) {
								if (input.failStorageInventory) {
									throw new Error('storage inventory unavailable')
								}
								const userId = String(params[0])
								const results = storageBuckets
									.filter((row) => row.userId === userId)
									.map((row) => ({ storageId: row.storageId }))
									.sort((left, right) =>
										left.storageId.localeCompare(right.storageId),
									)
								return { results: results as Array<T> }
							}
							// deleteSavedPackageProjection lists retired leaves before
							// clearing redirect rows so the package-app slug cache can
							// evict them; this mock has no redirect fixtures.
							if (
								query.includes('FROM package_slug_redirects') &&
								query.includes('FROM package_kody_id_redirects')
							) {
								return { results: [] as Array<T> }
							}
							throw new Error(`Unsupported all query: ${query}`)
						},
					}
				},
			}
		},
	} as unknown as D1Database
}
