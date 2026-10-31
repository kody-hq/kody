import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as PublishedBundleArtifactsModule from './published-bundle-artifacts.ts'
import {
	moduleGraphMockModule as mockModule,
	createBundleResult,
	createTemporaryModuleGraph,
	createSavedPackageRecord,
	createLoadedPackageSource,
	type RuntimeModule,
} from '#worker/test-support/module-graph.ts'
import { SavedPackageNotFoundError } from './package-import-resolution.ts'

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
		loadPublishedBundleArtifactsByIdentities: (...args: Array<unknown>) =>
			mockModule.loadPublishedBundleArtifactsByIdentities(...args),
	}
})

const { publishedBundleLoadIdentityKey } = await vi.importActual<
	typeof PublishedBundleArtifactsModule
>('./published-bundle-artifacts.ts')

const { buildKodyAppBundle, buildKodyModuleBundle, hydrateKodyRuntimeModules } =
	await import('./module-graph.ts')

const graphInput = {
	env: { APP_DB: {}, REPO_SESSION: {} } as Env,
	baseUrl: 'https://heykody.dev',
	userId: ownerIdFromStored('user-1'),
}

function makePackageFiles(
	name: string,
	kody: Record<string, unknown>,
	files: Record<string, string>,
	exports: Record<string, string> = { '.': './index.js' },
) {
	return {
		'package.json': JSON.stringify({ name, exports, kody }),
		...files,
	}
}

const localKody = { id: 'local-package', description: 'Local package' }

function buildLocal(
	indexSource: string,
	kody: Record<string, unknown> = localKody,
) {
	return buildKodyModuleBundle({
		...graphInput,
		sourceFiles: makePackageFiles('@kentcdodds/local-package', kody, {
			'index.js': indexSource,
		}),
		entryPoint: 'index.js',
	})
}

function passThroughBundler() {
	mockModule.createWorker.mockImplementation(
		async (input: { files: Record<string, string>; entryPoint: string }) => ({
			mainModule: input.entryPoint,
			modules: input.files,
			dependencies: [],
		}),
	)
}

function createDynamicPlaceholder(specifier: string) {
	return `export const __kodyDynamicPackageSpecifier = ${JSON.stringify(specifier)};
throw new Error('unhydrated ${specifier}');
`
}

type ModuleBundle = Awaited<ReturnType<typeof buildKodyModuleBundle>>

async function withHydratedGraph(
	bundle: ModuleBundle,
	fn: (
		moduleGraph: Awaited<ReturnType<typeof createTemporaryModuleGraph>>,
	) => Promise<void>,
) {
	const { modules } = await hydrateKodyRuntimeModules({
		...graphInput,
		modules: bundle.modules,
	})
	const moduleGraph = await createTemporaryModuleGraph(modules)
	try {
		await fn(moduleGraph)
	} finally {
		await moduleGraph.cleanup()
	}
}

async function runHydratedEntry(bundle: ModuleBundle) {
	let result: unknown
	await withHydratedGraph(bundle, async (moduleGraph) => {
		const entry = (await moduleGraph.importModule(bundle.mainModule)) as {
			default: () => Promise<unknown>
		}
		result = await entry.default()
	})
	return result
}

