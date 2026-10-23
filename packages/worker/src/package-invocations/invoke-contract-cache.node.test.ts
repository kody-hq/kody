import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { type PackageInvokeInput } from '#worker/mcp/runtime-helper-manifest.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { checkPackageInvokeForRuntimeWithPreloads } from './invoke-check.ts'
import {
	invalidateInvokeContractFreshness,
	invokeContractFreshnessTtlMs,
	loadModuleArtifactWithCommitCache,
	resolvePackageAppSlugWithFreshnessCache,
} from './invoke-contract-cache.ts'
import {
	ensureModuleArtifact,
	loadInvokeManifestBySourceId,
} from './module-artifacts.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	resolveSavedPackageRef: vi.fn(),
	getSavedPackageByName: vi.fn(),
	getEntitySourceById: vi.fn(),
	loadPublishedEntityManifest: vi.fn(),
	loadPublishedEntitySource: vi.fn(),
	loadPublishedBundleArtifactByIdentity: vi.fn(),
	persistPublishedBundleArtifact: vi.fn(),
	buildKodyModuleBundle: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	resolveSavedPackageRef: (...args: Array<unknown>) =>
		mockModule.resolveSavedPackageRef(...args),
	getSavedPackageByName: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByName(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/repo/published-source.ts', () => ({
	loadPublishedEntityManifest: (...args: Array<unknown>) =>
		mockModule.loadPublishedEntityManifest(...args),
	loadPublishedEntitySource: (...args: Array<unknown>) =>
		mockModule.loadPublishedEntitySource(...args),
}))

vi.mock('#worker/package-runtime/published-bundle-artifacts.ts', () => ({
	loadPublishedBundleArtifactByIdentity: (...args: Array<unknown>) =>
		mockModule.loadPublishedBundleArtifactByIdentity(...args),
	persistPublishedBundleArtifact: (...args: Array<unknown>) =>
		mockModule.persistPublishedBundleArtifact(...args),
}))

vi.mock('#worker/package-runtime/module-graph.ts', () => ({
	buildKodyModuleBundle: (...args: Array<unknown>) =>
		mockModule.buildKodyModuleBundle(...args),
}))

/**
 * Every mock above stands in for exactly one awaited D1 or KV load the
 * contract check would otherwise perform per call. The warm-path tests assert
 * all of them stay at zero.
 */
const contractCheckLoadMocks = [
	['saved package by id (D1)', mockModule.getSavedPackageById],
	['saved package by kody id (D1)', mockModule.resolveSavedPackageRef],
	['saved package by name (D1)', mockModule.getSavedPackageByName],
	['entity source row (D1)', mockModule.getEntitySourceById],
	['published manifest snapshot (KV)', mockModule.loadPublishedEntityManifest],
	['published source snapshot (KV)', mockModule.loadPublishedEntitySource],
	[
		'bundle artifact identity + payload (D1 + KV)',
		mockModule.loadPublishedBundleArtifactByIdentity,
	],
] as const

function countContractCheckLoads() {
	return Object.fromEntries(
		contractCheckLoadMocks.map(([label, mock]) => [
			label,
			mock.mock.calls.length,
		]),
	)
}

function clearContractCheckLoadCounters() {
	for (const [, mock] of contractCheckLoadMocks) {
		mock.mockClear()
	}
}

const zeroContractCheckLoads = Object.fromEntries(
	contractCheckLoadMocks.map(([label]) => [label, 0]),
)

