import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'

const mockFns = vi.hoisted(() => ({
	listSavedPackagesByIds: vi.fn(),
	listEntitySourcesByIds: vi.fn(),
	listPackageRetrieversForScope: vi.fn(),
	loadPublishedBundleArtifactByIdentity: vi.fn(),
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
	loadPublishedBundleArtifactByIdentity:
		mockFns.loadPublishedBundleArtifactByIdentity,
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
	mockFns.listSavedPackagesByIds.mockImplementation(
		async (
			_db: unknown,
			input: { userId: string; packageIds: Array<string> },
		) =>
			input.packageIds.map((packageId) =>
				createSavedPackage({
					packageId,
					kodyId: packageId === 'pkg-healthy' ? 'healthy-pkg' : 'stalled-pkg',
				}),
			),
	)
	mockFns.listEntitySourcesByIds.mockImplementation(
		async (_db: unknown, sourceIds: Array<string>) =>
			sourceIds.map((sourceId) =>
				createEntitySource({ packageId: sourceId.replace(/^source-/, '') }),
			),
	)
	mockFns.loadPublishedBundleArtifactByIdentity.mockResolvedValue({
		artifact: {
			mainModule: 'main.js',
			modules: { 'main.js': 'export default async () => ({ results: [] })' },
			dependencies: [],
		},
	})
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
	// Bulk helpers must each be called exactly once (not once per retriever)
	// to prevent N+1 DB query regressions.
	expect(mockFns.listSavedPackagesByIds).toHaveBeenCalledTimes(1)
	expect(mockFns.listSavedPackagesByIds).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			packageIds: expect.arrayContaining(['pkg-healthy', 'pkg-stalled']),
		}),
	)
	expect(mockFns.listEntitySourcesByIds).toHaveBeenCalledTimes(1)
	expect(mockFns.listEntitySourcesByIds).toHaveBeenCalledWith(
		expect.anything(),
		expect.arrayContaining(['source-pkg-healthy', 'source-pkg-stalled']),
	)
	expect(mockFns.runBundledModuleWithRegistry).toHaveBeenCalledTimes(2)
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