test('buildKodyModuleBundle keeps static imports pinned and rewrites literal dynamic imports to teaching errors', async () => {
	passThroughBundler()
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		...createLoadedPackageSource(),
		manifest: {
			...createLoadedPackageSource().manifest,
			exports: { './value': './value.js' },
		},
		files: {
			'value.js': 'export default function value() { return "source" }',
		},
	})
	let packageVersion = 'pinned'
	mockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: { userId: string; kind: string; artifactName?: string }) => {
			if (input.kind !== 'importable-module') return null
			return {
				row: {},
				artifact: {
					version: 1,
					kind: 'importable-module',
					artifactName: input.artifactName ?? './value',
					sourceId: 'source-1',
					publishedCommit: `commit-${packageVersion}`,
					entryPoint: './value.js',
					mainModule: 'value.js',
					modules: {
						'value.js': `export const marker = ${JSON.stringify(packageVersion)}
export default function value() { return ${JSON.stringify(packageVersion)} }`,
					},
					dependencies: [],
					dynamicDependencies: [],
					packageContext: null,
					createdAt: '2026-05-11T00:00:00.000Z',
				},
			}
		},
	)

	const bundle = await buildLocal(
		`import staticValue from 'kody:@kentcdodds/example-package/value'

export default async function run() {
	const dynamicModule = await import('kody:@kentcdodds/example-package/value')
	return {
		staticValue: staticValue(),
		dynamicValue: dynamicModule.default(),
		dynamicMarker: dynamicModule.marker,
	}
}
`,
		{ ...localKody, dependencies: ['@kentcdodds/example-package'] },
	)

	expect(bundle.dependencies).toEqual([
		{
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			kodyId: 'example-package',
			packageName: '@kentcdodds/example-package',
			packageId: 'pkg-1',
		},
	])
	// Unsupported literal dynamic kody imports produce no placeholder modules
	// or dynamic-dependency metadata; the call site becomes a teaching error.
	expect(bundle.dynamicDependencies ?? []).toEqual([])
	packageVersion = 'current'
	await expect(runHydratedEntry(bundle)).rejects.toThrow(
		'Dynamic import("kody:@kentcdodds/example-package/value") was removed: use a static import',
	)
	expect(mockModule.getSavedPackageByName).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			name: '@kentcdodds/example-package',
		}),
	)
})

test('buildKodyModuleBundle rejects computed dynamic kody package imports clearly at runtime', async () => {
	passThroughBundler()
	const bundle =
		await buildLocal(`const specifier = 'kody:@kentcdodds/example-package/value'

export default async function run() {
	return await import(specifier)
}
`)
	await expect(runHydratedEntry(bundle)).rejects.toThrow(
		'Dynamic kody:@ package import requires an authenticated runtime',
	)
})

test('hydrateKodyRuntimeModules terminates circular literal dynamic package imports', async () => {
	const packages = new Map(
		[
			['a', 'b'],
			['b', 'a'],
		].map(([leaf, nextLeaf]) => {
			const name = `@kentcdodds/${leaf}-package`
			const sourceId = `source-${leaf}`
			const commit = `commit-${leaf}`
			const nextSpecifier = `kody:@kentcdodds/${nextLeaf}-package/run`
			return [
				name,
				{
					row: createSavedPackageRecord({
						name,
						kodyId: `${leaf}-package`,
						sourceId,
					}),
					loaded: {
						source: { id: sourceId, published_commit: commit },
						manifest: {
							name,
							exports: { './run': './index.js' },
							kody: { id: `${leaf}-package`, description: `${name} package` },
						},
						files: {
							'index.js': 'export default async function run() { return "ok" }',
						},
					},
					artifact: {
						version: 1,
						kind: 'importable-module' as const,
						artifactName: './run',
						sourceId,
						publishedCommit: commit,
						entryPoint: './index.js',
						mainModule: 'index.js',
						modules: {
							'index.js': `export default async function run() {
	const module = await import('./.__kody_virtual__/dynamic-imports/next.js')
	return module.default
}
`,
							'.__kody_virtual__/dynamic-imports/next.js':
								createDynamicPlaceholder(nextSpecifier),
						},
						dependencies: [],
						dynamicDependencies: [
							{
								specifier: nextSpecifier,
								packageName: `@kentcdodds/${nextLeaf}-package`,
								exportName: './run',
							},
						],
						packageContext: null,
						createdAt: '2026-05-11T00:00:00.000Z',
					},
				},
			] as const
		}),
	)
	const bySourceId = (sourceId: string) =>
		[...packages.values()].find((entry) => entry.row.sourceId === sourceId)
	mockModule.getSavedPackageByName.mockImplementation(
		async (_db: unknown, input: { name: string }) =>
			packages.get(input.name)?.row ?? null,
	)
	mockModule.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string }) =>
			bySourceId(input.sourceId)?.loaded ?? null,
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: { sourceId: string }) => ({
			row: {},
			artifact: bySourceId(input.sourceId)?.artifact,
		}),
	)

	const { modules: hydratedModules } = await hydrateKodyRuntimeModules({
		...graphInput,
		modules: {
			'entry.js': `export default async function run() {
	const module = await import('./.__kody_virtual__/dynamic-imports/a.js')
	return module.default
}
`,
			'.__kody_virtual__/dynamic-imports/a.js': createDynamicPlaceholder(
				'kody:@kentcdodds/a-package/run',
			),
		},
	})

	expect(
		Object.keys(hydratedModules).filter((path) =>
			path.includes('/.__kody_current__/'),
		),
	).toHaveLength(4)
	expect(
		mockModule.loadPublishedBundleArtifactByIdentity,
	).toHaveBeenCalledTimes(2)
})

