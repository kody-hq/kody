import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'

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
	ensureModuleArtifact: vi.fn(),
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

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	ensureModuleArtifact: mockFns.ensureModuleArtifact,
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

const packageId = 'pkg-retriever'
const sourceId = `source-${packageId}`

function seedRetriever() {
	const entry = {
		userId: ownerIdFromStored('user-1'),
		packageId,
		kodyId: 'retriever-pkg',
		sourceId,
		revision: 'commit-1',
		retrieverKey: 'notes',
		exportName: './notes',
		entryPoint: 'src/notes.ts',
		name: 'notes',
		description: 'notes retriever',
		scopes: ['context'] as Array<'search' | 'context'>,
		timeoutMs: null,
		maxResults: null,
	}
	mockFns.listPackageRetrieversForScope.mockResolvedValue([entry])
	mockFns.listSavedPackagesByIds.mockResolvedValue([
		{
			id: packageId,
			userId: ownerIdFromStored('user-1'),
			name: '@kody/retriever-pkg',
			kodyId: 'retriever-pkg',
			description: 'retriever-pkg',
			tags: [],
			searchText: 'retriever-pkg',
			sourceId,
			hasApp: false,
			hidden: false,
			isPrivate: false,
			isInternetVisible: false,
			createdAt: '2026-10-20T00:00:00.000Z',
			updatedAt: '2026-10-20T00:00:00.000Z',
		},
	])
	mockFns.listEntitySourcesByIds.mockResolvedValue([
		{
			id: sourceId,
			user_id: ownerIdFromStored('user-1'),
			repo_id: `repo-${packageId}`,
			entity_kind: 'package',
			entity_id: packageId,
			manifest_path: 'package.json',
			source_root: '.',
			published_commit: 'commit-1',
			created_at: '2026-10-20T00:00:00.000Z',
			updated_at: '2026-10-20T00:00:00.000Z',
		},
	])
	mockFns.runBundledModuleWithRegistry.mockResolvedValue({
		result: { results: [] },
	})
	return entry
}

function artifact(input: {
	mainModule: string
	source: string
	dependencies: Array<{ packageId: string }>
}) {
	return {
		kind: 'module',
		sourceId,
		publishedCommit: 'commit-1',
		entryPoint: 'src/notes.ts',
		mainModule: input.mainModule,
		modules: { [input.mainModule]: input.source },
		dependencies: input.dependencies.map((dependency) => ({
			sourceId: `source-${dependency.packageId}`,
			publishedCommit: 'dependency-commit',
			kodyId: dependency.packageId,
			packageId: dependency.packageId,
		})),
		packageContext: { packageId, kodyId: 'retriever-pkg', sourceId },
	}
}

async function runContextRetrievers() {
	const { runPackageRetrievers } =
		await import('#worker/package-retrievers/service.ts')
	return await runPackageRetrievers({
		env: { APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} } as Env,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
		request: sessionRequestContext('user-1'),
		scope: 'context',
		query: 'notes',
	})
}

test('a pre-binding retriever bundle that inlines another package goes through the module-artifact rebuild before it runs', async () => {
	const entry = seedRetriever()
	mockFns.loadPublishedBundleArtifactsByIdentities.mockResolvedValue(
		new Map([
			[
				mockFns.publishedBundleLoadIdentityKey({
					sourceId: entry.sourceId,
					kind: 'module',
					artifactName: entry.exportName,
					entryPoint: entry.entryPoint,
				}),
				{
					row: { publishedCommit: 'commit-1' },
					artifact: artifact({
						mainModule: 'pre-binding.js',
						source:
							'export default async () => { await fetch("https://example.com/"); return { results: [] } }',
						dependencies: [{ packageId: 'pkg-dependency' }],
					}),
				},
			],
		]),
	)
	mockFns.ensureModuleArtifact.mockResolvedValue({
		artifact: artifact({
			mainModule: 'rebuilt.js',
			source:
				'var __kodyBoundFetch = __kodyCreatePackageBoundFetch("pkg-retriever");\nexport default async () => ({ results: [] })',
			dependencies: [{ packageId: 'pkg-dependency' }],
		}),
	})

	await runContextRetrievers()

	expect(mockFns.ensureModuleArtifact).toHaveBeenCalledWith(
		expect.objectContaining({
			selector: { kind: 'export', exportName: './notes' },
			savedPackage: expect.objectContaining({ id: packageId }),
		}),
	)
	expect(mockFns.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
	expect(mockFns.runBundledModuleWithRegistry.mock.calls[0]?.[2]).toEqual(
		expect.objectContaining({ mainModule: 'rebuilt.js' }),
	)
})

test('a current retriever bundle runs as stored without a rebuild', async () => {
	mockFns.ensureModuleArtifact.mockClear()
	mockFns.runBundledModuleWithRegistry.mockClear()
	const entry = seedRetriever()
	mockFns.loadPublishedBundleArtifactsByIdentities.mockResolvedValue(
		new Map([
			[
				mockFns.publishedBundleLoadIdentityKey({
					sourceId: entry.sourceId,
					kind: 'module',
					artifactName: entry.exportName,
					entryPoint: entry.entryPoint,
				}),
				{
					row: { publishedCommit: 'commit-1' },
					artifact: artifact({
						mainModule: 'current.js',
						source:
							'var __kodyBoundFetch = __kodyCreatePackageBoundFetch("pkg-retriever");\nexport default async () => ({ results: [] })',
						dependencies: [{ packageId: 'pkg-dependency' }],
					}),
				},
			],
		]),
	)

	await runContextRetrievers()

	expect(mockFns.ensureModuleArtifact).not.toHaveBeenCalled()
	expect(mockFns.runBundledModuleWithRegistry.mock.calls[0]?.[2]).toEqual(
		expect.objectContaining({ mainModule: 'current.js' }),
	)
})