function createFixture(input: {
	userId: string
	publishedCommit: string
	suffix?: string
	packageName?: string
	kodyId?: string
}) {
	const suffix = input.suffix ?? input.userId
	const sourceId = `source-${suffix}`
	const savedPackage: SavedPackageRecord = {
		id: `pkg-${suffix}`,
		userId: ownerIdFromStored(input.userId),
		name: input.packageName ?? '@kentcdodds/sentry-triage',
		kodyId: input.kodyId ?? 'sentry-triage',
		description: 'Sentry triage helpers',
		tags: [],
		searchText: null,
		sourceId,
		hasApp: false,
		hasSkills: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		lockedAt: null,
		createdAt: '2026-07-01T00:00:00.000Z',
		updatedAt: '2026-07-01T00:00:00.000Z',
	}
	const source = {
		id: sourceId,
		user_id: input.userId,
		entity_kind: 'package' as const,
		entity_id: savedPackage.id,
		repo_id: `repo-${suffix}`,
		published_commit: input.publishedCommit,
		indexed_commit: input.publishedCommit,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-07-01T00:00:00.000Z',
		updated_at: '2026-07-01T00:00:00.000Z',
	}
	const manifestContent = JSON.stringify({
		name: savedPackage.name,
		exports: {
			'./get-issue-state': './src/get-issue-state.ts',
		},
		kody: {
			id: savedPackage.kodyId,
			description: 'Sentry triage helpers',
		},
	})
	const artifact = {
		version: 1,
		kind: 'module' as const,
		artifactName: './get-issue-state',
		sourceId,
		publishedCommit: input.publishedCommit,
		entryPoint: 'src/get-issue-state.ts',
		mainModule: 'main.js',
		modules: { 'main.js': 'export default async () => ({ ok: true })' },
		dependencies: [],
		dynamicDependencies: [],
		packageContext: {
			packageId: savedPackage.id,
			kodyId: savedPackage.kodyId,
			sourceId,
		},
		createdAt: '2026-07-01T00:00:00.000Z',
	}
	return { savedPackage, source, manifestContent, artifact }
}

type Fixture = ReturnType<typeof createFixture>

function seedFixtures(fixturesByUserId: Record<string, Fixture>) {
	const byKodyId = (userId: string, kodyId: string) => {
		const fixture = fixturesByUserId[userId]
		return fixture && fixture.savedPackage.kodyId === kodyId
			? fixture.savedPackage
			: null
	}
	mockModule.getSavedPackageById.mockResolvedValue(null)
	mockModule.resolveSavedPackageRef.mockImplementation(
		async (_db: unknown, input: { userId: string; ref: string }) =>
			byKodyId(input.userId, input.ref),
	)
	mockModule.getSavedPackageByName.mockImplementation(
		async (_db: unknown, input: { userId: string; name: string }) => {
			const fixture = fixturesByUserId[input.userId]
			return fixture?.savedPackage.name === input.name
				? fixture.savedPackage
				: null
		},
	)
	mockModule.getEntitySourceById.mockImplementation(
		async (_db: unknown, sourceId: string) =>
			Object.values(fixturesByUserId).find(
				(fixture) => fixture.source.id === sourceId,
			)?.source ?? null,
	)
	mockModule.loadPublishedEntityManifest.mockImplementation(
		async (input: { sourceId: string }) => {
			const fixture = Object.values(fixturesByUserId).find(
				(candidate) => candidate.source.id === input.sourceId,
			)
			if (!fixture) throw new Error(`No manifest for ${input.sourceId}`)
			return { source: fixture.source, content: fixture.manifestContent }
		},
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: { sourceId: string }) => {
			const fixture = Object.values(fixturesByUserId).find(
				(candidate) => candidate.source.id === input.sourceId,
			)
			if (!fixture) return null
			return {
				row: {
					kvKey: 'kv-key',
					publishedCommit: fixture.artifact.publishedCommit,
				},
				artifact: fixture.artifact,
			}
		},
	)
}

function createEnv() {
	return {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {},
	} as Env
}

async function runContractCheck(input: {
	userId: string
	specifier?: PackageInvokeInput['specifier']
	callerKind?: 'package' | 'execute'
	callingPackageId?: string
}) {
	return await checkPackageInvokeForRuntimeWithPreloads({
		env: createEnv(),
		baseUrl: 'https://kody.dev',
		operationName: 'packages.invoke',
		userId: input.userId,
		rawInput: {
			specifier:
				input.specifier ?? 'kody:@kentcdodds/sentry-triage/get-issue-state',
			options: { params: { issueId: 'issue-1' } },
		},
		callerKind: input.callerKind,
		callingPackageId: input.callingPackageId,
	})
}

function publishedCommitOf(
	check: Awaited<ReturnType<typeof runContractCheck>>,
) {
	return check.result.ok ? check.result.contract.publishedCommit : null
}

