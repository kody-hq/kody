import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as PublishedBundleArtifactsModule from './published-bundle-artifacts.ts'
import {
	moduleGraphMockModule as mockModule,
	createBundleResult,
	createSavedPackageRecord,
} from '#worker/test-support/module-graph.ts'

vi.mock('#worker/worker-bundler-modules.ts', () => ({
	importWorkerBundler: async () => ({
		createWorker: (...args: Array<unknown>) => mockModule.createWorker(...args),
	}),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	resolveSavedPackageRef: (...args: Array<unknown>) =>
		mockModule.resolveSavedPackageRef(...args),
	getSavedPackageByName: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByName(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
	loadServingPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadServingPackageSourceBySourceId(...args),
}))

vi.mock('./published-bundle-artifacts.ts', async () => {
	const actual = await vi.importActual<typeof PublishedBundleArtifactsModule>(
		'./published-bundle-artifacts.ts',
	)
	return {
		...actual,
		loadPublishedBundleArtifactByIdentity: (...args: Array<unknown>) =>
			mockModule.loadPublishedBundleArtifactByIdentity(...args),
	}
})

const { buildKodyModuleBundle } = await import('./module-graph.ts')

const release = { name: '@kentcdodds/release', kodyId: 'release' }
const ai = { name: '@kentcdodds/ai', kodyId: 'ai' }

function loadedSource(input: {
	manifest: { name: string; kodyId: string }
	exports: Record<string, string>
	dependencies?: Record<string, string>
	files: Record<string, string>
	source: {
		id: string
		published_commit: string
		serving_commit: string | null
	}
}) {
	const manifest = {
		name: input.manifest.name,
		exports: input.exports,
		...(input.dependencies ? { dependencies: input.dependencies } : {}),
		kody: { id: input.manifest.kodyId, description: 'Saved package' },
	}
	return {
		source: input.source,
		manifest,
		files: { 'package.json': JSON.stringify(manifest), ...input.files },
	}
}

const modelStepArtifact = {
	version: 1,
	kind: 'importable-module',
	sourceId: 'ai-source',
	publishedCommit: 'ai-commit-1',
	artifactName: './model-step',
	entryPoint: 'src/model-step.ts',
	mainModule: 'dist/model-step.js',
	modules: {
		'dist/model-step.js':
			'export default async function modelStep() { return "saved model step" }',
	},
	dependencies: [],
	packageContext: { packageId: 'pkg-ai', kodyId: 'ai', sourceId: 'ai-source' },
	createdAt: '2026-10-30T00:00:00.000Z',
	packageBindingRewrite: 1,
}

/**
 * Nightly release prepare: a job imports `@kentcdodds/release`, whose source
 * imports `@kentcdodds/ai/model-step`. The ai package was published ahead of
 * its saved builds, so migration 0245 left it without a serving pointer and
 * its only saved model-step payload is at the identity row's older commit.
 */
function mockReleaseGraph() {
	mockModule.createWorker.mockResolvedValue(createBundleResult('prepare'))
	mockModule.getSavedPackageByName.mockImplementation(
		async (_db: unknown, { name }: { name: string }) =>
			name === release.name
				? createSavedPackageRecord({ ...release, sourceId: 'release-source' })
				: name === ai.name
					? createSavedPackageRecord({ ...ai, sourceId: 'ai-source' })
					: null,
	)
	mockModule.loadPackageSourceBySourceId.mockImplementation(
		async ({ sourceId }: { sourceId: string }) =>
			sourceId === 'release-source'
				? loadedSource({
						manifest: release,
						exports: { './prepare': './src/prepare.ts' },
						files: {
							'src/prepare.ts':
								'import modelStep from "kody:@kentcdodds/ai/model-step"\nexport default async function prepare() { return modelStep() }\n',
						},
						source: {
							id: 'release-source',
							published_commit: 'release-commit',
							serving_commit: 'release-commit',
						},
					})
				: loadedSource({
						manifest: ai,
						exports: { './model-step': './src/model-step.ts' },
						dependencies: { ai: '^5.0.0', zod: '^4.1.0' },
						files: {
							'src/model-step.ts':
								'import { generateText } from "ai"\nexport default async function modelStep() { return generateText }\n',
						},
						source: {
							id: 'ai-source',
							published_commit: 'ai-commit-2',
							serving_commit: null,
						},
					}),
	)
	// Commit-keyed KV: a reader pinned to a commit without a saved payload
	// misses; an unpinned read gets the identity row's newest saved build.
	mockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: {
			sourceId: string
			artifactName?: string | null
			commit?: string | null
		}) => {
			if (input.sourceId !== 'ai-source') return null
			if (input.artifactName !== './model-step') return null
			const row = { id: 'artifact-model-step', publishedCommit: 'ai-commit-1' }
			return input.commit == null || input.commit === 'ai-commit-1'
				? { row, artifact: modelStepArtifact }
				: { row: { ...row, publishedCommit: input.commit }, artifact: null }
		},
	)
}

test('a nested import reuses the saved build of a dependency without a serving pointer', async () => {
	mockReleaseGraph()

	await buildKodyModuleBundle({
		env: { APP_DB: {}, REPO_SESSION: {} } as Env,
		baseUrl: 'https://heykody.dev',
		userId: ownerIdFromStored('user-1'),
		sourceFiles: {
			'package.json': JSON.stringify({
				name: '@kentcdodds/nightly',
				exports: { '.': './index.js' },
				kody: { id: 'nightly', description: 'Nightly release job' },
			}),
			'index.js':
				'import prepare from "kody:@kentcdodds/release/prepare"\nexport default prepare\n',
		},
		entryPoint: 'index.js',
	})

	expect(mockModule.loadPublishedBundleArtifactByIdentity).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'ai-source',
			artifactName: './model-step',
			commit: null,
		}),
	)
	expect(mockModule.createWorker).toHaveBeenCalledTimes(1)
	const files = (
		mockModule.createWorker.mock.calls[0]?.[0] as {
			files: Record<string, string>
		}
	).files
	const paths = Object.keys(files)
	expect(
		paths.find(
			(path) =>
				path.includes('.__published_bundle__/') &&
				path.endsWith('/dist/model-step.js'),
		),
	).toBeDefined()
	expect(paths.some((path) => path.endsWith('/src/model-step.ts'))).toBe(false)
	expect(
		paths.some((path) =>
			path.includes('.__kody_packages__/@kentcdodds/release/'),
		),
	).toBe(true)
})
