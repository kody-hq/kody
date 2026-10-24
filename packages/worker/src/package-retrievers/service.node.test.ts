import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'

const mockFns = vi.hoisted(() => ({
	listSavedPackagesByIds: vi.fn(),
	listEntitySourcesByIds: vi.fn(),
	listPackageRetrieversForScope: vi.fn(),
	loadPublishedBundleArtifactsByIdentities: vi.fn(),
	publishedBundleLoadIdentityKey: vi.fn(
		(input: {
			sourceId: string
			kind: string
			artifactName?: string | null
			entryPoint: string
		}) =>
			[
				input.sourceId,
				input.kind,
				input.artifactName ?? '',
				input.entryPoint,
			].join('\0'),
	),
	runBundledModuleWithRegistry: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByIds: mockFns.listSavedPackagesByIds,
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	listEntitySourcesByIds: mockFns.listEntitySourcesByIds,
}))

vi.mock('#worker/package-retrievers/manifest-cache.ts', () => ({
	listPackageRetrieversForScope: mockFns.listPackageRetrieversForScope,
}))

vi.mock('#worker/package-runtime/published-bundle-artifacts.ts', () => ({
	loadPublishedBundleArtifactsByIdentities:
		mockFns.loadPublishedBundleArtifactsByIdentities,
	publishedBundleLoadIdentityKey: mockFns.publishedBundleLoadIdentityKey,
}))

vi.mock('#mcp/run-kody-registry.ts', () => ({
	runBundledModuleWithRegistry: mockFns.runBundledModuleWithRegistry,
}))

vi.mock('#worker/identity/background-mcp-user.ts', () => ({
	resolveBackgroundMcpUser: async (_db: D1Database, userId: string) => ({
		userId,
		email: `${userId}@example.com`,
		username: userId,
		displayName: userId,
	}),
}))

function createRetrieverEntry(input: {
	packageId: string
	kodyId: string
	retrieverKey: string
	scopes?: Array<'search' | 'context'>
}) {
	return {
		userId: ownerIdFromStored('user-1'),
		packageId: input.packageId,
		kodyId: input.kodyId,
		sourceId: `source-${input.packageId}`,
		revision: 'commit-1',
		retrieverKey: input.retrieverKey,
		exportName: `./${input.retrieverKey}`,
		entryPoint: `./${input.retrieverKey}.ts`,
		name: input.retrieverKey,
		description: `${input.retrieverKey} retriever`,
		scopes: input.scopes ?? (['search'] as Array<'search' | 'context'>),
		timeoutMs: null,
		maxResults: null,
	}
}

function createSavedPackage(input: { packageId: string; kodyId: string }) {
	return {
		id: input.packageId,
		userId: ownerIdFromStored('user-1'),
		name: input.kodyId,
		kodyId: input.kodyId,
		description: input.kodyId,
		tags: [],
		searchText: input.kodyId,
		sourceId: `source-${input.packageId}`,
		hasApp: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
}

function createEntitySource(input: { packageId: string }) {
	return {
		id: `source-${input.packageId}`,
		user_id: ownerIdFromStored('user-1'),
		repo_id: `repo-${input.packageId}`,
		entity_kind: 'package',
		entity_id: input.packageId,
		manifest_path: 'package.json',
		source_root: '.',
		published_commit: 'commit-1',
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
	}
}

test('runPackageRetrievers soft-fails a timed-out retriever and keeps healthy results', async () => {
	const healthy = createRetrieverEntry({
		packageId: 'pkg-healthy',
		kodyId: 'healthy-pkg',
		retrieverKey: 'notes',
		scopes: ['context'],
	})
	const stalled = createRetrieverEntry({
		packageId: 'pkg-stalled',
		kodyId: 'stalled-pkg',
		retrieverKey: 'inbox',
		scopes: ['context'],
	})
	mockFns.listPackageRetrieversForScope.mockResolvedValue([healthy, stalled])
	mockFns.listSavedPackagesByIds.mockResolvedValue([
		createSavedPackage({
			packageId: 'pkg-healthy',
			kodyId: 'healthy-pkg',
		}),
		createSavedPackage({
			packageId: 'pkg-stalled',
			kodyId: 'stalled-pkg',
		}),
	])
	mockFns.listEntitySourcesByIds.mockResolvedValue([
		createEntitySource({ packageId: 'pkg-healthy' }),
		createEntitySource({ packageId: 'pkg-stalled' }),
	])
	const artifactPayload = {
		row: { publishedCommit: 'commit-1' },
		artifact: {
			mainModule: 'main.js',
			modules: { 'main.js': 'export default async () => ({ results: [] })' },
			dependencies: [],
		},
	}
	mockFns.loadPublishedBundleArtifactsByIdentities.mockResolvedValue(
		new Map([
			[
				mockFns.publishedBundleLoadIdentityKey({
					sourceId: healthy.sourceId,
					kind: 'module',
					artifactName: healthy.exportName,
					entryPoint: healthy.entryPoint,
				}),
				artifactPayload,
			],
			[
				mockFns.publishedBundleLoadIdentityKey({
					sourceId: stalled.sourceId,
					kind: 'module',
					artifactName: stalled.exportName,
					entryPoint: stalled.entryPoint,
				}),
				artifactPayload,
			],
		]),
	)
	mockFns.runBundledModuleWithRegistry.mockImplementation(
		async (
			_env: unknown,
			_caller: unknown,
			_bundle: unknown,
			_params: unknown,
			options: { runRecord?: { name?: string } },
		) => {
			if (options.runRecord?.name === 'inbox') {
				return { result: undefined, error: 'Execution timed out' }
			}
			return {
				result: {
					results: [
						{
							id: 'note-1',
							title: 'Healthy note',
							summary: 'from healthy retriever',
							score: 0.9,
						},
					],
				},
			}
		},
	)

	consoleError.mockImplementation(() => {})

	const { runPackageRetrievers } =
		await import('#worker/package-retrievers/service.ts')
	const run = await runPackageRetrievers({
		env: { APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} } as Env,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
		request: sessionRequestContext('user-1'),
		scope: 'context',
		query: 'notes',
	})

	expect(run.results).toEqual([
		expect.objectContaining({
			id: 'note-1',
			packageId: 'pkg-healthy',
			kodyId: 'healthy-pkg',
			retrieverKey: 'notes',
		}),
	])
	expect(run.warnings).toHaveLength(1)
	expect(run.warnings[0]).toMatch(/stalled-pkg\/inbox/)
	expect(run.warnings[0]).toMatch(/timed out/i)
	expect(consoleError).toHaveBeenCalledTimes(1)
	expect(mockFns.runBundledModuleWithRegistry).toHaveBeenCalledTimes(2)
	expect(mockFns.listSavedPackagesByIds).toHaveBeenCalledTimes(1)
	expect(mockFns.listEntitySourcesByIds).toHaveBeenCalledTimes(1)
	expect(
		mockFns.loadPublishedBundleArtifactsByIdentities,
	).toHaveBeenCalledTimes(1)
	expect(mockFns.loadPublishedBundleArtifactsByIdentities).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			identities: expect.arrayContaining([
				expect.objectContaining({
					sourceId: healthy.sourceId,
					kind: 'module',
					artifactName: healthy.exportName,
					entryPoint: healthy.entryPoint,
				}),
				expect.objectContaining({
					sourceId: stalled.sourceId,
					kind: 'module',
					artifactName: stalled.exportName,
					entryPoint: stalled.entryPoint,
				}),
			]),
		}),
	)
	for (const call of mockFns.runBundledModuleWithRegistry.mock.calls) {
		expect(call[4]).toEqual(
			expect.objectContaining({
				executorTimeoutMs: 2_500,
				closedWorldRetrieverRuntime: true,
			}),
		)
		expect(call[4]).not.toHaveProperty('packageInvokeTools')
		expect(call[4]).not.toHaveProperty('packageEventTools')
	}
})