test("buildKodyModuleBundle batches published artifact lookups for a module's static package imports", async () => {
	passThroughBundler()
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		...createLoadedPackageSource(),
		manifest: {
			...createLoadedPackageSource().manifest,
			exports: { './a': './a.js', './b': './b.js' },
		},
		files: {
			'a.js': 'export default function a() { return "source-a" }',
			'b.js': 'export default function b() { return "source-b" }',
		},
	})
	const artifactFor = (name: string) => ({
		row: {},
		artifact: {
			version: 1,
			kind: 'importable-module',
			artifactName: `./${name}`,
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			entryPoint: `./${name}.js`,
			mainModule: `${name}.js`,
			modules: {
				[`${name}.js`]: `export default function ${name}() { return "artifact-${name}" }`,
			},
			dependencies: [],
			dynamicDependencies: [],
			packageContext: null,
			createdAt: '2026-05-11T00:00:00.000Z',
		},
	})
	mockModule.loadPublishedBundleArtifactByIdentity.mockReset()
	mockModule.loadPublishedBundleArtifactsByIdentities.mockReset()
	mockModule.loadPublishedBundleArtifactsByIdentities.mockImplementation(
		async (input: {
			identities: Array<{
				sourceId: string
				kind: 'importable-module'
				artifactName: string
				entryPoint: string
			}>
		}) =>
			new Map(
				input.identities.map((identity) => [
					publishedBundleLoadIdentityKey(identity),
					artifactFor(identity.artifactName.replace('./', '')),
				]),
			),
	)

	const bundle = await buildLocal(
		`import a from 'kody:@kentcdodds/example-package/a'
import b from 'kody:@kentcdodds/example-package/b'

export default async function run() {
	return [a(), b()]
}
`,
		{ ...localKody, dependencies: ['@kentcdodds/example-package'] },
	)

	expect(
		mockModule.loadPublishedBundleArtifactsByIdentities,
	).toHaveBeenCalledTimes(1)
	expect(
		mockModule.loadPublishedBundleArtifactsByIdentities.mock.calls[0]?.[0]
			.identities,
	).toHaveLength(2)
	expect(
		mockModule.loadPublishedBundleArtifactByIdentity,
	).not.toHaveBeenCalled()
	await expect(runHydratedEntry(bundle)).resolves.toEqual([
		'artifact-a',
		'artifact-b',
	])
	mockModule.loadPublishedBundleArtifactsByIdentities.mockReset()
})

test('buildKodyModuleBundle rejects nested dynamic kody package import rewrites clearly', async () => {
	await expect(
		buildLocal(`export default async function run() {
	return await import(String(await import('kody:@kentcdodds/example-package/value')))
}
`),
	).rejects.toThrow('Nested dynamic import expressions involving Kody package')
})

