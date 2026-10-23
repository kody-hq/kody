import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as PublishedBundleArtifactsModule from './published-bundle-artifacts.ts'
import {
	moduleGraphMockModule as mockModule,
	createBundleResult,
	createBundleInput,
	createModuleBundleInput,
	createTemporaryModuleGraph,
	createSavedPackageRecord,
	createLoadedPackageSource,
	type RuntimeModule,
} from '#worker/test-support/module-graph.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'

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

const {
	buildKodyAppBundle,
	buildKodyModuleBundle,
	buildPackageRuntimeModulePath,
	createPackageRuntimeModuleSource,
	createPublishedPackageAppBundleCacheKey,
	createRuntimeModuleReexportSource,
	createRuntimeModuleSource,
	hydrateKodyRuntimeModules,
	parsePackageRuntimeModulePathPackageId,
	refreshKodyRuntimeModules,
} = await import('./module-graph.ts')

const graphInput = {
	env: { APP_DB: {}, REPO_SESSION: {} } as Env,
	baseUrl: 'https://heykody.dev',
	userId: ownerIdFromStored('user-1'),
}

const staleRuntimeSource = `const runtime = {}
export const kody = runtime.kody
export default runtime`

type BundlerCall = { files: Record<string, string> } & Record<string, unknown>

function lastBundlerCall() {
	return mockModule.createWorker.mock.calls[0]?.[0] as BundlerCall
}

function makeArtifact(
	overrides: Partial<{
		artifactName: string
		sourceId: string
		publishedCommit: string
		entryPoint: string
		mainModule: string
		modules: Record<string, string>
		packageContext: Record<string, string> | null
	}>,
) {
	return {
		version: 1,
		kind: 'importable-module' as const,
		artifactName: '.',
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		entryPoint: './index.js',
		mainModule: 'index.js',
		modules: {},
		dependencies: [],
		dynamicDependencies: [],
		packageContext: null,
		createdAt: '2026-05-11T00:00:00.000Z',
		...overrides,
	}
}

function appCacheKey(sourceId: string, entryPoint = 'app.js') {
	return createPublishedPackageAppBundleCacheKey({
		userId: ownerIdFromStored('user-1'),
		source: {
			id: sourceId,
			published_commit: `commit-${sourceId}`,
			manifest_path: 'package.json',
			source_root: '/',
		},
		entryPoint,
	})
}

async function withRuntimeGraph(
	modules: WorkerLoaderModules,
	fn: (
		runEntry: (
			entryPath: string,
			runtime: Record<string, unknown>,
		) => Promise<unknown>,
	) => Promise<void>,
) {
	const moduleGraph = await createTemporaryModuleGraph(modules)
	try {
		const runtimeModule = (await moduleGraph.importModule(
			'.__kody_virtual__/runtime.js',
			{ cacheBust: false },
		)) as RuntimeModule
		await fn(
			async (entryPath, runtime) =>
				await runtimeModule.__kodyRunInRuntime(runtime, async () => {
					const entry = (await moduleGraph.importModule(entryPath, {
						cacheBust: false,
					})) as { default: () => Promise<unknown> }
					return await entry.default()
				}),
		)
	} finally {
		await moduleGraph.cleanup()
	}
}

async function runWithRuntimeEntry(
	modules: WorkerLoaderModules,
	runtime: Record<string, unknown>,
) {
	const moduleGraph = await createTemporaryModuleGraph(modules)
	try {
		const entry = (await moduleGraph.importModule('entry.js')) as {
			runWithRuntime: (runtime: Record<string, unknown>) => Promise<unknown>
		}
		return await entry.runWithRuntime(runtime)
	} finally {
		await moduleGraph.cleanup()
	}
}

