import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	consoleWarn,
	silenceExpectedConsoleWarns,
} from '#worker/test-support/console-spies.ts'
import type * as PublishedBundleArtifactsModule from './published-bundle-artifacts.ts'
import {
	moduleGraphMockModule as mockModule,
	createBundleResult,
	createTemporaryModuleGraph,
	createSavedPackageRecord,
	createLoadedPackageSource,
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

const { buildKodyImportableModuleBundle, buildKodyModuleBundle } =
	await import('./module-graph.ts')

const graphInput = {
	env: { APP_DB: {}, REPO_SESSION: {} } as Env,
	baseUrl: 'https://heykody.dev',
	userId: ownerIdFromStored('user-1'),
}

type Manifest = {
	name: string
	kodyId: string
	description?: string
	exports: Record<string, string>
	dependencies?: Record<string, string>
}

function manifestJson({
	name,
	kodyId,
	description = 'Example package',
	...rest
}: Manifest) {
	return JSON.stringify({ name, ...rest, kody: { id: kodyId, description } })
}

function makePackageFiles(manifest: Manifest, files: Record<string, string>) {
	return { 'package.json': manifestJson(manifest), ...files }
}

const examplePackage = {
	name: '@kentcdodds/example-package',
	kodyId: 'example-package',
}

function makeLoadedSource(
	manifest: Manifest,
	files: Record<string, string>,
	source = { id: 'source-1', published_commit: 'commit-1' },
) {
	const { name, kodyId, description = 'Example package', exports } = manifest
	return {
		source,
		manifest: { name, exports, kody: { id: kodyId, description } },
		files: makePackageFiles(manifest, files),
	}
}

function makeArtifactHit(artifact: {
	kind?: 'importable-module' | 'module'
	artifactName: string
	entryPoint: string
	mainModule: string
	modules: Record<string, unknown>
	dependencies?: Array<Record<string, string>>
	packageBindingRewrite?: number
}) {
	return {
		row: { id: `artifact-${artifact.artifactName}` },
		artifact: {
			version: 1,
			kind: 'importable-module',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			dependencies: [],
			packageContext: {
				packageId: 'pkg-1',
				kodyId: 'example-package',
				sourceId: 'source-1',
			},
			createdAt: '2026-05-01T00:00:00.000Z',
			// Current-builder fixtures carry the marker so unmarked multi-package
			// leftovers are not mistaken for pre-binding bundles under test.
			packageBindingRewrite: 1,
			...artifact,
		},
	}
}

function mockSavedPackagesByName(
	records: Record<string, ReturnType<typeof createSavedPackageRecord>>,
) {
	mockModule.getSavedPackageByName.mockImplementation(
		async (_db: unknown, { name }: { name: string }) => records[name] ?? null,
	)
}

function buildLocal(
	files: Record<string, string>,
	{
		entryPoint = 'index.js',
		exports = { '.': './index.js' },
	}: { entryPoint?: string; exports?: Record<string, string> } = {},
) {
	return buildKodyModuleBundle({
		...graphInput,
		sourceFiles: makePackageFiles(
			{
				name: '@kentcdodds/local-package',
				kodyId: 'local-package',
				description: 'Local package',
				exports,
			},
			files,
		),
		entryPoint,
	})
}

function bundlerFiles(call = mockModule.createWorker.mock.calls[0]) {
	return (
		(call?.[0] as { files?: Record<string, string> } | undefined)?.files ?? {}
	)
}

function findProxy(files: Record<string, string>) {
	return Object.entries(files).find(([path]) =>
		path.includes('__kody_virtual__/imports/'),
	)
}

function expectedDependency(
	sourceId: string,
	publishedCommit: string,
	record: {
		kodyId: string
		name: string
		packageId?: string
	},
) {
	return {
		sourceId,
		publishedCommit,
		kodyId: record.kodyId,
		packageName: record.name,
		packageId: record.packageId ?? 'pkg-1',
	}
}

test('buildKodyModuleBundle resolves scoped package imports by full package name first', async () => {
	mockModule.createWorker.mockResolvedValue(createBundleResult('scoped-import'))
	mockModule.getSavedPackageByName.mockResolvedValue(
		createSavedPackageRecord(examplePackage),
	)
	mockModule.resolveSavedPackageRef.mockResolvedValue(null)
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		createLoadedPackageSource(),
	)

	await buildLocal({
		'index.js':
			'import followUp from "kody:@kentcdodds/example-package/follow-up-on-pr-agent"\nexport default followUp\n',
	})

	expect(mockModule.getSavedPackageByName).toHaveBeenCalledWith(
		{},
		{
			userId: ownerIdFromStored('user-1'),
			name: '@kentcdodds/example-package',
		},
	)
	expect(mockModule.resolveSavedPackageRef).not.toHaveBeenCalled()
	const rootEntry = bundlerFiles()['.__kody_root__/index.js']
	expect(rootEntry).toContain('__kody_virtual__/imports/')
	expect(rootEntry).not.toContain(
		'kody:@kentcdodds/example-package/follow-up-on-pr-agent',
	)
})

