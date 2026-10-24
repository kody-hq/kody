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

function createHiddenRetrieverFixture(scopes: Array<'search' | 'context'>) {
	return {
		entry: {
			userId: ownerIdFromStored('user-1'),
			packageId: 'pkg-hidden',
			kodyId: 'hidden-pkg',
			sourceId: 'source-hidden',
			revision: 'commit-1',
			retrieverKey: 'notes',
			exportName: './notes',
			entryPoint: './notes.ts',
			name: 'Notes',
			description: 'Notes retriever',
			scopes,
			timeoutMs: null,
			maxResults: null,
		},
		hiddenPackage: {
			id: 'pkg-hidden',
			userId: ownerIdFromStored('user-1'),
			name: 'hidden-pkg',
			kodyId: 'hidden-pkg',
			description: 'hidden package',
			tags: [],
			searchText: 'hidden',
			sourceId: 'source-hidden',
			hasApp: false,
			hidden: true,
			isPrivate: false,
			isInternetVisible: false,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
	}
}

test('hidden package retrievers skip search by default, honor includeHiddenPackages, and still run for context', async () => {
	const { entry, hiddenPackage } = createHiddenRetrieverFixture(['search'])
	mockFns.listPackageRetrieversForScope.mockResolvedValue([entry])
	mockFns.listSavedPackagesByIds.mockResolvedValue([hiddenPackage])
	mockFns.listEntitySourcesByIds.mockResolvedValue([])
	mockFns.loadPublishedBundleArtifactsByIdentities.mockResolvedValue(new Map())

	const { runPackageRetrievers } =
		await import('#worker/package-retrievers/service.ts')

	const env = { APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} } as Env

	const excluded = await runPackageRetrievers({
		env,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
		request: sessionRequestContext('user-1'),
		scope: 'search',
		query: 'notes',
	})
	expect(excluded.results).toEqual([])
	expect(mockFns.listEntitySourcesByIds).toHaveBeenCalledWith(env.APP_DB, [])
	expect(mockFns.loadPublishedBundleArtifactsByIdentities).toHaveBeenCalledWith(
		expect.objectContaining({
			identities: [],
		}),
	)

	mockFns.listEntitySourcesByIds.mockClear()
	mockFns.loadPublishedBundleArtifactsByIdentities.mockClear()
	const included = await runPackageRetrievers({
		env,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
		request: sessionRequestContext('user-1'),
		scope: 'search',
		query: 'notes',
		includeHiddenPackages: true,
	})
	expect(included.results).toEqual([])
	expect(mockFns.listEntitySourcesByIds).toHaveBeenCalledWith(env.APP_DB, [
		'source-hidden',
	])
	expect(mockFns.loadPublishedBundleArtifactsByIdentities).toHaveBeenCalledWith(
		expect.objectContaining({
			identities: [
				expect.objectContaining({
					sourceId: 'source-hidden',
					kind: 'module',
					artifactName: './notes',
					entryPoint: './notes.ts',
				}),
			],
		}),
	)

	const { entry: contextEntry } = createHiddenRetrieverFixture(['context'])
	mockFns.listPackageRetrieversForScope.mockResolvedValue([contextEntry])
	mockFns.listEntitySourcesByIds.mockClear()
	mockFns.loadPublishedBundleArtifactsByIdentities.mockClear()

	const contextRun = await runPackageRetrievers({
		env,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
		request: sessionRequestContext('user-1'),
		scope: 'context',
		query: 'notes',
	})
	expect(contextRun.results).toEqual([])
	expect(mockFns.listEntitySourcesByIds).toHaveBeenCalledWith(env.APP_DB, [
		'source-hidden',
	])
	expect(mockFns.loadPublishedBundleArtifactsByIdentities).toHaveBeenCalledWith(
		expect.objectContaining({
			identities: [
				expect.objectContaining({
					sourceId: 'source-hidden',
				}),
			],
		}),
	)
	// The dynamic import above pulls in the retriever service module graph, and a
	// cold transform of it can exceed the 5s default when the worker pool is
	// saturated (the suite spends far longer importing than running). Same
	// allowance as search-handler.node.test.ts, which imports the same graph.
}, 10_000)