test('hydrateKodyRuntimeModules resolves duplicate dynamic specifiers once per pass', async () => {
	const specifier = 'kody:@kentcdodds/example-package/value'
	const placeholder = `export const __kodyDynamicPackageSpecifier = ${JSON.stringify(specifier)};
throw new Error('unhydrated ${specifier}');
`
	const valueSource = 'export default function value() { return "resolved" }'
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		...createLoadedPackageSource(),
		manifest: {
			...createLoadedPackageSource().manifest,
			exports: { './value': './value.js' },
		},
		files: { 'value.js': valueSource },
	})
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue({
		row: {},
		artifact: makeArtifact({
			artifactName: './value',
			entryPoint: './value.js',
			mainModule: 'value.js',
			modules: { 'value.js': valueSource },
		}),
	})

	const dynamicEntry = (name: string) => `export default async function run() {
	const module = await import('./.__kody_virtual__/dynamic-imports/${name}.js')
	return module.default
}
`
	const { modules: hydratedModules } = await hydrateKodyRuntimeModules({
		...graphInput,
		modules: {
			'entry-a.js': dynamicEntry('a'),
			'entry-b.js': dynamicEntry('b'),
			'.__kody_virtual__/dynamic-imports/a.js': placeholder,
			'.__kody_virtual__/dynamic-imports/b.js': placeholder,
		},
	})

	expect(
		mockModule.loadPublishedBundleArtifactByIdentity,
	).toHaveBeenCalledTimes(1)
	for (const name of ['a', 'b']) {
		expect(
			hydratedModules[`.__kody_virtual__/dynamic-imports/${name}.js`],
		).toContain('__kodyDynamicPackageResolved')
	}
})

test('buildKodyModuleBundle keeps deterministic dependency ordering after parallel resolution', async () => {
	mockModule.createWorker.mockResolvedValue(createBundleResult('ordered-deps'))
	const shortNames: Record<string, string> = {
		'@kentcdodds/zebra-package': 'zebra',
		'@kentcdodds/alpha-package': 'alpha',
	}
	mockModule.getSavedPackageByName.mockImplementation(
		async (_db: unknown, { name }: { name: string }) => {
			const short = shortNames[name]
			return short
				? createSavedPackageRecord({
						name,
						kodyId: `${short}-package`,
						sourceId: `source-${short}`,
					})
				: null
		},
	)
	mockModule.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			const kodyId = `${input.sourceId.replace('source-', '')}-package`
			return {
				...createLoadedPackageSource(),
				source: {
					id: input.sourceId,
					published_commit: `commit-${input.sourceId}`,
				},
				manifest: {
					name: `@kentcdodds/${kodyId}`,
					exports: { '.': './index.js' },
					kody: { id: kodyId, description: 'Dependency package' },
				},
				files: {
					'index.js': 'export default async function run() { return "ok" }',
				},
			}
		},
	)

	const result = await buildKodyModuleBundle({
		...graphInput,
		sourceFiles: {
			'package.json': JSON.stringify({
				name: '@kentcdodds/local-package',
				exports: { '.': './index.js' },
				kody: { id: 'local-package', description: 'Local package' },
			}),
			'index.js': `import zebra from "kody:@kentcdodds/zebra-package"
import alpha from "kody:@kentcdodds/alpha-package"
export default [zebra, alpha]`,
		},
		entryPoint: 'index.js',
	})

	expect(result.dependencies).toEqual(
		['alpha', 'zebra'].map((name) => ({
			sourceId: `source-${name}`,
			publishedCommit: `commit-source-${name}`,
			kodyId: `${name}-package`,
			packageName: `@kentcdodds/${name}-package`,
			packageId: 'pkg-1',
		})),
	)
})

test('kody:runtime exports resolve against the current run when the module instance is reused across sequential runs', async () => {
	// Dynamic workers with identical code are cached and reused, so the
	// runtime module evaluates once and then serves every later run from the
	// isolate's ES module cache. Each run's `kody` closes over that run's RPC
	// dispatcher stubs, which are disposed when the run's evaluate() call
	// returns — a frozen `export const kody = runtime.kody` therefore made
	// every later run fail with "RPC stub used after being disposed".
	const modules = {
		'.__kody_virtual__/runtime.js': createRuntimeModuleSource(),
		'entry.js': `import { kody, email } from './.__kody_virtual__/runtime.js'
const capturedSearch = kody.communitySearch
export default async function main() {
	return {
		viaProxy: await kody.communitySearch({ query: 'slack' }),
		viaTopLevelCapture: await capturedSearch({ query: 'slack' }),
		email,
	}
}`,
	}
	await withRuntimeGraph(modules, async (runEntry) => {
		const createRunRuntime = (label: string, state: { disposed: boolean }) => ({
			kody: {
				communitySearch: async (args: unknown) => {
					if (state.disposed) {
						throw new Error('RPC stub used after being disposed.')
					}
					return { label, args }
				},
			},
			email: null,
		})
		const expected = (label: string) => ({
			viaProxy: { label, args: { query: 'slack' } },
			viaTopLevelCapture: { label, args: { query: 'slack' } },
			email: null,
		})

		const firstState = { disposed: false }
		expect(
			await runEntry('entry.js', createRunRuntime('first-run', firstState)),
		).toEqual(expected('first-run'))

		// The first run's dispatcher stubs die once its evaluate() returns.
		firstState.disposed = true

		expect(
			await runEntry(
				'entry.js',
				createRunRuntime('second-run', { disposed: false }),
			),
		).toEqual(expected('second-run'))
	})
})