test('buildKodyModuleBundle proxies package module default and named exports', async () => {
	mockModule.createWorker.mockResolvedValue(createBundleResult('named-import'))
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		...makeLoadedSource(
			{ ...examplePackage, exports: { './math': './math.js' } },
			{},
		),
		files: {
			'math.js':
				'export default function multiply(left, right) { return left * right }\nexport function add(left, right) { return left + right }',
		},
	})

	await buildLocal({
		'index.js': `import multiply, { add } from "kody:@kentcdodds/example-package/math"
export default () => multiply(2, 3) + add(1, 2)`,
	})

	const proxy = findProxy(bundlerFiles())?.[1]
	// Static import proxies stamp the callee package id and wrap function
	// valued exports in the call-metering runtime helper.
	for (const fragment of [
		'export * from',
		'import * as __kodyPackageModule',
		'export default __kodyMeterStaticPackageExport("pkg-1", __kodyPackageModule.default)',
		'const __kodyMeteredStaticExport0 = __kodyMeterStaticPackageExport("pkg-1", __kodyPackageModule.add);',
		'export { __kodyMeteredStaticExport0 as add };',
	]) {
		expect(proxy).toContain(fragment)
	}
})

test.each([
	{
		name: 'default-only',
		source: 'export default async () => ({ ok: true })',
		importsDefault: true,
	},
	{
		name: 'named-only',
		source: 'export function double(value: number) { return value * 2 }',
		importsDefault: false,
	},
	{
		name: 'default and named',
		source: `export function double(value: number) { return value * 2 }
export default async () => double(2)`,
		importsDefault: true,
	},
	{
		name: 'unparseable',
		source: 'export const = not parseable {{{',
		importsDefault: true,
	},
])(
	'buildKodyModuleBundle only imports a callable default when the $name entry declares one',
	async ({ source, importsDefault }) => {
		mockModule.createWorker.mockResolvedValue(createBundleResult('entry-shape'))
		await buildLocal(
			{ 'src/index.ts': source },
			{ entryPoint: 'src/index.ts', exports: { '.': './src/index.ts' } },
		)

		const entry = bundlerFiles()['.__kody_root__/.__kody_execute_entry__.js']
		if (importsDefault) {
			expect(entry).toContain('import userEntrypoint from "./src/index.ts"')
			expect(entry).not.toContain('?? userModule')
			return
		}
		expect(entry).not.toContain('userEntrypoint')
		expect(entry).toContain('import "./src/index.ts";')
		expect(entry).toContain('\\"src/index.ts\\" has no default export')
	},
)