test('runPackageRetrievers prefetches packages, sources, and artifacts once for many retrievers', async () => {
	const entries = [
		createRetrieverEntry({
			packageId: 'pkg-a',
			kodyId: 'pkg-a',
			retrieverKey: 'one',
		}),
		createRetrieverEntry({
			packageId: 'pkg-b',
			kodyId: 'pkg-b',
			retrieverKey: 'two',
		}),
		createRetrieverEntry({
			packageId: 'pkg-c',
			kodyId: 'pkg-c',
			retrieverKey: 'three',
		}),
	]
	mockFns.listPackageRetrieversForScope.mockResolvedValue(entries)
	mockFns.listSavedPackagesByIds.mockResolvedValue(
		entries.map((entry) =>
			createSavedPackage({
				packageId: entry.packageId,
				kodyId: entry.kodyId,
			}),
		),
	)
	mockFns.listEntitySourcesByIds.mockResolvedValue(
		entries.map((entry) => createEntitySource({ packageId: entry.packageId })),
	)
	const artifactPayload = {
		row: { publishedCommit: 'commit-1' },
		artifact: {
			mainModule: 'main.js',
			modules: { 'main.js': 'export default async () => ({ results: [] })' },
			dependencies: [],
		},
	}
	mockFns.loadPublishedBundleArtifactsByIdentities.mockResolvedValue(
		new Map(
			entries.map((entry) => [
				mockFns.publishedBundleLoadIdentityKey({
					sourceId: entry.sourceId,
					kind: 'module',
					artifactName: entry.exportName,
					entryPoint: entry.entryPoint,
				}),
				artifactPayload,
			]),
		),
	)
	mockFns.runBundledModuleWithRegistry.mockResolvedValue({
		result: { results: [] },
	})

	const { runPackageRetrievers } =
		await import('#worker/package-retrievers/service.ts')
	await runPackageRetrievers({
		env: { APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} } as Env,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
		request: sessionRequestContext('user-1'),
		scope: 'search',
		query: 'notes',
	})

	expect(mockFns.listSavedPackagesByIds).toHaveBeenCalledTimes(1)
	expect(mockFns.listEntitySourcesByIds).toHaveBeenCalledTimes(1)
	expect(
		mockFns.loadPublishedBundleArtifactsByIdentities,
	).toHaveBeenCalledTimes(1)
	expect(mockFns.listSavedPackagesByIds).toHaveBeenCalledWith(
		expect.anything(),
		{
			userId: ownerIdFromStored('user-1'),
			packageIds: ['pkg-a', 'pkg-b', 'pkg-c'],
		},
	)
	expect(mockFns.listEntitySourcesByIds).toHaveBeenCalledWith(
		expect.anything(),
		['source-pkg-a', 'source-pkg-b', 'source-pkg-c'],
	)
	expect(mockFns.runBundledModuleWithRegistry).toHaveBeenCalledTimes(3)
})