test('buildKodyAppBundle does not inject remix and fails when the bundle still imports it', async () => {
	mockModule.createWorker.mockReset()
	mockModule.createWorker.mockResolvedValue({
		mainModule: 'dist/remix.js',
		modules: {
			'dist/remix.js': `import { createRouter } from 'remix/router'\nexport default createRouter()`,
		},
		dependencies: [],
	})
	const input = createBundleInput({ entryPoint: 'app/router.ts' })
	Object.assign(input.sourceFiles, {
		'app/router.ts': `import { createRouter } from 'remix/router'\nexport default createRouter()`,
	})
	await expect(buildKodyAppBundle(input)).rejects.toThrow(
		/unresolved bare package imports after bundling.*remix\/router/s,
	)
	expect(
		lastBundlerCall().files['node_modules/remix/package.json'],
	).toBeUndefined()
})

test('buildKodyAppBundle keeps package-supplied remix without injecting platform files', async () => {
	mockModule.createWorker.mockReset()
	mockModule.createWorker.mockResolvedValue({
		mainModule: 'dist/app.js',
		modules: {
			'dist/app.js': 'export default { fetch() { return new Response("ok") } }',
		},
		dependencies: [],
	})
	const input = createBundleInput({ entryPoint: 'app/router.ts' })
	Object.assign(input.sourceFiles, {
		'app/router.ts': `import { createRouter } from 'remix/router'\nexport default { fetch() { return new Response("ok") } }`,
		'node_modules/remix/package.json': JSON.stringify({
			name: 'remix',
			type: 'module',
			exports: { './router': './dist/router.js' },
		}),
		'node_modules/remix/dist/router.js':
			'export function createRouter() { return {} }',
	})
	await buildKodyAppBundle(input)
	const remixPaths = Object.keys(lastBundlerCall().files)
		.filter((filePath) => filePath.startsWith('node_modules/remix/'))
		.sort((left, right) => left.localeCompare(right))
	expect(remixPaths).toEqual([
		'node_modules/remix/dist/router.js',
		'node_modules/remix/package.json',
	])
})

test('buildKodyAppBundle cache lifecycle reuses hits, shares in-flight builds, evicts failures, and keys by entrypoint', async () => {
	mockModule.createWorker.mockResolvedValue(createBundleResult('warm-cache'))
	const cacheKey = appCacheKey('source-1')
	const first = await buildKodyAppBundle(createBundleInput({ cacheKey }))
	const second = await buildKodyAppBundle(createBundleInput({ cacheKey }))
	expect(mockModule.createWorker).toHaveBeenCalledTimes(1)
	expect(first).toBe(second)

	mockModule.createWorker.mockReset()
	mockModule.createWorker
		.mockResolvedValueOnce(createBundleResult('uncached-first'))
		.mockResolvedValueOnce(createBundleResult('uncached-second'))
	await buildKodyAppBundle(createBundleInput({ cacheKey: null }))
	await buildKodyAppBundle(createBundleInput({ cacheKey: null }))
	expect(mockModule.createWorker).toHaveBeenCalledTimes(2)

	mockModule.createWorker.mockReset()
	const { promise: bundlePromise, resolve: resolveBundle } =
		Promise.withResolvers<ReturnType<typeof createBundleResult>>()
	mockModule.createWorker.mockImplementation(async () => await bundlePromise)
	const concurrentInput = createBundleInput({
		cacheKey: appCacheKey('source-concurrent'),
	})
	const firstPromise = buildKodyAppBundle(concurrentInput)
	const secondPromise = buildKodyAppBundle(concurrentInput)
	resolveBundle(createBundleResult('shared-in-flight'))
	const [inFlightFirst, inFlightSecond] = await Promise.all([
		firstPromise,
		secondPromise,
	])
	expect(mockModule.createWorker).toHaveBeenCalledTimes(1)
	expect(inFlightFirst).toBe(inFlightSecond)

	mockModule.createWorker.mockReset()
	mockModule.createWorker
		.mockRejectedValueOnce(new Error('bundle failed'))
		.mockResolvedValueOnce(createBundleResult('retry-success'))
	const failureInput = createBundleInput({
		cacheKey: appCacheKey('source-failure'),
	})
	await expect(buildKodyAppBundle(failureInput)).rejects.toThrow(
		'bundle failed',
	)
	expect(await buildKodyAppBundle(failureInput)).toEqual(
		createBundleResult('retry-success'),
	)
	expect(mockModule.createWorker).toHaveBeenCalledTimes(2)

	mockModule.createWorker.mockReset()
	mockModule.createWorker
		.mockResolvedValueOnce(createBundleResult('entry-app'))
		.mockResolvedValueOnce(createBundleResult('entry-admin'))
	const [appBundle, adminBundle] = [
		await buildKodyAppBundle(
			createBundleInput({
				cacheKey: appCacheKey('source-shared', 'app.js'),
				entryPoint: 'app.js',
			}),
		),
		await buildKodyAppBundle(
			createBundleInput({
				cacheKey: appCacheKey('source-shared', 'admin.js'),
				entryPoint: 'admin.js',
			}),
		),
	]
	expect(mockModule.createWorker).toHaveBeenCalledTimes(2)
	expect(appBundle).not.toBe(adminBundle)
})

