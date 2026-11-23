import { beforeEach, expect, test, vi } from 'vitest'
import { publishOffloadLimits } from './policy.ts'

const commit = 'c'.repeat(40)
const chunkSha = 'd'.repeat(64)
const finished = vi.fn(async (_input: unknown) => {})
function documentWith(target: Record<string, unknown>) {
	return {
		builderVersion: 2,
		commit,
		files: [],
		targets: [target],
	} as Record<string, unknown>
}
const jsonModuleTarget = {
	kind: 'app-client',
	bundleKind: 'app-client',
	artifactName: null,
	entryPoint: 'src/client.ts',
	mainModule: 'data.json',
	modules: {
		'data.json': { sha256: chunkSha, size: 16, chunks: [chunkSha] },
	},
}
const state: { document: Record<string, unknown> } = {
	document: documentWith(jsonModuleTarget),
}
beforeEach(() => {
	state.document = documentWith(jsonModuleTarget)
	finished.mockClear()
})

vi.mock('./store.ts', () => ({
	getPublishBuild: async () => ({
		id: 'pb_1',
		source_id: 'src_1',
		commit_sha: commit,
		origin: 'cli',
		context_name: null,
		document_sha256: 'e'.repeat(64),
	}),
	readPublishBuildDocument: async () => ({ kind: 'ok', value: state.document }),
	finishPublishBuild: (input: unknown) => finished(input),
	publishBuildBlobKey: (buildId: string, sha: string) =>
		`publish-builds/${buildId}/blobs/${sha}`,
}))
vi.mock('./verify.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('./verify.ts')>()),
	assertSupportedBuilderVersion: () => {},
	verifySourceManifest: async () => {},
	matchUploadedTargets: (input: { expected: Array<unknown> }) =>
		input.expected.map((target) => ({
			target,
			uploaded: (state.document.targets as Array<unknown>)[0],
		})),
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

function persist(bucket: unknown) {
	return persistUploadedPublishBuild({
		env: { APP_DB: {}, REPO_SESSION_BLOBS: bucket } as never,
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
}

test('an uploaded JSON module that is not valid JSON rejects the build instead of throwing', async () => {
	const bytes = new TextEncoder().encode('json\0{"broken":')
	const result = await persist({
		get: async () => ({ arrayBuffer: async () => bytes.slice().buffer }),
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

test('a module that repeats one chunk is refused before any chunk is read', async () => {
	state.document = documentWith({
		...jsonModuleTarget,
		modules: {
			'data.json': {
				sha256: chunkSha,
				size: 10,
				chunks: Array.from({ length: 32 }, () => chunkSha),
			},
		},
	})
	let reads = 0
	const result = await persist({
		get: async () => {
			reads += 1
			return {
				arrayBuffer: async () =>
					new Uint8Array(publishOffloadLimits.chunkBytes).buffer,
			}
		},
	})
	expect(result).toEqual({
		ok: false,
		message: expect.stringMatching(
			/^Publish build rejected: the sealed build document is malformed: .*chunks/,
		),
	})
	expect(reads).toBe(0)
})

test('a chunk larger than its module size stops the read at that chunk', async () => {
	state.document = documentWith({
		...jsonModuleTarget,
		modules: {
			'data.json': {
				sha256: chunkSha,
				size: publishOffloadLimits.chunkBytes + 1,
				chunks: [chunkSha, chunkSha],
			},
		},
	})
	let reads = 0
	const result = await persist({
		get: async () => {
			reads += 1
			return {
				arrayBuffer: async () =>
					new Uint8Array(publishOffloadLimits.chunkBytes + 2).buffer,
			}
		},
	})
	expect(result).toEqual({
		ok: false,
		message:
			'Publish build rejected: an uploaded module is larger than its manifest size.',
	})
	expect(reads).toBe(1)
})

test('a sealed document with a malformed files entry rejects the build instead of throwing', async () => {
	state.document = { builderVersion: 2, commit, files: [null], targets: [] }
	await expect(persist({ get: async () => null })).resolves.toEqual({
		ok: false,
		message: expect.stringMatching(
			/^Publish build rejected: the sealed build document is malformed: files\.0/,
		),
	})
	expect(finished).toHaveBeenCalledWith(
		expect.objectContaining({ status: 'rejected' }),
	)
})