test('saved package exports with npm dependencies require, then prefer, a published importable artifact', async () => {
	mockModule.createWorker.mockResolvedValue(
		createBundleResult('published-artifact'),
	)
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource(
			{
				...examplePackage,
				exports: { './html': './src/html.ts' },
				dependencies: { marked: '18.0.2' },
			},
			{
				'src/html.ts':
					'import { marked } from "marked"\nexport default async function render() { return marked.parse("**ok**") }',
			},
		),
	)
	const importHtml = () =>
		buildLocal({
			'index.js':
				'import render from "kody:@kentcdodds/example-package/html"\nexport default render\n',
		})

	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(null)
	await expect(importHtml()).rejects.toThrow(
		'no published runtime bundle artifact is available yet. Republish the package so Kody can install dependencies and persist a fresh runtime bundle artifact.',
	)

	mockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: { kind: string }) =>
			input.kind === 'importable-module'
				? makeArtifactHit({
						artifactName: './html',
						entryPoint: 'src/html.ts',
						mainModule: 'dist/html.js',
						modules: {
							'dist/html.js':
								'export const helper = "ok"; export default async function render(input) { return input }',
						},
						dependencies: [
							{
								sourceId: 'source-1',
								publishedCommit: 'commit-1',
								kodyId: 'example-package',
								packageName: '@kentcdodds/example-package',
							},
						],
					})
				: null,
	)
	const result = await importHtml()

	expect(result.dependencies).toEqual([
		expectedDependency('source-1', 'commit-1', examplePackage),
	])
	const files = bundlerFiles()
	const artifactEntry = Object.entries(files).find(
		([path]) =>
			path.includes('.__published_bundle__') && path.endsWith('/dist/html.js'),
	)?.[1]
	expect(artifactEntry).toContain('export const helper = "ok"')
	expect(artifactEntry).toContain('return input')
	expect(artifactEntry).not.toContain('__kodyRuntime')
	expect(mockModule.loadPublishedBundleArtifactByIdentity).toHaveBeenCalledWith(
		expect.objectContaining({
			kind: 'importable-module',
			artifactName: './html',
			entryPoint: 'src/html.ts',
		}),
	)
	const proxySource = findProxy(files)?.[1]
	expect(proxySource).toContain('.__published_bundle__')
	expect(proxySource).not.toContain('src/html.ts')
})

test('buildKodyModuleBundle imports published importable defaults as callable default exports', async () => {
	mockModule.createWorker.mockImplementation(
		async (input: { files: Record<string, string>; entryPoint: string }) => ({
			mainModule: input.entryPoint,
			modules: input.files,
			dependencies: [],
		}),
	)
	const callableManifest = {
		...examplePackage,
		exports: { './callable': './src/callable.js' },
	}
	const callableFiles = {
		'src/callable.js': `export const marker = "provider"
export default function callable(input = {}) {
	return { ok: true, value: input.value }
}`,
	}
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource(callableManifest, callableFiles),
	)
	const importableBundle = await buildKodyImportableModuleBundle({
		...graphInput,
		sourceFiles: makePackageFiles(callableManifest, callableFiles),
		entryPoint: 'src/callable.js',
	})
	mockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: { kind: string }) =>
			input.kind === 'importable-module'
				? makeArtifactHit({
						artifactName: './callable',
						entryPoint: 'src/callable.js',
						mainModule: importableBundle.mainModule,
						modules: importableBundle.modules,
					})
				: null,
	)

	await buildLocal({
		'index.js': `import callable from "kody:@kentcdodds/example-package/callable"
export default callable`,
	})

	const consumerFiles = bundlerFiles(mockModule.createWorker.mock.calls.at(-1))
	const proxyEntry = findProxy(consumerFiles)
	expect(proxyEntry).toBeDefined()
	const moduleGraph = await createTemporaryModuleGraph(consumerFiles)
	try {
		const proxyModule = await moduleGraph.importModule(proxyEntry?.[0] ?? '')
		expect(proxyModule.marker).toBe('provider')
		expect(proxyModule.default({ value: 'from-published-artifact' })).toEqual({
			ok: true,
			value: 'from-published-artifact',
		})
	} finally {
		await moduleGraph.cleanup()
	}
})

test('buildKodyModuleBundle keeps distinct proxy and artifact paths for exports whose names only differ by punctuation', async () => {
	mockModule.createWorker.mockResolvedValue(
		createBundleResult('published-artifact-collision-safe'),
	)
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	const markedExport = (name: string) =>
		`import { marked } from "marked"\nexport default async function ${name}() { return marked.parse("**${name}**") }`
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource(
			{
				...examplePackage,
				exports: {
					'./foo.bar': './src/foo-dot.ts',
					'./foo-bar': './src/foo-dash.ts',
				},
				dependencies: { marked: '18.0.2' },
			},
			{
				'src/foo-dot.ts': markedExport('fooDot'),
				'src/foo-dash.ts': markedExport('fooDash'),
			},
		),
	)
	const artifactsByName: Record<string, string> = {
		'./foo.bar': 'dot',
		'./foo-bar': 'dash',
	}
	mockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: { artifactName?: string | null }) => {
			const suffix = artifactsByName[input.artifactName ?? '']
			return suffix
				? makeArtifactHit({
						kind: 'module',
						artifactName: input.artifactName ?? '',
						entryPoint: `src/foo-${suffix}.ts`,
						mainModule: `dist/foo-${suffix}.js`,
						modules: {
							[`dist/foo-${suffix}.js`]: `export default "${suffix}"`,
						},
					})
				: null
		},
	)

	await buildLocal({
		'index.js': `import fooDot from "kody:@kentcdodds/example-package/foo.bar"
import fooDash from "kody:@kentcdodds/example-package/foo-bar"
export default [fooDot, fooDash]`,
	})

	const paths = Object.keys(bundlerFiles())
	const publishedBundlePaths = paths.filter((path) =>
		path.includes('.__published_bundle__'),
	)
	for (const suffix of ['dot', 'dash']) {
		expect(
			publishedBundlePaths.filter((path) =>
				path.endsWith(`/dist/foo-${suffix}.js`),
			),
		).toHaveLength(1)
	}
	expect(new Set(publishedBundlePaths).size).toBe(publishedBundlePaths.length)
	const proxyPaths = paths.filter((path) =>
		path.includes('__kody_virtual__/imports/'),
	)
	expect(proxyPaths).toHaveLength(2)
	expect(new Set(proxyPaths).size).toBe(2)
})