test('buildKodyModuleBundle cache lifecycle reuses hits, skips when disabled, keys by code and userId, and evicts failures', async () => {
	mockModule.createWorker.mockResolvedValue(createBundleResult('module-warm'))
	const cached = (input: Parameters<typeof createModuleBundleInput>[0] = {}) =>
		buildKodyModuleBundle(
			createModuleBundleInput({ reuseCachedBundle: true, ...input }),
		)
	const first = await cached()
	const second = await cached()
	expect(mockModule.createWorker).toHaveBeenCalledTimes(1)
	expect(first).toEqual(second)
	expect(first.modules).not.toBe(second.modules)
	expect(first.dependencies).not.toBe(second.dependencies)

	const code = (value: string) =>
		`export default async function run() { return "${value}" }`
	for (const [label, firstInput, secondInput] of [
		[
			'uncached',
			{ reuseCachedBundle: undefined },
			{ reuseCachedBundle: false },
		],
		['code', { code: code('a') }, { code: code('b') }],
		[
			'user',
			{ userId: ownerIdFromStored('user-cache-a'), code: code('shared') },
			{ userId: ownerIdFromStored('user-cache-b'), code: code('shared') },
		],
	] as const) {
		mockModule.createWorker.mockReset()
		mockModule.createWorker
			.mockResolvedValueOnce(createBundleResult(`module-${label}-first`))
			.mockResolvedValueOnce(createBundleResult(`module-${label}-second`))
		await cached(firstInput)
		await cached(secondInput)
		expect(mockModule.createWorker).toHaveBeenCalledTimes(2)
	}

	mockModule.createWorker.mockReset()
	mockModule.createWorker
		.mockRejectedValueOnce(new Error('module bundle failed'))
		.mockResolvedValueOnce(createBundleResult('module-retry-success'))
	await expect(cached({ code: code('retry') })).rejects.toThrow(
		'module bundle failed',
	)
	expect(await cached({ code: code('retry') })).toEqual(
		createBundleResult('module-retry-success'),
	)
	expect(mockModule.createWorker).toHaveBeenCalledTimes(2)
})

test('hydrateKodyRuntimeModules replaces stale persisted kody runtime modules', async () => {
	const stalePersistedRuntime =
		'export const kody = { stale: true }; export default { kody };'
	const { modules: hydratedModules } = await hydrateKodyRuntimeModules({
		...graphInput,
		modules: {
			'.__kody_virtual__/runtime.js': stalePersistedRuntime,
			'entry.js': `import { __kodyRunInRuntime, kody } from './.__kody_virtual__/runtime.js'

export async function runWithRuntime(runtime) {
	return await __kodyRunInRuntime(runtime, async () => kody.hostRuntimeVersion({}))
}
`,
		},
	})

	expect(hydratedModules['.__kody_virtual__/runtime.js']).not.toBe(
		stalePersistedRuntime,
	)
	await expect(
		runWithRuntimeEntry(hydratedModules, {
			kody: {
				async hostRuntimeVersion() {
					return 'current-host-runtime'
				},
			},
		}),
	).resolves.toBe('current-host-runtime')
})