function mockModuleArtifactRebuild(
	fixture: Fixture,
	files: Record<string, string>,
	snapshotCreatedAt?: string | null,
) {
	mockModule.getEntitySourceById.mockResolvedValue(fixture.source)
	mockModule.loadPublishedEntitySource.mockResolvedValue({
		source: fixture.source,
		files,
		snapshotCreatedAt: snapshotCreatedAt ?? null,
	})
	mockModule.buildKodyModuleBundle.mockResolvedValue({
		mainModule: 'main.js',
		modules: { 'main.js': 'export default async () => ({ ok: true })' },
		dependencies: [],
		dynamicDependencies: [],
	})
	mockModule.persistPublishedBundleArtifact.mockResolvedValue('kv-key')
}

test('contract checks only resolve packages in the caller org', async () => {
	seedFixtures({
		'user-1': createFixture({
			userId: ownerIdFromStored('user-1'),
			publishedCommit: 'commit-1',
		}),
		'org-owner': createFixture({
			userId: ownerIdFromStored('org-owner'),
			publishedCommit: 'commit-1',
			packageName: '@acme/github',
			kodyId: 'github',
		}),
	})
	const specifier = 'kody:@acme/github/get-issue-state'

	const denied = await runContractCheck({
		userId: ownerIdFromStored('user-1'),
		specifier,
	})
	expect(denied.result.ok).toBe(false)
	if (denied.result.ok) throw new Error('Expected the contract check to deny.')
	expect(denied.result.message).toContain('could not be resolved in this org')
	expect(denied.preloads).toBeNull()

	const fromOwningOrg = await runContractCheck({
		userId: ownerIdFromStored('org-owner'),
		specifier,
	})
	expect(fromOwningOrg.result.ok).toBe(true)
})

test('a republish is picked up by same-isolate invalidation, or in other isolates once the freshness TTL elapses', async () => {
	vi.useFakeTimers()
	try {
		const userId = ownerIdFromStored('user-republish')
		const publish = (publishedCommit: string) => {
			const fixture = createFixture({ userId, publishedCommit })
			seedFixtures({ [userId]: fixture })
			return fixture
		}
		const check = async () => {
			const result = await runContractCheck({ userId })
			expect(result.preloads?.moduleArtifact.artifact.publishedCommit).toBe(
				publishedCommitOf(result),
			)
			return publishedCommitOf(result)
		}

		const fixture = publish('commit-1')
		expect(await check()).toBe('commit-1')

		// Republish: within the freshness TTL the warm cache serves the old
		// contract until the projection refresh invalidates in its own isolate.
		publish('commit-2')
		expect(await check()).toBe('commit-1')
		invalidateInvokeContractFreshness({
			userId,
			packageIdOrKodyIds: [
				fixture.savedPackage.id,
				fixture.savedPackage.kodyId,
				`kody:${fixture.savedPackage.name}`,
			],
			sourceId: fixture.source.id,
		})
		expect(await check()).toBe('commit-2')

		// Republish observed only through D1/KV — no invalidation reaches this
		// isolate.
		publish('commit-3')
		expect(await check()).toBe('commit-2')
		vi.setSystemTime(Date.now() + invokeContractFreshnessTtlMs + 1)
		expect(await check()).toBe('commit-3')
	} finally {
		vi.useRealTimers()
	}
})

test('contract-check caches never serve entries across users', async () => {
	seedFixtures({
		'user-1': createFixture({
			userId: ownerIdFromStored('user-1'),
			publishedCommit: 'commit-1',
		}),
		'user-2': createFixture({
			userId: ownerIdFromStored('user-2'),
			publishedCommit: 'commit-2',
		}),
	})

	expect(
		publishedCommitOf(
			await runContractCheck({ userId: ownerIdFromStored('user-1') }),
		),
	).toBe('commit-1')
	clearContractCheckLoadCounters()
	const other = await runContractCheck({ userId: ownerIdFromStored('user-2') })

	expect(publishedCommitOf(other)).toBe('commit-2')
	expect(other.preloads?.savedPackage.id).toBe('pkg-user-2')
	// The second user's check must load its own rows, not reuse user-1's.
	expect(mockModule.getSavedPackageByName).toHaveBeenCalledTimes(1)
	expect(mockModule.getEntitySourceById).toHaveBeenCalledTimes(1)
})