test('buildKodyModuleBundle skips package source materialization when published importable artifacts exist', async () => {
	mockModule.createWorker.mockResolvedValue(
		createBundleResult('artifact-skips-source-vfs'),
	)
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource(
			{
				...examplePackage,
				exports: {
					'./list': './src/list.ts',
					'./trigger': './src/trigger.ts',
				},
				dependencies: { zod: '^4.5.4' },
			},
			{
				'src/list.ts':
					'import { z } from "zod"\nexport default async function list() { return z.string() }',
				'src/trigger.ts':
					'import { z } from "zod"\nexport default async function trigger() { return z.number() }',
				'node_modules/zod/package.json': '{"name":"zod","main":"index.js"}',
				'node_modules/zod/index.js':
					'export const z = { string: () => "string", number: () => "number" }',
			},
		),
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: { artifactName?: string | null; entryPoint?: string }) => {
			const name = input.artifactName ?? ''
			if (name !== './list' && name !== './trigger') return null
			const leaf = name.slice(2)
			return makeArtifactHit({
				artifactName: name,
				entryPoint: input.entryPoint ?? `src/${leaf}.ts`,
				mainModule: `dist/${leaf}.js`,
				modules: {
					[`dist/${leaf}.js`]: `export default async function ${leaf}() { return "${leaf}" }`,
					'node_modules/zod/index.js':
						'export const z = { string: () => "string", number: () => "number" }',
				},
			})
		},
	)

	await buildLocal({
		'index.js': `import list from "kody:@kentcdodds/example-package/list"
import trigger from "kody:@kentcdodds/example-package/trigger"
export default async function main() { return { list: typeof list, trigger: typeof trigger } }`,
	})

	const paths = Object.keys(bundlerFiles())
	expect(
		paths.filter((path) => path.includes('.__published_bundle__/')),
	).toEqual(
		expect.arrayContaining([
			expect.stringContaining('/dist/list.js'),
			expect.stringContaining('/dist/trigger.js'),
		]),
	)
	expect(
		paths.some(
			(path) =>
				path.includes('.__kody_packages__/') &&
				path.includes('/node_modules/zod/') &&
				!path.includes('.__published_bundle__/'),
		),
	).toBe(false)
	expect(
		paths.some(
			(path) =>
				path.includes('.__kody_packages__/') &&
				(path.endsWith('/src/list.ts') || path.endsWith('/src/trigger.ts')),
		),
	).toBe(false)
})