test('hydrateKodyRuntimeModules fixes stale nested runtime modules from static package artifacts', async () => {
	const bundlePrefix =
		'.__kody_packages__/@kentcdodds/ai-chat/.__published_bundle__/2e'
	const nestedRuntimePath = `${bundlePrefix}/.__kody_virtual__/runtime.js`
	const modules = {
		'.__kody_virtual__/runtime.js': createRuntimeModuleSource(),
		'entry.js': `import { __kodyRunInRuntime } from './.__kody_virtual__/runtime.js'
import runDependency from './${bundlePrefix}/index.js'

export async function runWithRuntime(runtime) {
	return await __kodyRunInRuntime(runtime, async () => runDependency())
}`,
		[`${bundlePrefix}/index.js`]: `import { kody } from './.__kody_virtual__/runtime.js'

export default async function runDependency() {
	return await kody.secretList({ scope: "user" })
}`,
		[nestedRuntimePath]: staleRuntimeSource,
	}
	await expect(
		runWithRuntimeEntry(modules, {
			kody: {
				async secretList() {
					return { ok: true }
				},
			},
		}),
	).rejects.toThrow(
		"Cannot read properties of undefined (reading 'secretList')",
	)

	const { modules: hydratedModules } = await hydrateKodyRuntimeModules({
		...graphInput,
		modules,
	})
	expect(hydratedModules[nestedRuntimePath]).toBe(
		createRuntimeModuleReexportSource(nestedRuntimePath),
	)
	await expect(
		runWithRuntimeEntry(hydratedModules, {
			kody: {
				async secretList(args: unknown) {
					return { ok: true, args }
				},
			},
		}),
	).resolves.toEqual({ ok: true, args: { scope: 'user' } })
})

test('buildKodyModuleBundle refreshes nested artifact runtimes before static import rebundling', async () => {
	mockModule.createWorker.mockResolvedValue(
		createBundleResult('ai-chat-caller'),
	)
	mockModule.getSavedPackageByName.mockResolvedValue(
		createSavedPackageRecord({
			name: '@kentcdodds/ai-chat',
			kodyId: 'ai-chat',
			sourceId: 'source-ai-chat',
		}),
	)
	const manifest = {
		name: '@kentcdodds/ai-chat',
		exports: { '.': './src/index.ts' },
		kody: { id: 'ai-chat', description: 'AI chat helpers' },
	}
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: { id: 'source-ai-chat', published_commit: 'commit-ai-chat' },
		manifest,
		files: {
			'package.json': JSON.stringify(manifest),
			'src/index.ts':
				'import { kody } from "kody:runtime"\nexport async function runAgentTurnNonStreaming() { return await kody.valueGet({ name: "ai-chat" }) }',
		},
	})
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue({
		row: {},
		artifact: makeArtifact({
			sourceId: 'source-ai-chat',
			publishedCommit: 'commit-ai-chat',
			entryPoint: './src/index.ts',
			mainModule: 'dist/index.js',
			modules: {
				'dist/index.js': `import { kody } from './.__kody_virtual__/runtime.js'
export async function runAgentTurnNonStreaming() {
	return await kody.valueGet({ name: "ai-chat" })
}`,
				'dist/.__kody_virtual__/runtime.js': staleRuntimeSource,
			},
			packageContext: {
				packageId: 'pkg-ai-chat',
				kodyId: 'ai-chat',
				sourceId: 'source-ai-chat',
			},
		}),
	})

	await buildKodyModuleBundle({
		...graphInput,
		sourceFiles: {
			'entry.ts': `import { runAgentTurnNonStreaming } from 'kody:@kentcdodds/ai-chat'
export default async function main() {
	return await runAgentTurnNonStreaming()
}`,
		},
		entryPoint: 'entry.ts',
	})

	const { files } = lastBundlerCall()
	const nestedRuntimePath =
		'.__kody_packages__/@kentcdodds/ai-chat/.__published_bundle__/2e/dist/.__kody_virtual__/runtime.js'
	expect(files[nestedRuntimePath]).toBe(
		createRuntimeModuleReexportSource(nestedRuntimePath),
	)
	expect(files['.__kody_virtual__/runtime.js']).toContain(
		'__kodyCreateRuntimeObjectProxy',
	)
})

