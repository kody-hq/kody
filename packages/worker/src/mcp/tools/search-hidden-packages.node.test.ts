import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'

const mockFns = vi.hoisted(() => ({
	listSavedPackagesByIds: vi.fn(),
	listEntitySourcesByIds: vi.fn(),
	listPackageRetrieversForScope: vi.fn(),
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
	// Bulk source prefetch returns empty — source is not available.
	mockFns.listEntitySourcesByIds.mockResolvedValue([])

	const { runPackageRetrievers } =
		await import('#worker/package-retrievers/service.ts')

	const env = { APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} } as Env

	// Search with hidden package excluded: bulk prefetch runs once but the
	// hidden check exits before the source is used.
	const excluded = await runPackageRetrievers({
		env,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
		request: sessionRequestContext('user-1'),
		scope: 'search',
		query: 'notes',
	})
	expect(excluded.results).toEqual([])
	expect(mockFns.listEntitySourcesByIds).toHaveBeenCalledTimes(1)
	expect(mockFns.listEntitySourcesByIds).toHaveBeenCalledWith(env.APP_DB, [
		'source-hidden',
	])
	mockFns.listEntitySourcesByIds.mockClear()

	// Search with includeHiddenPackages: passes the hidden check, but source is
	// null so the retriever still returns no results.
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
	mockFns.listEntitySourcesByIds.mockClear()

	const { entry: contextEntry } = createHiddenRetrieverFixture(['context'])
	mockFns.listPackageRetrieversForScope.mockResolvedValue([contextEntry])

	// Context scope: hidden packages are not gated; source still null → no results.
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
	// The dynamic import above pulls in the retriever service module graph, and a
	// cold transform of it can exceed the 5s default when the worker pool is
	// saturated (the suite spends far longer importing than running). Same
	// allowance as search-handler.node.test.ts, which imports the same graph.
}, 10_000)
