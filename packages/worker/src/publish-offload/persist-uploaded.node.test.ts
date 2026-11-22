import { expect, test, vi } from 'vitest'

const commit = 'c'.repeat(40)
const chunkSha = 'd'.repeat(64)
const finished = vi.fn(async (_input: unknown) => {})
const uploadedTarget = {
	kind: 'app-client',
	bundleKind: 'app-client',
	entryPoint: 'src/client.ts',
	mainModule: 'client.js',
	modules: {
		'data.json': { sha256: chunkSha, size: 10, chunks: [chunkSha] },
	},
}

vi.mock('./store.ts', () => ({
	getPublishBuild: async () => ({
		id: 'pb_1',
		source_id: 'src_1',
		commit_sha: commit,
		origin: 'cli',
		context_name: null,
	}),
	readPublishBuildDocument: async () => ({
		builderVersion: 2,
		commit,
		files: [],
		targets: [uploadedTarget],
	}),
	finishPublishBuild: (input: unknown) => finished(input),
	publishBuildBlobKey: (buildId: string, sha: string) =>
		`publish-builds/${buildId}/blobs/${sha}`,
}))
vi.mock('./verify.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('./verify.ts')>()),
	assertSupportedBuilderVersion: () => {},
	verifySourceManifest: async () => {},
	matchUploadedTargets: (input: { expected: Array<unknown> }) =>
		input.expected.map((target) => ({ target, uploaded: uploadedTarget })),
}))
vi.mock('#worker/package-runtime/published-bundle-artifact-persist.ts', () => ({
	persistPublishedPackageArtifactTargets: vi.fn(async () => []),
}))
vi.mock('#worker/package-runtime/module-graph-workspace.ts', () => ({
	resolveKodyDependenciesForEntryPoint: vi.fn(async () => []),
}))
vi.mock('./link-dependencies.ts', () => ({
	collectLinkedPackageImports: vi.fn(async () => new Map()),
	linkUploadedPackageImports: vi.fn(),
}))

const { persistUploadedPublishBuild } = await import('./persist-uploaded.ts')

test('an uploaded JSON module that is not valid JSON rejects the build instead of throwing', async () => {
	const bytes = new TextEncoder().encode('json\0{"broken":')
	const result = await persistUploadedPublishBuild({
		env: {
			APP_DB: {},
			REPO_SESSION_BLOBS: {
				get: async () => ({ arrayBuffer: async () => bytes.buffer }),
			},
		} as never,
		buildId: 'pb_1',
		baseUrl: 'https://kody.test',
		userId: 'user_1',
		source: { id: 'src_1' } as never,
		savedPackage: { id: 'pkg_1' } as never,
		publishedCommit: commit,
		sourceFiles: {},
		targets: [
			{
				kind: 'app-client',
				bundleKind: 'app-client',
				entryPoint: 'src/client.ts',
			} as never,
		],
	})
	expect(result).toEqual({
		ok: false,
		message:
			'Publish build rejected: an uploaded JSON module is not valid JSON.',
	})
	expect(finished).toHaveBeenCalledWith(
		expect.objectContaining({ buildId: 'pb_1', status: 'rejected' }),
	)
})