test('package runtime module paths round-trip stamped package ids', () => {
	const packageId = crypto.randomUUID()
	const modulePath = buildPackageRuntimeModulePath(packageId)
	expect(modulePath).toMatch(
		/^\.__kody_virtual__\/package-runtime\/[0-9a-f]+\.js$/,
	)
	expect(parsePackageRuntimeModulePathPackageId(modulePath)).toBe(packageId)
	// Artifact installs nest the stamped module under graph prefixes; the id
	// must still parse out.
	expect(
		parsePackageRuntimeModulePathPackageId(
			`.__kody_packages__/@kentcdodds/example-package/.__published_bundle__/2e/${modulePath}`,
		),
	).toBe(packageId)
	for (const path of [
		'.__kody_virtual__/runtime.js',
		'src/index.js',
		'.__kody_virtual__/package-runtime/not-hex.js',
	]) {
		expect(parsePackageRuntimeModulePathPackageId(path)).toBeNull()
	}

	const moduleSource = createPackageRuntimeModuleSource(packageId)
	for (const fragment of [
		JSON.stringify(packageId),
		'__kodyCreatePackageBoundStorage',
		'__kodyCreatePackageBoundSecrets',
		'../runtime.js',
	]) {
		expect(moduleSource).toContain(fragment)
	}
})

test('buildKodyModuleBundle stamps root modules with a per-package runtime module when rootPackageId is provided', async () => {
	const rootPackageId = crypto.randomUUID()
	const stampedModulePath = buildPackageRuntimeModulePath(rootPackageId)
	const code = `import { packageStorage } from 'kody:runtime'
export default async function run() {
	return packageStorage().id
}`
	mockModule.createWorker.mockResolvedValue(createBundleResult('stamped-root'))
	await buildKodyModuleBundle({
		...createModuleBundleInput({ code }),
		rootPackageId,
	})
	const stamped = lastBundlerCall().files
	expect(stamped['.__kody_root__/entry.ts']).toContain(
		`../${stampedModulePath}`,
	)
	expect(stamped['.__kody_root__/entry.ts']).not.toContain("'kody:runtime'")
	expect(stamped[stampedModulePath]).toBe(
		createPackageRuntimeModuleSource(rootPackageId),
	)

	// Without root provenance the same source uses the public runtime facade
	// (whose packageStorage falls back to the run's own package context).
	mockModule.createWorker.mockReset()
	mockModule.createWorker.mockResolvedValue(
		createBundleResult('unstamped-root'),
	)
	await buildKodyModuleBundle(createModuleBundleInput({ code }))
	const unstampedEntry = lastBundlerCall().files['.__kody_root__/entry.ts']
	expect(unstampedEntry).toContain('../.__kody_virtual__/public-runtime.js')
	expect(unstampedEntry).not.toContain('package-runtime/')
})

test('statically imported saved package sources get stamped with their own package id', async () => {
	mockModule.createWorker.mockResolvedValue(
		createBundleResult('stamped-dependency'),
	)
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.resolveSavedPackageRef.mockResolvedValue(null)
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(null)
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		...createLoadedPackageSource(),
		files: {
			'index.js': 'export const value = "ok"',
			'follow-up-on-pr-agent.js': `import { packageStorage } from 'kody:runtime'
export default async function followUp() {
	return packageStorage().id
}`,
		},
	})

	await buildKodyModuleBundle(
		createModuleBundleInput({
			code: `import followUp from 'kody:@kentcdodds/example-package/follow-up-on-pr-agent'
import { packageStorage } from 'kody:runtime'
export default async function run() {
	return { dependency: await followUp(), root: packageStorage().id }
}`,
		}),
	)

	const { files } = lastBundlerCall()
	// The dependency module (saved package id pkg-1) is stamped…
	const stampedModulePath = buildPackageRuntimeModulePath('pkg-1')
	expect(
		files[
			'.__kody_packages__/@kentcdodds/example-package/follow-up-on-pr-agent.js'
		],
	).toContain(`../../../${stampedModulePath}`)
	expect(files[stampedModulePath]).toBe(
		createPackageRuntimeModuleSource('pkg-1'),
	)
	// …while the unprovenanced root entry uses the public runtime facade.
	expect(files['.__kody_root__/entry.ts']).toContain(
		'../.__kody_virtual__/public-runtime.js',
	)
	expect(files['.__kody_root__/entry.ts']).not.toContain('package-runtime/')
})