test('buildKodyModuleBundle resolves transitive imports back to the root package source during rebuilds', async () => {
	mockModule.createWorker.mockResolvedValue(createBundleResult('root-cycle'))
	const journaling = { name: '@kentcdodds/journaling', kodyId: 'journaling' }
	mockModule.getSavedPackageByName.mockResolvedValue(
		createSavedPackageRecord({ ...journaling, sourceId: 'journaling-source' }),
	)
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource(
			{
				...journaling,
				description: 'Journaling package',
				exports: { './upsert-for-thread': './src/upsert-for-thread.ts' },
			},
			{
				'src/upsert-for-thread.ts':
					'import ensureState from "kody:@kentcdodds/personal-history/state-ensure"\nexport default ensureState\n',
			},
			{ id: 'journaling-source', published_commit: 'journaling-commit' },
		),
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(null)

	await expect(
		buildKodyModuleBundle({
			...graphInput,
			sourceFiles: makePackageFiles(
				{
					name: '@kentcdodds/personal-history',
					kodyId: 'personal-history',
					description: 'Personal history package',
					exports: {
						'.': './src/index.ts',
						'./state-ensure': './src/state-ensure.ts',
					},
					dependencies: { jsonrepair: '3.13.1' },
				},
				{
					'src/index.ts':
						'import upsert from "kody:@kentcdodds/journaling/upsert-for-thread"\nexport default upsert\n',
					'src/state-ensure.ts':
						'export default async function ensureState() { return { ok: true } }\n',
				},
			),
			entryPoint: 'src/index.ts',
		}),
	).resolves.toEqual({
		...createBundleResult('root-cycle'),
		dependencies: [
			expectedDependency('journaling-source', 'journaling-commit', journaling),
		],
	})
	expect(mockModule.getSavedPackageByName).toHaveBeenCalledTimes(1)
	expect(mockModule.getSavedPackageByName).toHaveBeenCalledWith(
		{},
		{ userId: ownerIdFromStored('user-1'), name: '@kentcdodds/journaling' },
	)
})

test('buildKodyModuleBundle keeps dependencies for scoped packages with the same leaf', async () => {
	mockModule.createWorker.mockResolvedValue(createBundleResult('shared-leaf'))
	const owners = ['alice', 'bob']
	mockSavedPackagesByName(
		Object.fromEntries(
			owners.map((owner) => [
				`@${owner}/shared-package`,
				createSavedPackageRecord({
					name: `@${owner}/shared-package`,
					kodyId: 'shared-package',
					sourceId: `source-${owner}`,
				}),
			]),
		),
	)
	mockModule.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			const sourceName = `@${input.sourceId.replace('source-', '')}/shared-package`
			return {
				...createLoadedPackageSource(),
				source: {
					id: input.sourceId,
					published_commit: `commit-${input.sourceId}`,
				},
				files: {
					'index.js': `export const source = ${JSON.stringify(sourceName)}`,
					'follow-up-on-pr-agent.js': `export default ${JSON.stringify(sourceName)}`,
				},
			}
		},
	)

	const result = await buildLocal({
		'index.js': `import aliceFn from "kody:@alice/shared-package/follow-up-on-pr-agent"
import bobFn from "kody:@bob/shared-package/follow-up-on-pr-agent"
export default [aliceFn, bobFn]`,
	})

	expect(result.dependencies).toEqual(
		owners.map((owner) =>
			expectedDependency(`source-${owner}`, `commit-source-${owner}`, {
				kodyId: 'shared-package',
				name: `@${owner}/shared-package`,
			}),
		),
	)
	expect(bundlerFiles()).toMatchObject(
		Object.fromEntries(
			owners.map((owner) => [
				`.__kody_packages__/@${owner}/shared-package/index.js`,
				`export const source = "@${owner}/shared-package"`,
			]),
		),
	)
})

const reachablePackage = {
	name: '@alice/reachable-package',
	kodyId: 'reachable-package',
	packageId: 'pkg-reachable',
}

function makeReachableRecord(name: string, kodyId: string, sourceId: string) {
	return {
		...createSavedPackageRecord({ name, kodyId, sourceId }),
		id: `pkg-${sourceId.replace('source-', '')}`,
	}
}

function makeDependencySource(
	sourceId: string,
	manifest: { name: string; kodyId: string },
	entry: string,
) {
	return {
		...makeLoadedSource(
			{
				...manifest,
				description: 'Dependency package',
				exports: { '.': entry },
			},
			{},
			{ id: sourceId, published_commit: `commit-${sourceId}` },
		),
		files: {
			'package.json': '{}',
			'src/index.ts': 'export default async function run() { return "ok" }',
		},
	}
}