test('warm contract checks perform zero D1/KV loads until invalidation clears the specifier cache', async () => {
	const orgFixture = createFixture({
		userId: ownerIdFromStored('org-owner'),
		publishedCommit: 'commit-org',
		packageName: '@acme/sentry-triage',
	})
	seedFixtures({ 'org-owner': orgFixture })
	invalidateInvokeContractFreshness({
		userId: ownerIdFromStored('org-owner'),
		packageIdOrKodyIds: [
			orgFixture.savedPackage.id,
			orgFixture.savedPackage.kodyId,
			`kody:${orgFixture.savedPackage.name}`,
		],
		sourceId: orgFixture.source.id,
	})
	const check = () =>
		runContractCheck({
			userId: ownerIdFromStored('org-owner'),
			specifier: 'kody:@acme/sentry-triage/get-issue-state',
		})

	const beforeDelete = await check()
	expect(beforeDelete.result.ok).toBe(true)
	expect(beforeDelete.preloads?.savedPackage.id).toBe(
		orgFixture.savedPackage.id,
	)
	expect(mockModule.getEntitySourceById).toHaveBeenCalledTimes(1)
	expect(mockModule.loadPublishedEntityManifest).toHaveBeenCalledTimes(1)
	expect(
		mockModule.loadPublishedBundleArtifactByIdentity,
	).toHaveBeenCalledTimes(1)

	clearContractCheckLoadCounters()
	const warm = await check()
	expect(warm.result.ok).toBe(true)
	expect(publishedCommitOf(warm)).toBe('commit-org')
	expect(warm.preloads?.moduleArtifact.artifact.publishedCommit).toBe(
		'commit-org',
	)
	expect(countContractCheckLoads()).toEqual(zeroContractCheckLoads)

	seedFixtures({})
	invalidateInvokeContractFreshness({
		userId: ownerIdFromStored('org-owner'),
		packageIdOrKodyIds: [
			orgFixture.savedPackage.id,
			orgFixture.savedPackage.kodyId,
			`kody:${orgFixture.savedPackage.name}`,
		],
		sourceId: orgFixture.source.id,
	})

	const afterDelete = await check()
	expect(afterDelete.result.ok).toBe(false)
	if (afterDelete.result.ok) {
		throw new Error('Expected the contract check to fail after delete.')
	}
	expect(afterDelete.result.message).toContain('could not be resolved')
})

test('an artifact rebuild resolves its entry point from the fresh source, not the cached manifest', async () => {
	const userId = ownerIdFromStored('user-rebuild')
	const sourceId = 'source-rebuild'
	const buildManifestContent = (entryPoint: string) =>
		JSON.stringify({
			name: '@kentcdodds/sentry-triage',
			exports: { './probe': entryPoint },
			kody: { id: 'sentry-triage', description: 'probe' },
		})
	const fixtureAt = (publishedCommit: string) => {
		const fixture = createFixture({
			userId,
			publishedCommit,
			suffix: 'rebuild',
		})
		return { ...fixture, source: { ...fixture.source, id: sourceId } }
	}
	const v1 = fixtureAt('commit-1')

	// Warm only the freshness-tier row cache with the commit-1 manifest, where
	// the probe export points at the v1 entry point (no artifact exists for the
	// identity yet).
	mockModule.getEntitySourceById.mockResolvedValue(v1.source)
	mockModule.loadPublishedEntityManifest.mockResolvedValue({
		source: v1.source,
		content: buildManifestContent('./src/probe-v1.ts'),
	})
	await loadInvokeManifestBySourceId({ env: createEnv(), userId, sourceId })

	// Republish lands between the manifest load and the first-ever rebuild: the
	// fresh source is commit-2 and moves the probe export to the v2 entry point,
	// while this isolate's freshness cache still holds the commit-1 row.
	mockModuleArtifactRebuild(fixtureAt('commit-2'), {
		'package.json': buildManifestContent('./src/probe-v2.ts'),
		'src/probe-v2.ts': 'export default async function probe() { return 2 }',
	})
	mockModule.loadPublishedBundleArtifactByIdentity
		.mockResolvedValueOnce(null)
		.mockResolvedValueOnce({
			row: { kvKey: 'kv-key' },
			artifact: { publishedCommit: 'commit-2', entryPoint: 'src/probe-v2.ts' },
		})

	const rebuilt = await ensureModuleArtifact({
		env: createEnv(),
		baseUrl: 'https://kody.dev',
		savedPackage: { ...v1.savedPackage, sourceId },
		selector: { kind: 'export', exportName: 'probe' },
		userId,
	})

	// Bundle and persisted identity both use the v2 entry point, even
	// though this isolate's cached manifest still says v1.
	expect(mockModule.buildKodyModuleBundle).toHaveBeenCalledWith(
		expect.objectContaining({ entryPoint: 'src/probe-v2.ts' }),
	)
	expect(mockModule.persistPublishedBundleArtifact).toHaveBeenCalledWith(
		expect.objectContaining({ entryPoint: 'src/probe-v2.ts' }),
	)
	expect(rebuilt.artifact.publishedCommit).toBe('commit-2')
	expect(rebuilt.entryPoint).toBe('src/probe-v2.ts')
})

