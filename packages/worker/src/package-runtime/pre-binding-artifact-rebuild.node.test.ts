import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	listCandidatePackages: vi.fn(),
	loadPackageSourceRowForUser: vi.fn(),
	loadPackageManifestForSource: vi.fn(),
	loadPublishedBundleArtifactsForPackageTargets: vi.fn(),
	rebuild: vi.fn(),
}))

vi.mock('./published-importable-artifact-backfill.ts', () => ({
	listCandidatePackages: (...args: Array<unknown>) =>
		mocks.listCandidatePackages(...args),
}))
vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceRowForUser: (...args: Array<unknown>) =>
		mocks.loadPackageSourceRowForUser(...args),
	loadPackageManifestForSource: (...args: Array<unknown>) =>
		mocks.loadPackageManifestForSource(...args),
}))
vi.mock('./published-bundle-artifacts.ts', () => ({
	loadPublishedBundleArtifactsForPackageTargets: (...args: Array<unknown>) =>
		mocks.loadPublishedBundleArtifactsForPackageTargets(...args),
	publishedBundleArtifactForPackageTarget: ({
		target,
		loadedByIdentity,
	}: {
		target: { kind: string }
		loadedByIdentity: Map<string, unknown>
	}) => loadedByIdentity.get(target.kind) ?? null,
}))
vi.mock('./published-runtime-artifacts.ts', () => ({
	hasPublishedRuntimeArtifacts: () => true,
}))
vi.mock('#mcp/capabilities/repo/package-artifact-rebuild.ts', () => ({
	rebuildPublishedPackageArtifactsViaRepoSession: (...args: Array<unknown>) =>
		mocks.rebuild(...args),
}))

const { runPreBindingArtifactRebuild } =
	await import('./pre-binding-artifact-rebuild.ts')

const owner = ownerIdFromStored('owner-1')
const env = { APP_DB: {} } as Env

function artifact(input: {
	kind: string
	code: string
	dependencies?: Array<{ packageId?: string }>
	packageBindingRewrite?: number
}) {
	return {
		row: { publishedCommit: 'c1' },
		artifact: {
			kind: input.kind,
			publishedCommit: 'c1',
			modules: { 'index.js': input.code },
			dependencies: input.dependencies ?? [{ packageId: 'pkg-1' }],
			packageContext: { packageId: 'pkg-1' },
			...(input.packageBindingRewrite
				? { packageBindingRewrite: input.packageBindingRewrite }
				: {}),
		},
	}
}

const staleMixed = artifact({
	kind: 'module',
	code: 'export default () => fetch("https://example.com")',
	dependencies: [{ packageId: 'pkg-1' }, { packageId: 'pkg-wrapper' }],
})
const staleSingle = artifact({
	kind: 'job',
	code: 'export default () => fetch("https://example.com")',
})
const current = artifact({
	kind: 'importable-module',
	code: 'export default () => fetch("https://example.com")',
	packageBindingRewrite: 1,
})
const browser = artifact({
	kind: 'app-client',
	code: 'fetch("/x")',
})

beforeEach(() => {
	vi.clearAllMocks()
	mocks.listCandidatePackages.mockResolvedValue({
		packages: [{ id: 'pkg-1', userId: owner, sourceId: 'src-1' }],
		nextCursor: null,
	})
	mocks.loadPackageSourceRowForUser.mockResolvedValue({
		published_commit: 'c1',
	})
	mocks.loadPackageManifestForSource.mockResolvedValue({
		manifest: {
			name: 'demo',
			exports: { '.': './index.ts' },
			kody: {
				id: 'demo',
				description: 'demo',
				app: { entry: './app.ts', client: './client.ts' },
				jobs: {
					nightly: {
						entry: './job.ts',
						schedule: { type: 'interval', every: '1d' },
					},
				},
			},
		},
	})
	mocks.loadPublishedBundleArtifactsForPackageTargets.mockResolvedValue(
		new Map<string, unknown>([
			['module', staleMixed],
			['job', staleSingle],
			['importable-module', current],
			['app-client', browser],
		]),
	)
})