test.each([
	{
		name: 'export secret list',
		call: `kody.secretList({ scope: 'user' })`,
		kody: {
			async secretList(input: unknown) {
				return { ok: true, tool: 'secretList', input }
			},
		},
		expected: { ok: true, tool: 'secretList', input: { scope: 'user' } },
	},
	{
		name: 'export webhook list',
		call: 'kody.webhookList({})',
		kody: {
			async webhookList(input: unknown) {
				return { ok: true, tool: 'webhookList', input }
			},
		},
		expected: { ok: true, tool: 'webhookList', input: {} },
	},
])(
	'buildKodyModuleBundle keeps kody available for a preloaded package $name runtime',
	async ({ call, kody, expected }) => {
		passThroughBundler()
		const entryPoint = 'src/launch-agent.ts'
		const bundle = await buildKodyModuleBundle({
			...graphInput,
			sourceFiles: makePackageFiles(
				'@kentcdodds/email-received-subscriber',
				{
					id: 'email-received-subscriber',
					description: 'Email received subscriber',
					subscriptions: {
						'email.message.received': {
							handler: './src/handle-email-message-received.ts',
						},
					},
				},
				{
					[entryPoint]: `import { kody } from 'kody:runtime'

export default async function launchAgent() {
	return await ${call}
}
`,
				},
				{ './launch-agent': './src/launch-agent.ts' },
			),
			entryPoint,
		})

		expect(bundle.modules).not.toHaveProperty('.__kody_virtual__/runtime.js')
		await withHydratedGraph(bundle, async (moduleGraph) => {
			// Keep both imports on the same Node ESM cache entry to reproduce a
			// preloaded runtime module shared with the bundled entry.
			const runtime = (await moduleGraph.importModule(
				'.__kody_virtual__/runtime.js',
				{ cacheBust: false },
			)) as RuntimeModule
			const result = await runtime.__kodyRunInRuntime({ kody }, async () => {
				const entry = (await moduleGraph.importModule(bundle.mainModule, {
					cacheBust: false,
				})) as { default: (input?: unknown) => Promise<unknown> }
				return await entry.default({})
			})
			expect(result).toEqual(expected)
		})
	},
)

test('buildKodyModuleBundle rejects kody id shorthand imports', async () => {
	mockModule.createWorker.mockResolvedValue(
		createBundleResult('kody-id-import'),
	)
	mockModule.getSavedPackageByName.mockResolvedValue(null)

	const thrown = await buildLocal(
		'import followUp from "kody:@example-package/follow-up-on-pr-agent"\nexport default followUp\n',
	).catch((error: unknown) => error)
	expect(thrown).toBeInstanceOf(SavedPackageNotFoundError)
	expect((thrown as Error).message).toBe(
		'Saved package "@example-package/follow-up-on-pr-agent" was not found in this org. Imports resolve only within the caller\'s org; to use a package from another org, communityFork it into this org and import the copy.',
	)
	expect(mockModule.getSavedPackageByName).toHaveBeenCalledWith(
		{},
		{
			userId: ownerIdFromStored('user-1'),
			name: '@example-package/follow-up-on-pr-agent',
		},
	)
	expect(mockModule.resolveSavedPackageRef).not.toHaveBeenCalled()
})

test('buildKodyAppBundle rewrites static and dynamic kody runtime imports inside TypeScript package apps', async () => {
	for (const { appSource, rewritten, original } of [
		{
			appSource: `import { kody } from 'kody:runtime'

type CapabilityRecord = {
	name: string
}

export default {
	async fetch() {
		const result: Array<CapabilityRecord> =
			await kody.metaListCapabilities({})
		return Response.json({ count: result.length })
	},
}
`,
			rewritten: '../.__kody_virtual__/public-runtime.js',
			original: "'kody:runtime'",
		},
		{
			appSource: `export default {
	async fetch() {
		const runtime = await import('kody:runtime')
		return Response.json({ hasCapabilities: typeof runtime.kody === 'object' })
	},
}
`,
			rewritten: 'import("../.__kody_virtual__/public-runtime.js")',
			original: "import('kody:runtime')",
		},
	]) {
		mockModule.createWorker.mockReset()
		mockModule.createWorker.mockResolvedValue(createBundleResult('ts-app'))
		await buildKodyAppBundle({
			...graphInput,
			sourceFiles: makePackageFiles(
				'@kentcdodds/example-package',
				{
					id: 'example-package',
					description: 'Example package',
					app: { entry: 'app.ts' },
				},
				{ 'app.ts': appSource, 'index.ts': 'export const value = "ok"' },
				{ '.': './index.ts' },
			),
			entryPoint: 'app.ts',
			cacheKey: null,
		})

		expect(mockModule.createWorker).toHaveBeenCalledTimes(1)
		const [[bundlerInput]] = mockModule.createWorker.mock.calls as unknown as [
			[{ files: Record<string, string> }],
		]
		const appFile = bundlerInput.files['.__kody_root__/app.ts']
		expect(appFile).toContain(rewritten)
		expect(appFile).not.toContain(original)
	}
})
