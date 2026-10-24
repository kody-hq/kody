import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import type * as PublishedBundleArtifactRepo from '#worker/repo/published-bundle-artifacts-repo.ts'
import type * as PublishedRuntimeArtifacts from '#worker/package-runtime/published-runtime-artifacts.ts'

const mockModule = vi.hoisted(() => ({
	listPublishedPackageArtifactTargets: vi.fn(),
	rebuildPublishedPackageArtifact: vi.fn(),
	getPublishedBundleArtifactByIdentity: vi.fn(),
	listPublishedBundleArtifactsByIdentities: vi.fn(),
	identityKey: (identity: {
		sourceId: string
		artifactKind: string
		artifactName: string | null
		entryPoint: string
	}) =>
		[
			identity.sourceId,
			identity.artifactKind,
			identity.artifactName ?? '',
			identity.entryPoint,
		].join('\0'),
	fanOutListPublishedBundleArtifactsByIdentities: async (
		db: unknown,
		input: {
			userId: string
			identities: ReadonlyArray<{
				sourceId: string
				artifactKind: string
				artifactName: string | null
				entryPoint: string
			}>
		},
	) => {
		const found = new Map<string, unknown>()
		for (const identity of input.identities) {
			const row = await mockModule.getPublishedBundleArtifactByIdentity(db, {
				userId: input.userId,
				...identity,
			})
			if (row) {
				found.set(mockModule.identityKey(identity), row)
			}
		}
		return found
	},
	readPublishedBundleArtifact: vi.fn(),
	readPublishedSourceSnapshot: vi.fn(),
}))

vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: () => ({
		listPublishedPackageArtifactTargets: (...args: Array<unknown>) =>
			mockModule.listPublishedPackageArtifactTargets(...args),
		rebuildPublishedPackageArtifact: (...args: Array<unknown>) =>
			mockModule.rebuildPublishedPackageArtifact(...args),
	}),
}))

vi.mock('#worker/repo/published-bundle-artifacts-repo.ts', async () => {
	const actual = await vi.importActual<typeof PublishedBundleArtifactRepo>(
		'#worker/repo/published-bundle-artifacts-repo.ts',
	)
	mockModule.identityKey = actual.publishedBundleArtifactIdentityKey
	return {
		...actual,
		getPublishedBundleArtifactByIdentity: (...args: Array<unknown>) =>
			mockModule.getPublishedBundleArtifactByIdentity(...args),
		listPublishedBundleArtifactsByIdentities: (...args: Array<unknown>) =>
			mockModule.listPublishedBundleArtifactsByIdentities(...args),
	}
})

beforeEach(() => {
	mockModule.listPublishedBundleArtifactsByIdentities.mockImplementation(
		mockModule.fanOutListPublishedBundleArtifactsByIdentities,
	)
})

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', async () => {
	const actual = await vi.importActual<typeof PublishedRuntimeArtifacts>(
		'#worker/package-runtime/published-runtime-artifacts.ts',
	)
	return {
		...actual,
		readPublishedBundleArtifact: (...args: Array<unknown>) =>
			mockModule.readPublishedBundleArtifact(...args),
		readPublishedSourceSnapshot: (...args: Array<unknown>) =>
			mockModule.readPublishedSourceSnapshot(...args),
	}
})

const { rebuildPublishedPackageArtifactsViaRepoSession } =
	await import('./package-artifact-rebuild.ts')

const sourceId = 'source-1'
const publishedCommit = 'commit-1'
const targets = ['a', 'b', 'c'].map((letter, index) => ({
	kind: 'module' as const,
	artifactName: index === 0 ? '.' : `./${letter}`,
	entryPoint: `src/${letter}.ts`,
	bundleKind: 'module' as const,
}))
const createdAt = '2026-09-05T16:00:01.000Z'
const env = {
	APP_DB: {},
	BUNDLE_ARTIFACTS_KV: {},
} as unknown as Env

test('external artifact rebuild reads the published snapshot once per rebuild and shares it across targets', async () => {
	const cutoffs = ['2026-09-05T16:00:00.000Z', '2026-09-05T17:00:00.000Z']
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue(targets)
	mockModule.rebuildPublishedPackageArtifact.mockResolvedValue({ ok: true })
	mockModule.getPublishedBundleArtifactByIdentity.mockImplementation(
		async (
			_db: unknown,
			query: { entryPoint: string; artifactName: string | null },
		) => ({
			id: `row-${query.entryPoint}`,
			userId: ownerIdFromStored('user-1'),
			sourceId,
			publishedCommit,
			artifactKind: 'module',
			artifactName: query.artifactName,
			entryPoint: query.entryPoint,
			kvKey: `kv:${query.entryPoint}`,
			dependenciesJson: '[]',
			createdAt,
			updatedAt: createdAt,
		}),
	)
	mockModule.readPublishedBundleArtifact.mockImplementation(
		async (input: { kvKey: string }) => {
			const entryPoint = input.kvKey.slice('kv:'.length)
			const target = targets.find((item) => item.entryPoint === entryPoint)
			return {
				version: 1,
				kind: 'module',
				artifactName: target?.artifactName ?? '.',
				sourceId,
				publishedCommit,
				entryPoint,
				mainModule: 'dist/mod.js',
				modules: { 'dist/mod.js': 'export default {}' },
				dependencies: [],
				createdAt,
			}
		},
	)
	let reads = 0
	mockModule.readPublishedSourceSnapshot.mockImplementation(async () => {
		const cutoff = cutoffs[reads] ?? cutoffs[0]
		reads += 1
		return {
			sourceId,
			publishedCommit,
			files: {},
			invalidateArtifactsBefore: cutoff,
		}
	})

	const rebuild = () =>
		rebuildPublishedPackageArtifactsViaRepoSession({
			env,
			rpcSessionId: 'session-1',
			sourceId,
			userId: ownerIdFromStored('user-1'),
			publishedCommit,
			baseUrl: 'https://kody.test',
		})

	await rebuild()

	expect(mockModule.readPublishedSourceSnapshot).toHaveBeenCalledTimes(1)
	expect(mockModule.readPublishedSourceSnapshot).toHaveBeenCalledWith({
		env,
		sourceId,
		publishedCommit,
	})
	expect(mockModule.rebuildPublishedPackageArtifact).not.toHaveBeenCalled()

	await rebuild()

	expect(mockModule.readPublishedSourceSnapshot).toHaveBeenCalledTimes(2)
	expect(mockModule.rebuildPublishedPackageArtifact).toHaveBeenCalledTimes(
		targets.length,
	)
})

test('empty artifact target list skips the published snapshot read', async () => {
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue([])
	mockModule.readPublishedSourceSnapshot.mockRejectedValue(
		new Error('transient kv get failed'),
	)

	await rebuildPublishedPackageArtifactsViaRepoSession({
		env,
		rpcSessionId: 'session-1',
		sourceId,
		userId: ownerIdFromStored('user-1'),
		publishedCommit,
		baseUrl: 'https://kody.test',
	})

	expect(mockModule.readPublishedSourceSnapshot).not.toHaveBeenCalled()
	expect(mockModule.rebuildPublishedPackageArtifact).not.toHaveBeenCalled()
})
