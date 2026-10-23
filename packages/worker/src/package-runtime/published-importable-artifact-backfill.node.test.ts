import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { runPublishedImportableArtifactBackfill } from './published-importable-artifact-backfill.ts'

const mocks = vi.hoisted(() => ({
	listSavedPackagesPage: vi.fn(),
	loadPackageSourceRowForUser: vi.fn(),
	loadPackageManifestForSource: vi.fn(),
	isPublishedPackageArtifactBuiltForCommit: vi.fn(),
	rebuildPublishedPackageArtifactsViaRepoSession: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesPage: (...args: Array<unknown>) =>
		mocks.listSavedPackagesPage(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceRowForUser: (...args: Array<unknown>) =>
		mocks.loadPackageSourceRowForUser(...args),
	loadPackageManifestForSource: (...args: Array<unknown>) =>
		mocks.loadPackageManifestForSource(...args),
}))

vi.mock('./published-bundle-artifacts.ts', () => ({
	isPublishedPackageArtifactBuiltForCommit: (...args: Array<unknown>) =>
		mocks.isPublishedPackageArtifactBuiltForCommit(...args),
}))

vi.mock('#mcp/capabilities/repo/package-artifact-rebuild.ts', () => ({
	rebuildPublishedPackageArtifactsViaRepoSession: (...args: Array<unknown>) =>
		mocks.rebuildPublishedPackageArtifactsViaRepoSession(...args),
}))

const owner = ownerIdFromStored('owner-1')
const env = { APP_DB: {} } as Env

function savedPackage(
	overrides: Partial<{
		id: string
		name: string
		sourceId: string
		kodyId: string
	}> = {},
) {
	return {
		id: overrides.id ?? 'pkg-1',
		userId: owner,
		name: overrides.name ?? '@kody/demo',
		kodyId: overrides.kodyId ?? 'demo',
		description: '',
		tags: [],
		searchText: null,
		sourceId: overrides.sourceId ?? 'source-1',
		hasApp: false,
		hasSkills: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		lockedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
}

function sourceRow(
	sourceId: string,
	publishedCommit: string | null,
): { id: string; published_commit: string | null } {
	return { id: sourceId, published_commit: publishedCommit }
}

test('dry-run reports missing importable-module artifacts without rebuilding', async () => {
	mocks.listSavedPackagesPage.mockResolvedValueOnce([
		savedPackage(),
		savedPackage({ id: 'pkg-2', name: '@kody/clean', sourceId: 'source-2' }),
		savedPackage({
			id: 'pkg-3',
			name: '@kody/draft',
			sourceId: 'source-3',
		}),
	])
	mocks.loadPackageSourceRowForUser.mockImplementation(
		async (input: { sourceId: string }) => {
			if (input.sourceId === 'source-3') {
				return sourceRow('source-3', null)
			}
			return sourceRow(input.sourceId, 'commit-1')
		},
	)
	mocks.loadPackageManifestForSource.mockImplementation(
		async (input: {
			source: { id: string; published_commit: string | null }
		}) => ({
			source: input.source,
			manifest: {
				exports: {
					'.': './src/index.ts',
					'./util': './src/util.ts',
				},
				kody: {},
			},
		}),
	)
	mocks.isPublishedPackageArtifactBuiltForCommit.mockImplementation(
		async (input: {
			sourceId: string
			target: { artifactName?: string | null }
		}) => {
			if (input.sourceId === 'source-2') return true
			return input.target.artifactName === '.'
		},
	)

	const result = await runPublishedImportableArtifactBackfill({
		env,
		baseUrl: 'https://heykody.dev',
		dryRun: true,
		limit: 10,
	})

	expect(result).toMatchObject({
		dryRun: true,
		scannedPackages: 3,
		publishedPackages: 2,
		packagesNeedingRebuild: 1,
		missingImportableArtifacts: 1,
		packagesMissingSubpathImportable: 1,
		rebuiltPackages: 0,
		failedPackages: 0,
		alreadyBuiltPackages: 1,
		skippedUnpublished: 1,
		nextCursor: null,
	})
	expect(result.outcomes).toEqual([
		expect.objectContaining({
			packageId: 'pkg-1',
			outcome: 'would_rebuild',
			missingImportableCount: 1,
		}),
		expect.objectContaining({
			packageId: 'pkg-2',
			outcome: 'already_built',
		}),
		expect.objectContaining({
			packageId: 'pkg-3',
			outcome: 'skipped_unpublished',
		}),
	])
	expect(mocks.loadPackageManifestForSource).not.toHaveBeenCalledWith(
		expect.objectContaining({
			source: expect.objectContaining({ id: 'source-3' }),
		}),
	)
	expect(
		mocks.rebuildPublishedPackageArtifactsViaRepoSession,
	).not.toHaveBeenCalled()
})

test('unpublished drafts are skipped even when the published manifest loader would throw', async () => {
	mocks.listSavedPackagesPage.mockResolvedValueOnce([savedPackage()])
	mocks.loadPackageSourceRowForUser.mockResolvedValue(
		sourceRow('source-1', null),
	)
	mocks.loadPackageManifestForSource.mockRejectedValue(
		new Error('Source "source-1" has no published commit.'),
	)

	const result = await runPublishedImportableArtifactBackfill({
		env,
		baseUrl: 'https://heykody.dev',
		dryRun: true,
	})

	expect(result).toMatchObject({
		failedPackages: 0,
		skippedUnpublished: 1,
	})
	expect(result.outcomes).toEqual([
		expect.objectContaining({
			outcome: 'skipped_unpublished',
			publishedCommit: null,
		}),
	])
	expect(mocks.loadPackageManifestForSource).not.toHaveBeenCalled()
})

test('apply rebuilds only missing importable targets and keeps gap details on failure', async () => {
	mocks.listSavedPackagesPage.mockResolvedValueOnce([savedPackage()])
	mocks.loadPackageSourceRowForUser.mockResolvedValue(
		sourceRow('source-1', 'commit-abc'),
	)
	mocks.loadPackageManifestForSource.mockResolvedValue({
		source: sourceRow('source-1', 'commit-abc'),
		manifest: {
			exports: { '.': './src/index.ts' },
			kody: {},
		},
	})
	mocks.isPublishedPackageArtifactBuiltForCommit.mockResolvedValue(false)
	mocks.rebuildPublishedPackageArtifactsViaRepoSession.mockRejectedValue(
		new Error('esbuild failed'),
	)

	const failed = await runPublishedImportableArtifactBackfill({
		env,
		baseUrl: 'https://heykody.dev',
		dryRun: false,
		limit: 5,
	})

	expect(failed).toMatchObject({
		dryRun: false,
		packagesNeedingRebuild: 1,
		missingImportableArtifacts: 1,
		packagesMissingSubpathImportable: 0,
		rebuiltPackages: 0,
		failedPackages: 1,
	})
	expect(failed.outcomes).toEqual([
		expect.objectContaining({
			packageId: 'pkg-1',
			outcome: 'failed',
			publishedCommit: 'commit-abc',
			missingImportableCount: 1,
			error: 'esbuild failed',
		}),
	])
	expect(
		mocks.rebuildPublishedPackageArtifactsViaRepoSession,
	).toHaveBeenCalledWith(
		expect.objectContaining({
			rpcSessionId: 'artifact-backfill-source-1',
			sourceId: 'source-1',
			userId: owner,
			publishedCommit: 'commit-abc',
			baseUrl: 'https://heykody.dev',
			targets: [
				expect.objectContaining({
					kind: 'importable-module',
					artifactName: '.',
				}),
			],
		}),
	)

	mocks.listSavedPackagesPage.mockResolvedValueOnce([savedPackage()])
	mocks.loadPackageSourceRowForUser.mockResolvedValue(
		sourceRow('source-1', 'commit-abc'),
	)
	mocks.rebuildPublishedPackageArtifactsViaRepoSession.mockResolvedValue(
		undefined,
	)

	const rebuilt = await runPublishedImportableArtifactBackfill({
		env,
		baseUrl: 'https://heykody.dev',
		dryRun: false,
		limit: 5,
	})
	expect(rebuilt).toMatchObject({ rebuiltPackages: 1, failedPackages: 0 })
})

test('apply fails instead of rebuilding when the published commit changes mid-flight', async () => {
	mocks.listSavedPackagesPage.mockResolvedValueOnce([savedPackage()])
	mocks.loadPackageSourceRowForUser
		.mockResolvedValueOnce(sourceRow('source-1', 'commit-a'))
		.mockResolvedValueOnce(sourceRow('source-1', 'commit-b'))
	mocks.loadPackageManifestForSource.mockResolvedValue({
		source: sourceRow('source-1', 'commit-a'),
		manifest: {
			exports: { '.': './src/index.ts' },
			kody: {},
		},
	})
	mocks.isPublishedPackageArtifactBuiltForCommit.mockResolvedValue(false)

	const result = await runPublishedImportableArtifactBackfill({
		env,
		baseUrl: 'https://heykody.dev',
		dryRun: false,
	})

	expect(result.outcomes).toEqual([
		expect.objectContaining({
			outcome: 'failed',
			publishedCommit: 'commit-a',
			missingImportableCount: 1,
			error: expect.stringContaining('Published commit changed'),
		}),
	])
	expect(
		mocks.rebuildPublishedPackageArtifactsViaRepoSession,
	).not.toHaveBeenCalled()
})