test('refreshKodyRuntimeModules evaluates the full runtime once for artifact-only graphs', () => {
	const prefix =
		'.__kody_packages__/@kentcdodds/example/.__published_bundle__/ab'
	const primary = `${prefix}/.__kody_virtual__/runtime.js`
	const nested = `${prefix}/nested/.__kody_virtual__/runtime.js`
	const refreshed = refreshKodyRuntimeModules(
		{
			[`${prefix}/entry.js`]: `import "./.__kody_virtual__/runtime.js";
import "./nested/.__kody_virtual__/runtime.js";
export default async function run() { return null }`,
			[primary]: 'stale-primary',
			[nested]: 'stale-nested',
		},
		{ includeDefaultRuntimePath: false },
	)
	expect(refreshed[primary]).toContain('__kodyCreateRuntimeObjectProxy')
	expect(refreshed[nested]).toContain('export * from')
	expect(refreshed[nested]).not.toContain('__kodyCreateRuntimeObjectProxy')
	expect(refreshed['.__kody_virtual__/runtime.js']).toBeUndefined()
})

test('refreshKodyRuntimeModules regenerates stale per-package runtime modules and their sibling shared runtime', () => {
	const packageId = crypto.randomUUID()
	const nestedPrefix =
		'.__kody_packages__/@kentcdodds/example-package/.__published_bundle__/2e'
	const stampedModulePath = `${nestedPrefix}/${buildPackageRuntimeModulePath(packageId)}`
	const refreshed = refreshKodyRuntimeModules({
		'entry.js': `import { packageStorage } from './${stampedModulePath}'
export default async function run() {
	return packageStorage().id
}`,
		[stampedModulePath]: 'export const packageStorage = () => "stale"',
	})
	expect(refreshed[stampedModulePath]).toBe(
		createPackageRuntimeModuleSource(packageId),
	)
	// The regenerated stamped module imports its sibling shared runtime; the
	// refresh must materialize that sibling even when nothing referenced it.
	// Prefixed copies re-export the graph-root runtime so the stamp ALS is
	// created once and is not published on globalThis.
	expect(refreshed['.__kody_virtual__/runtime.js']).toBe(
		createRuntimeModuleSource(),
	)
	expect(refreshed[`${nestedPrefix}/.__kody_virtual__/runtime.js`]).toBe(
		createRuntimeModuleReexportSource(
			`${nestedPrefix}/.__kody_virtual__/runtime.js`,
		),
	)
})

test('packageStorage resolves the stamped package id, falls back to the run package context, and rejects unprovenanced calls', async () => {
	const packageId = crypto.randomUUID()
	const stampedModulePath = buildPackageRuntimeModulePath(packageId)
	const modules = {
		'.__kody_virtual__/runtime.js': createRuntimeModuleSource(),
		[stampedModulePath]: createPackageRuntimeModuleSource(packageId),
		'stamped-entry.js': `import runtimeDefault, { packageStorage } from './${stampedModulePath}'
export default async function main() {
	return {
		named: packageStorage().id,
		viaDefault: runtimeDefault.packageStorage().id,
	}
}`,
		'unstamped-entry.js': `import { packageStorage } from './.__kody_virtual__/runtime.js'
export default async function main() {
	return packageStorage().id
}`,
	}
	await withRuntimeGraph(modules, async (runEntry) => {
		const boundRuntime = {
			__kodyPackageStorage: (boundPackageId: string) => ({
				id: `package:${boundPackageId}`,
			}),
			packageContext: { packageId: 'pkg-context', kodyId: 'context' },
		}

		// Stamped modules use their bundle-time identity even when the run
		// belongs to a different package.
		await expect(runEntry('stamped-entry.js', boundRuntime)).resolves.toEqual({
			named: `package:${packageId}`,
			viaDefault: `package:${packageId}`,
		})
		// Unstamped modules fall back to the run's own package context.
		await expect(runEntry('unstamped-entry.js', boundRuntime)).resolves.toBe(
			'package:pkg-context',
		)
		// No provenance at all: a clear, actionable error.
		await expect(
			runEntry('unstamped-entry.js', {
				__kodyPackageStorage: boundRuntime.__kodyPackageStorage,
			}),
		).rejects.toThrow('packageStorage() requires package provenance')
		// Contexts that never bind the factory (no authenticated user) fail
		// with the availability message instead of a bare TypeError.
		await expect(
			runEntry('stamped-entry.js', { packageContext: null }),
		).rejects.toThrow('packageStorage() is not available')
	})
})