test('ensureModuleArtifact rebuilds when the identity artifact is stale or its row lacks a published commit', async () => {
	for (const [suffix, staleIdentity] of [
		[
			'stale-artifact',
			{ rowCommit: 'commit-old', artifactCommit: 'commit-old' },
		],
		['null-row', { rowCommit: null, artifactCommit: 'commit-new' }],
	] as const) {
		mockModule.persistPublishedBundleArtifact.mockClear()
		const fixture = createFixture({
			userId: `user-${suffix}`,
			publishedCommit: 'commit-new',
			suffix,
		})
		mockModuleArtifactRebuild(fixture, {
			'package.json': fixture.manifestContent,
			'src/get-issue-state.ts':
				'export default async function main() { return "new" }',
		})
		mockModule.loadPublishedEntityManifest.mockResolvedValue({
			source: fixture.source,
			content: fixture.manifestContent,
		})
		mockModule.loadPublishedBundleArtifactByIdentity
			.mockResolvedValueOnce({
				row: { publishedCommit: staleIdentity.rowCommit },
				artifact: {
					...fixture.artifact,
					publishedCommit: staleIdentity.artifactCommit,
				},
			})
			.mockResolvedValueOnce({
				row: { publishedCommit: 'commit-new' },
				artifact: fixture.artifact,
			})

		const rebuilt = await ensureModuleArtifact({
			env: createEnv(),
			baseUrl: 'https://kody.dev',
			savedPackage: fixture.savedPackage,
			selector: { kind: 'export', exportName: 'get-issue-state' },
			userId: fixture.savedPackage.userId,
		})

		expect(mockModule.persistPublishedBundleArtifact).toHaveBeenCalledTimes(1)
		expect(rebuilt.artifact.publishedCommit).toBe('commit-new')
	}
})

test('ensureModuleArtifact keeps serving the previous npm-backed bundle while a republish rebuild is still in flight', async () => {
	const fixture = {
		...createFixture({
			userId: ownerIdFromStored('user-npm-window'),
			publishedCommit: 'commit-new',
			suffix: 'npm-window',
		}),
	}
	fixture.source = {
		...fixture.source,
		updated_at: '2026-07-01T00:00:00.000Z',
	}
	const previousArtifact = {
		...fixture.artifact,
		publishedCommit: 'commit-old',
	}
	const npmFiles = {
		'package.json': JSON.stringify({
			name: fixture.savedPackage.name,
			exports: {
				'./get-issue-state': './src/get-issue-state.ts',
			},
			dependencies: {
				react: '^19.0.0',
			},
			kody: {
				id: fixture.savedPackage.kodyId,
				description: 'Sentry triage helpers',
			},
		}),
		'src/get-issue-state.ts':
			'export default async function main() { return "new" }',
	}
	mockModule.persistPublishedBundleArtifact.mockClear()
	mockModule.buildKodyModuleBundle.mockClear()
	mockModuleArtifactRebuild(fixture, npmFiles, new Date().toISOString())
	mockModule.loadPublishedEntityManifest.mockResolvedValue({
		source: fixture.source,
		content: npmFiles['package.json'],
	})
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue({
		row: { publishedCommit: 'commit-old' },
		artifact: previousArtifact,
	})

	const served = await ensureModuleArtifact({
		env: createEnv(),
		baseUrl: 'https://kody.dev',
		savedPackage: fixture.savedPackage,
		selector: { kind: 'export', exportName: 'get-issue-state' },
		userId: fixture.savedPackage.userId,
	})

	expect(served.artifact.publishedCommit).toBe('commit-old')
	expect(mockModule.persistPublishedBundleArtifact).not.toHaveBeenCalled()
	expect(mockModule.buildKodyModuleBundle).not.toHaveBeenCalled()
})