test('dry run counts stale isolate targets, including mixed bundles', async () => {
	const result = await runPreBindingArtifactRebuild({
		env,
		baseUrl: 'https://x',
	})
	expect(result).toMatchObject({
		dryRun: true,
		packagesNeedingRebuild: 1,
		staleTargets: 2,
		staleMultiPackageTargets: 1,
		rebuiltPackages: 0,
	})
	expect(mocks.rebuild).not.toHaveBeenCalled()
})

test('apply force-rebuilds only stale targets at the published commit', async () => {
	mocks.rebuild.mockImplementation(async () => {
		mocks.loadPublishedBundleArtifactsForPackageTargets.mockResolvedValue(
			new Map([
				['module', current],
				['job', current],
			]),
		)
	})
	const result = await runPreBindingArtifactRebuild({
		env,
		baseUrl: 'https://x',
		dryRun: false,
	})
	expect(result).toMatchObject({ rebuiltPackages: 1, failedPackages: 0 })
	const call = mocks.rebuild.mock.calls[0]?.[0]
	expect(call).toMatchObject({ force: true, publishedCommit: 'c1' })
	expect(
		call.targets.map((target: { kind: string }) => target.kind).sort(),
	).toEqual(['job', 'module'])
})

test('apply reports a failure when a target is still pre-binding afterwards', async () => {
	mocks.rebuild.mockResolvedValue(undefined)
	const result = await runPreBindingArtifactRebuild({
		env,
		baseUrl: 'https://x',
		dryRun: false,
	})
	expect(result).toMatchObject({
		rebuiltPackages: 0,
		failedPackages: 1,
		stillStaleAfterRebuild: 1,
	})
})

test('apply reports a failure when a rebuilt target is missing afterwards', async () => {
	mocks.rebuild.mockImplementation(async () => {
		mocks.loadPublishedBundleArtifactsForPackageTargets.mockResolvedValue(
			new Map([['module', current]]),
		)
	})
	const result = await runPreBindingArtifactRebuild({
		env,
		baseUrl: 'https://x',
		dryRun: false,
	})
	expect(result).toMatchObject({
		rebuiltPackages: 0,
		failedPackages: 1,
		stillStaleAfterRebuild: 1,
	})
})

test('apply skips the rebuild when the published commit moves', async () => {
	mocks.loadPackageSourceRowForUser
		.mockResolvedValueOnce({ published_commit: 'c1' })
		.mockResolvedValueOnce({ published_commit: 'c2' })
	const result = await runPreBindingArtifactRebuild({
		env,
		baseUrl: 'https://x',
		dryRun: false,
	})
	expect(mocks.rebuild).not.toHaveBeenCalled()
	expect(result).toMatchObject({ rebuiltPackages: 0, failedPackages: 1 })
	expect(result.outcomes[0]).toMatchObject({ outcome: 'failed' })
})

test('a package with only other-commit artifacts is reported, not current', async () => {
	mocks.loadPublishedBundleArtifactsForPackageTargets.mockResolvedValue(
		new Map([
			[
				'module',
				{
					...current,
					artifact: { ...current.artifact, publishedCommit: 'c0' },
				},
			],
		]),
	)
	const result = await runPreBindingArtifactRebuild({
		env,
		baseUrl: 'https://x',
	})
	expect(result).toMatchObject({
		currentPackages: 0,
		otherCommitPackages: 1,
		packagesNeedingRebuild: 0,
	})
	expect(result.outcomes[0]).toMatchObject({
		outcome: 'other_commit_artifacts',
		otherCommitTargets: 1,
	})
})

test('apply fails when the published commit moves during the rebuild', async () => {
	mocks.loadPackageSourceRowForUser
		.mockResolvedValueOnce({ published_commit: 'c1' })
		.mockResolvedValueOnce({ published_commit: 'c1' })
		.mockResolvedValueOnce({ published_commit: 'c2' })
	mocks.rebuild.mockImplementation(async () => {
		mocks.loadPublishedBundleArtifactsForPackageTargets.mockResolvedValue(
			new Map([
				['module', current],
				['job', current],
			]),
		)
	})
	const result = await runPreBindingArtifactRebuild({
		env,
		baseUrl: 'https://x',
		dryRun: false,
	})
	expect(mocks.rebuild).toHaveBeenCalledTimes(1)
	expect(result).toMatchObject({ rebuiltPackages: 0, failedPackages: 1 })
})