test('buildKodyModuleBundle records only entrypoint-reachable kody package dependencies', async () => {
	mockModule.createWorker.mockResolvedValue(
		createBundleResult('reachable-deps'),
	)
	const unreachablePackage = {
		name: '@bob/unreachable-package',
		kodyId: 'unreachable-package',
	}
	mockSavedPackagesByName({
		[reachablePackage.name]: makeReachableRecord(
			reachablePackage.name,
			reachablePackage.kodyId,
			'source-reachable',
		),
		[unreachablePackage.name]: makeReachableRecord(
			unreachablePackage.name,
			unreachablePackage.kodyId,
			'source-unreachable',
		),
	})
	mockModule.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string }) =>
			makeDependencySource(
				input.sourceId,
				input.sourceId === 'source-reachable'
					? reachablePackage
					: unreachablePackage,
				'./src/index.ts',
			),
	)

	const result = await buildLocal(
		{
			'src/index.ts':
				'import "./reachable.js"; export default async function run() { return "ok" }',
			'src/reachable.ts':
				'import reachable from "kody:@alice/reachable-package"; export { reachable }',
			'src/unused.ts':
				'import unreachable from "kody:@bob/unreachable-package"; export { unreachable }',
		},
		{
			entryPoint: 'src/index.ts',
			exports: { '.': './src/index.ts', './unused': './src/unused.ts' },
		},
	)

	expect(result.dependencies).toEqual([
		expectedDependency(
			'source-reachable',
			'commit-source-reachable',
			reachablePackage,
		),
	])
})

test('buildKodyModuleBundle follows self kody imports when recording reachable dependencies', async () => {
	mockModule.createWorker.mockResolvedValue(
		createBundleResult('self-reachable-deps'),
	)
	mockSavedPackagesByName({
		[reachablePackage.name]: makeReachableRecord(
			reachablePackage.name,
			reachablePackage.kodyId,
			'source-reachable',
		),
	})
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeDependencySource(
			'source-reachable',
			reachablePackage,
			'./src/index.js',
		),
	)

	const result = await buildLocal(
		{
			'src/index.ts':
				'import helper from "kody:@kentcdodds/local-package/helper"; export default helper',
			'src/helper.ts':
				'import reachable from "kody:@alice/reachable-package"; export default reachable',
		},
		{
			entryPoint: 'src/index.ts',
			exports: { '.': './src/index.ts', './helper': './src/helper.js' },
		},
	)

	expect(result.dependencies).toEqual([
		expectedDependency(
			'source-reachable',
			'commit-source-reachable',
			reachablePackage,
		),
	])
	const files = bundlerFiles()
	expect(
		Object.values(files).some((source) => source.includes('src/helper.ts')),
	).toBe(true)
	const paths = Object.keys(files)
	expect(paths).toContain('.__kody_root__/src/helper.ts')
	expect(paths).not.toContain('.__kody_root__/src/helper.js')
	expect(paths).toContain(
		'.__kody_packages__/@alice/reachable-package/src/index.ts',
	)
	expect(paths).not.toContain(
		'.__kody_packages__/@alice/reachable-package/src/index.js',
	)
})

test('a pre-fix multi-package npm artifact that cannot rebuild is still composed, and reported', async () => {
	silenceExpectedConsoleWarns([/pre_binding_bundle_needs_republish/])
	mockModule.createWorker.mockResolvedValue(
		createBundleResult('published-artifact'),
	)
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource(
			{
				...examplePackage,
				exports: { './html': './src/html.ts' },
				dependencies: { marked: '18.0.2' },
			},
			{
				'src/html.ts':
					'import { marked } from "marked"\nexport default async function render() { return marked.parse("**ok**") }',
			},
		),
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: { kind: string }) =>
			input.kind === 'importable-module'
				? makeArtifactHit({
						artifactName: './html',
						entryPoint: 'src/html.ts',
						mainModule: 'dist/html.js',
						modules: {
							'dist/html.js':
								'export default async function render() { return await fetch("https://example.com") }',
						},
						dependencies: [
							{
								sourceId: 'source-other',
								publishedCommit: 'commit-other',
								kodyId: 'other-package',
								packageId: 'pkg-other',
							},
						],
						// Explicitly unmarked: a pre-fix multi-package leftover.
						packageBindingRewrite: undefined,
					})
				: null,
	)
	await buildLocal({
		'index.js':
			'import render from "kody:@kentcdodds/example-package/html"\nexport default render\n',
	})
	const artifactEntry = Object.entries(bundlerFiles()).find(
		([path]) =>
			path.includes('.__published_bundle__') && path.endsWith('/dist/html.js'),
	)?.[1]
	expect(artifactEntry).toContain('fetch("https://example.com")')
	expect(
		consoleWarn.mock.calls.some((call) =>
			String(call[0]).includes('pre_binding_bundle_needs_republish'),
		),
	).toBe(true)
})