test('ensureModuleArtifact stops serving a previous npm-backed bundle after the rebuild window', async () => {
	const fixture = createFixture({
		userId: ownerIdFromStored('user-npm-expired'),
		publishedCommit: 'commit-new',
		suffix: 'npm-expired',
	})
	fixture.source = {
		...fixture.source,
		updated_at: new Date().toISOString(),
	}
	const npmFiles = {
		'package.json': JSON.stringify({
			name: fixture.savedPackage.name,
			exports: {
				'./get-issue-state': './src/get-issue-state.ts',
			},
			dependencies: {
				react: '^19.0.0',
			},
			kody: {
				id: fixture.savedPackage.kodyId,
				description: 'Sentry triage helpers',
			},
		}),
		'src/get-issue-state.ts':
			'export default async function main() { return "new" }',
	}
	mockModule.persistPublishedBundleArtifact.mockClear()
	mockModule.buildKodyModuleBundle.mockClear()
	mockModuleArtifactRebuild(fixture, npmFiles, '2026-07-01T00:00:00.000Z')
	mockModule.loadPublishedEntityManifest.mockResolvedValue({
		source: fixture.source,
		content: npmFiles['package.json'],
	})
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue({
		row: { publishedCommit: 'commit-old' },
		artifact: {
			...fixture.artifact,
			publishedCommit: 'commit-old',
		},
	})

	await expect(
		ensureModuleArtifact({
			env: createEnv(),
			baseUrl: 'https://kody.dev',
			savedPackage: fixture.savedPackage,
			selector: { kind: 'export', exportName: 'get-issue-state' },
			userId: fixture.savedPackage.userId,
		}),
	).rejects.toThrow('no published runtime bundle artifact is available yet')
	expect(mockModule.persistPublishedBundleArtifact).not.toHaveBeenCalled()
	expect(mockModule.buildKodyModuleBundle).not.toHaveBeenCalled()
})

test('an artifact from a different commit is served but never retained', async () => {
	const load = vi.fn(async () => ({
		artifact: { publishedCommit: 'commit-old' } as never,
		source: { id: 'source-mismatch' } as never,
		entryPoint: 'src/index.ts',
	}))
	const loadOnce = () =>
		loadModuleArtifactWithCommitCache({
			userId: ownerIdFromStored('user-1'),
			sourceId: 'source-mismatch',
			publishedCommit: 'commit-new',
			artifactName: './index',
			entryPoint: 'src/index.ts',
			load,
		})

	for (let i = 0; i < 2; i++) {
		expect((await loadOnce()).artifact.publishedCommit).toBe('commit-old')
	}
	// A commit mismatch means the entry must not be cached under this key.
	expect(load).toHaveBeenCalledTimes(2)
})

test('package-app slug cache evicts by name leaf from kody:@ refs and packageAppSlugs', async () => {
	const userId = ownerIdFromStored('user-slug-evict')
	const savedPackage = {
		id: 'pkg-slug-evict',
		userId,
		name: '@kentcdodds/new-leaf',
		kodyId: 'legacy-kody-id',
	} as SavedPackageRecord
	const load = vi.fn(async () => ({
		savedPackage,
		retired: true,
	}))
	const loadOld = () =>
		resolvePackageAppSlugWithFreshnessCache({
			userId,
			slug: 'old-leaf',
			load,
		})
	const loadNew = () =>
		resolvePackageAppSlugWithFreshnessCache({
			userId,
			slug: 'new-leaf',
			load: async () => ({ savedPackage, retired: false }),
		})

	expect((await loadOld())?.retired).toBe(true)
	expect(load).toHaveBeenCalledTimes(1)
	expect((await loadOld())?.retired).toBe(true)
	expect(load).toHaveBeenCalledTimes(1)

	// kody:@ refs alone must clear the leaf-keyed package-app slug cache.
	invalidateInvokeContractFreshness({
		userId,
		packageIdOrKodyIds: [`kody:@kentcdodds/old-leaf`],
	})
	expect((await loadOld())?.retired).toBe(true)
	expect(load).toHaveBeenCalledTimes(2)

	await loadNew()
	invalidateInvokeContractFreshness({
		userId,
		packageIdOrKodyIds: [savedPackage.id, savedPackage.kodyId],
		packageAppSlugs: ['new-leaf', 'prior-redirect'],
	})
	const loadPrior = vi.fn(async () => null)
	await resolvePackageAppSlugWithFreshnessCache({
		userId,
		slug: 'prior-redirect',
		load: loadPrior,
	})
	expect(loadPrior).toHaveBeenCalledTimes(1)
	await resolvePackageAppSlugWithFreshnessCache({
		userId,
		slug: 'new-leaf',
		load: async () => ({ savedPackage, retired: false }),
	})
})

