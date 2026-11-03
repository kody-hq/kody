import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as ModuleGraphWorkspace from './module-graph-workspace.ts'
import type * as PublishedBundleArtifactsModule from './published-bundle-artifacts.ts'
import { moduleGraphMockModule as mockModule } from '#worker/test-support/module-graph.ts'

const collectReachableCalls = vi.hoisted(() => ({ count: 0 }))

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
		mockModule.loadPackageSourceBySourceId(...args),
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

vi.mock('./module-graph-workspace.ts', async () => {
	const actual = await vi.importActual<typeof ModuleGraphWorkspace>(
		'./module-graph-workspace.ts',
	)
	return {
		...actual,
		collectReachableSourceFilePaths: (
			...args: Parameters<typeof actual.collectReachableSourceFilePaths>
		) => {
			collectReachableCalls.count += 1
			return actual.collectReachableSourceFilePaths(...args)
		},
	}
})

const { buildKodyImportableModuleBundle, buildKodyModuleBundle } =
	await import('./module-graph.ts')

test('module and importable-module builders share one prepare per export graph', async () => {
	mockModule.createWorker.mockImplementation(
		async (input: { entryPoint: string; files: Record<string, string> }) => ({
			mainModule: input.entryPoint,
			modules: Object.fromEntries(
				Object.entries(input.files).map(([path, source]) => [
					path,
					{ type: 'esm', content: source },
				]),
			),
		}),
	)
	collectReachableCalls.count = 0

	const sourceFiles = {
		'package.json': JSON.stringify({
			name: '@alice/demo',
			exports: { '.': './src/index.ts' },
			kody: { id: 'demo', description: 'demo' },
		}),
		'src/index.ts':
			'import { helper } from "./helper.ts"\nexport default async function run() { return helper }\n',
		'src/helper.ts': 'export const helper = "ok"\n',
	}
	const prepareCache = new Map()
	const sharedInput = {
		env: { APP_DB: {}, REPO_SESSION: {} } as Env,
		baseUrl: 'https://heykody.dev',
		userId: ownerIdFromStored('user-1'),
		sourceFiles,
		entryPoint: 'src/index.ts',
		rootPackageId: 'pkg-1',
		prepareCache,
	}

	const [moduleBundle, importableBundle] = await Promise.all([
		buildKodyModuleBundle(sharedInput),
		buildKodyImportableModuleBundle(sharedInput),
	])

	expect(collectReachableCalls.count).toBe(1)
	expect(moduleBundle.mainModule).toContain('.__kody_execute_entry__')
	expect(importableBundle.mainModule).toContain('.__kody_import_entry__')
	expect(moduleBundle.modules[moduleBundle.mainModule]).toBeDefined()
	expect(importableBundle.modules[importableBundle.mainModule]).toBeDefined()

	// Without a shared cache, each bootstrap still prepares independently.
	collectReachableCalls.count = 0
	await Promise.all([
		buildKodyModuleBundle({ ...sharedInput, prepareCache: undefined }),
		buildKodyImportableModuleBundle({
			...sharedInput,
			prepareCache: undefined,
		}),
	])
	expect(collectReachableCalls.count).toBe(2)
})