test('ensureModuleArtifact rebuilds a published export without typechecking it', async () => {
	// The reported shape: a required, narrowly typed params argument is not
	// assignable to `(params?: Record<string, unknown>) => unknown`, which
	// publish never checks for exports. Invocation must not reject it.
	const fixture = createFixture({
		userId: ownerIdFromStored('user-no-invoke-typecheck'),
		publishedCommit: 'commit-typed',
		suffix: 'no-invoke-typecheck',
	})
	const files = {
		'package.json': JSON.stringify({
			name: fixture.savedPackage.name,
			exports: { './get-issue-state': './src/get-issue-state.ts' },
			kody: {
				id: fixture.savedPackage.kodyId,
				description: 'Sentry triage helpers',
			},
		}),
		'src/get-issue-state.ts':
			'export default async function main(params: { issueId: string }) { return params.issueId }',
	}
	mockModule.persistPublishedBundleArtifact.mockClear()
	mockModule.buildKodyModuleBundle.mockClear()
	mockModuleArtifactRebuild(fixture, files)
	mockModule.loadPublishedEntityManifest.mockResolvedValue({
		source: fixture.source,
		content: files['package.json'],
	})
	mockModule.loadPublishedBundleArtifactByIdentity
		.mockResolvedValueOnce(null)
		.mockResolvedValueOnce({
			row: { kvKey: 'kv-key' },
			artifact: {
				publishedCommit: 'commit-typed',
				entryPoint: 'src/get-issue-state.ts',
			},
		})

	const rebuilt = await ensureModuleArtifact({
		env: createEnv(),
		baseUrl: 'https://kody.dev',
		savedPackage: fixture.savedPackage,
		selector: { kind: 'export', exportName: 'get-issue-state' },
		userId: fixture.savedPackage.userId,
	})

	expect(rebuilt.artifact.publishedCommit).toBe('commit-typed')
	expect(mockModule.buildKodyModuleBundle).toHaveBeenCalledWith(
		expect.objectContaining({ entryPoint: 'src/get-issue-state.ts' }),
	)
	expect(mockModule.persistPublishedBundleArtifact).toHaveBeenCalledTimes(1)
})

test('ensureModuleArtifact names a published export that has no default export', async () => {
	const fixture = createFixture({
		userId: ownerIdFromStored('user-no-default-export'),
		publishedCommit: 'commit-no-default',
		suffix: 'no-default-export',
	})
	const files = {
		'package.json': JSON.stringify({
			name: fixture.savedPackage.name,
			exports: { './get-issue-state': './src/get-issue-state.ts' },
			kody: {
				id: fixture.savedPackage.kodyId,
				description: 'Sentry triage helpers',
			},
		}),
		'src/get-issue-state.ts': 'export const issueState = "open"',
	}
	mockModule.persistPublishedBundleArtifact.mockClear()
	mockModule.buildKodyModuleBundle.mockClear()
	mockModuleArtifactRebuild(fixture, files)
	mockModule.loadPublishedEntityManifest.mockResolvedValue({
		source: fixture.source,
		content: files['package.json'],
	})
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValueOnce(null)

	await expect(
		ensureModuleArtifact({
			env: createEnv(),
			baseUrl: 'https://kody.dev',
			savedPackage: fixture.savedPackage,
			selector: { kind: 'export', exportName: 'get-issue-state' },
			userId: fixture.savedPackage.userId,
		}),
	).rejects.toThrow(
		'must default export a function so Kody can invoke them with execute semantics. Missing default export in: "src/get-issue-state.ts".',
	)
	expect(mockModule.buildKodyModuleBundle).not.toHaveBeenCalled()
	expect(mockModule.persistPublishedBundleArtifact).not.toHaveBeenCalled()
})
