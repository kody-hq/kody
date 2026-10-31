import { AsyncLocalStorage } from 'node:async_hooks'
import { dirname } from 'node:path'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { build, type Plugin } from 'esbuild'
import { expect, test, vi } from 'vitest'
import type * as PublishedBundleArtifactsModule from './published-bundle-artifacts.ts'
import {
	moduleGraphMockModule as mockModule,
	createSavedPackageRecord,
	createTemporaryModuleGraph,
} from '#worker/test-support/module-graph.ts'
import { verifyLocalExecutePackageBinding } from './local-execute-package-binding.ts'
import { buildLocalExecutePackageGraph } from './local-execute-package-graph.ts'
import { buildKodyImportableModuleBundle } from './module-graph-bundle-builders.ts'
import { prepareKodyGraphFiles } from './module-graph-import-rewriting.ts'
import {
	joinPath,
	normalizeWorkspaceModulePath,
	resolveRelativeModulePath,
	rootSourcePrefix,
} from './module-graph-paths.ts'
import {
	createImportableEntrypointSource,
	refreshKodyRuntimeModules,
} from './runtime-source-modules.ts'

vi.mock('#worker/worker-bundler-modules.ts', () => ({
	importWorkerBundler: async () => ({ createWorker: bundleVirtualFiles }),
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

const env = {
	APP_DB: {},
	REPO_SESSION: {},
	SECRET_STORE_KEY: 'test-secret-store-key',
} as unknown as Env
const baseUrl = 'https://heykody.dev'
const userId = ownerIdFromStored('user-1')

type FixturePackage = {
	id: string
	name: string
	kodyId: string
	sourceId: string
	exportName: string
	entryPoint: string
	files: Record<string, string>
}

const forecastPackage: FixturePackage = {
	id: '6f0c9d8e-0000-4000-8000-00000000f0ca',
	name: '@acme/forecast',
	kodyId: 'forecast',
	sourceId: 'source-forecast',
	exportName: './history',
	entryPoint: 'src/history.ts',
	files: {
		'src/history.ts': `import { packageSecrets, packageStorage } from 'kody:runtime'
export async function recordForecast(value) {
	await packageStorage().set('forecast', value)
}
export async function getForecast() {
	return await packageStorage().get('forecast')
}
export async function forecastHasWakeToken() {
	return await packageSecrets.has('wakeToken')
}
export default getForecast
`,
	},
}

const shadesPackage: FixturePackage = {
	id: '6f0c9d8e-0000-4000-8000-0000000005ad',
	name: '@acme/shades',
	kodyId: 'shades',
	sourceId: 'source-shades',
	exportName: './plan-day',
	entryPoint: 'src/plan-day.ts',
	files: {
		'src/plan-day.ts': `import {
	forecastHasWakeToken,
	getForecast,
	recordForecast,
} from 'kody:@acme/forecast/history'
import { packageSecrets, packageStorage } from 'kody:runtime'
export default async function planDay(params) {
	await recordForecast(params.forecast)
	await packageStorage().set('config', { synced: true })
	return {
		forecast: await getForecast(),
		config: await packageStorage().get('config'),
		forecastHasWakeToken: await forecastHasWakeToken(),
		shadesHasWakeToken: await packageSecrets.has('wakeToken'),
	}
}
`,
	},
}

const rosterPackage: FixturePackage = {
	id: '6f0c9d8e-0000-4000-8000-0000000a0151',
	name: '@acme/roster',
	kodyId: 'roster',
	sourceId: 'source-roster',
	exportName: './count',
	entryPoint: 'src/count.ts',
	files: {
		'src/count.ts': `import { kody } from 'kody:runtime'
export default async function count() {
	const page = await kody.adminUserList({ page: 1, pageSize: 100 })
	const cached = await kody.packageStorageGet({ key: 'count' })
	return { total: page.total, cached: cached.value }
}
export async function hostCommand(params) {
	return await kody.command[params.method](params.input)
}
`,
	},
}

function packageJsonFor(pkg: FixturePackage) {
	return {
		name: pkg.name,
		exports: { [pkg.exportName]: `./${pkg.entryPoint}` },
		kody: { id: pkg.kodyId, description: `${pkg.name} fixture` },
	}
}

function sourceFilesFor(pkg: FixturePackage) {
	return {
		'package.json': JSON.stringify(packageJsonFor(pkg)),
		...pkg.files,
	}
}

function virtualFilesPlugin(files: Record<string, string>): Plugin {
	return {
		name: 'virtual-files',
		setup(pluginBuild) {
			pluginBuild.onResolve({ filter: /.*/ }, (args) => {
				if (args.path.startsWith('node:')) {
					return { path: args.path, external: true }
				}
				const path =
					args.kind === 'entry-point'
						? normalizeWorkspaceModulePath(args.path)
						: (resolveRelativeModulePath(args.importer, args.path) ??
							normalizeWorkspaceModulePath(args.path))
				return { path, namespace: 'virtual' }
			})
			pluginBuild.onLoad({ filter: /.*/, namespace: 'virtual' }, (args) => {
				const contents = files[args.path]
				if (contents === undefined) {
					throw new Error(`Missing virtual fixture module ${args.path}`)
				}
				return {
					contents,
					loader: args.path.endsWith('.ts') ? 'ts' : 'js',
					resolveDir: dirname(args.path),
				}
			})
		},
	}
}

/**
 * Node stand-in for `@cloudflare/worker-bundler` `createWorker` (workerd
 * only): esbuild over the same in-memory files, honoring the esbuild plugins
 * the graph builder passes (the shared-runtime externals plugin).
 */
async function bundleVirtualFiles(input: {
	files: Record<string, string>
	entryPoint: string
	__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired?: Array<Plugin>
}) {
	const result = await build({
		entryPoints: [input.entryPoint],
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		write: false,
		absWorkingDir: '/',
		outfile: 'bundle.js',
		plugins: [
			...(input.__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired ?? []),
			virtualFilesPlugin(input.files),
		],
	})
	const output = result.outputFiles[0]?.text
	if (!output) throw new Error('Fixture bundle produced no output.')
	return { mainModule: 'bundle.js', modules: { 'bundle.js': output } }
}

/**
 * Importable-module artifacts published before the shared runtime was
 * externalized inline a full cloud `kody:runtime` copy. Consumers published
 * later still compose that artifact verbatim, so its runtime copy survives
 * into their bundles without a `// virtual:` banner of its own.
 */
async function buildLegacyInlinedRuntimeArtifact(pkg: FixturePackage) {
	const prepared = await prepareKodyGraphFiles({
		env,
		baseUrl,
		userId,
		sourceFiles: sourceFilesFor(pkg),
		entryPoint: pkg.entryPoint,
		rootPackageId: pkg.id,
	})
	const entryPath = joinPath(rootSourcePrefix, '.__kody_import_entry__.js')
	const files = refreshKodyRuntimeModules({
		...prepared.files,
		[entryPath]: createImportableEntrypointSource({
			modulePath: `./${prepared.entryPoint}`,
		}),
	}) as Record<string, string>
	return await bundleVirtualFiles({ files, entryPoint: entryPath })
}

function artifactHit(
	pkg: FixturePackage,
	bundle: {
		mainModule: string
		modules: Record<string, unknown>
		dependencies?: Array<unknown>
	},
) {
	return {
		row: { id: `artifact-${pkg.kodyId}` },
		artifact: {
			version: 1,
			kind: 'importable-module' as const,
			sourceId: pkg.sourceId,
			publishedCommit: 'commit-1',
			artifactName: pkg.exportName,
			entryPoint: pkg.entryPoint,
			mainModule: bundle.mainModule,
			modules: bundle.modules,
			dependencies: bundle.dependencies ?? [],
			packageContext: {
				packageId: pkg.id,
				kodyId: pkg.kodyId,
				sourceId: pkg.sourceId,
			},
			createdAt: '2026-10-01T00:00:00.000Z',
		},
	}
}

function installRegistry(
	artifacts: Map<string, ReturnType<typeof artifactHit>>,
) {
	const packages = [forecastPackage, shadesPackage, rosterPackage]
	mockModule.getSavedPackageByName.mockImplementation(
		async (_db: unknown, input: { name: string }) => {
			const pkg = packages.find((candidate) => candidate.name === input.name)
			if (!pkg) return null
			return {
				...createSavedPackageRecord({
					name: pkg.name,
					kodyId: pkg.kodyId,
					sourceId: pkg.sourceId,
				}),
				id: pkg.id,
			}
		},
	)
	mockModule.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			const pkg = packages.find(
				(candidate) => candidate.sourceId === input.sourceId,
			)
			if (!pkg) throw new Error(`Unknown source ${input.sourceId}`)
			return {
				source: { id: pkg.sourceId, published_commit: 'commit-1' },
				manifest: packageJsonFor(pkg),
				files: sourceFilesFor(pkg),
			}
		},
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: { sourceId: string }) =>
			artifacts.get(input.sourceId) ?? null,
	)
}

/**
 * Mirrors the `@kodycodes/cli` workerd host: a `kody:runtime` module whose
 * calls hop to CapabilityProxy, a shared runtime ALS entered with the host
 * default before user code evaluates, and the origin shim imported first for
 * its side effects.
 */
function createCliHostRuntimeSource() {
	return `
import { AsyncLocalStorage } from 'node:async_hooks';
function __kodyNamespace(path) {
	return new Proxy(function () {}, {
		get(_target, property) {
			if (typeof property === 'symbol' || property === 'then' || property === 'toJSON') return undefined;
			return __kodyNamespace([...path, property]);
		},
		apply(_target, _thisArg, args) {
			return globalThis.__kodyTestBridge(path, args);
		},
	});
}
export const kody = __kodyNamespace(['kody']);
export const workflows = null;
export const packages = null;
export const packageContext = Object.freeze({});
export const email = null;
export const events = null;
const __kodyRuntimeStorageSymbol = Symbol.for('kody.runtimeStorage');
const __kodyRuntimeStorage =
	globalThis[__kodyRuntimeStorageSymbol] ??
	(globalThis[__kodyRuntimeStorageSymbol] = new AsyncLocalStorage());
const __kodyRuntimeDefault = Object.freeze({ kody, packageContext, email, workflows, packages, events });
export default __kodyRuntimeDefault;
export function __kodyRunInLocalRuntime(callback) {
	return __kodyRuntimeStorage.run(__kodyRuntimeDefault, callback);
}
`
}

function createCliEntrySource() {
	return `
import './.__kody_virtual__/runtime.js';
import { __kodyRunInLocalRuntime } from './kody:runtime';
export async function run(params) {
	return await __kodyRunInLocalRuntime(async () => {
		const module = await import('./main.js');
		return await module.default(params);
	});
}
`
}

function createFakePackageStorageBridge() {
	const buckets = new Map<string, Map<string, unknown>>()
	const calls: Array<{ path: string; packageId: unknown }> = []
	const bucket = (packageId: unknown) => {
		const key = String(packageId)
		let existing = buckets.get(key)
		if (!existing) {
			existing = new Map()
			buckets.set(key, existing)
		}
		return existing
	}
	const bridge = async (path: Array<string>, args: Array<unknown>) => {
		const input = (args[0] ?? {}) as {
			packageId?: unknown
			key?: string
			value?: unknown
			alias?: string
		}
		const name = path.join('.')
		const packageId = input.packageId
		calls.push({ path: name, packageId })
		switch (name) {
			case 'kody.packageStorageGet':
				return {
					value: bucket(input.packageId).get(String(input.key)) ?? null,
				}
			case 'kody.packageStorageSet':
				bucket(input.packageId).set(String(input.key), input.value)
				return { ok: true }
			case 'kody.packageSecretHas':
				return { has: false }
			case 'kody.packageSecretGet':
				return { value: '' }
			default:
				throw new Error(`Unexpected CapabilityProxy hop ${name}`)
		}
	}
	return { bridge, buckets, calls }
}

test('execute --local legacy inlined runtime copies fail closed instead of claiming a package by id (GHSA-5fv3-qv7j-rqf5)', async () => {
	vi.clearAllMocks()
	const artifacts = new Map<string, ReturnType<typeof artifactHit>>()
	installRegistry(artifacts)

	artifacts.set(
		forecastPackage.sourceId,
		artifactHit(
			forecastPackage,
			await buildLegacyInlinedRuntimeArtifact(forecastPackage),
		),
	)
	const forecastBundle = artifacts.get(forecastPackage.sourceId)?.artifact
		.modules['bundle.js'] as string
	expect(forecastBundle).toContain('function __kodyCreatePackageBoundStorage(')

	const shadesBundle = await buildKodyImportableModuleBundle({
		env,
		baseUrl,
		userId,
		sourceFiles: sourceFilesFor(shadesPackage),
		entryPoint: shadesPackage.entryPoint,
		rootPackageId: shadesPackage.id,
	})
	artifacts.set(
		shadesPackage.sourceId,
		artifactHit(shadesPackage, shadesBundle),
	)

	const code = `import planDay from 'kody:@acme/shades/plan-day'
export default async function main(params) { return await planDay(params) }`
	const graph = await buildLocalExecutePackageGraph({
		env,
		baseUrl,
		userId,
		actorUserId: 'actor-1',
		code,
	})

	const files: Record<string, string> = {
		'kody:runtime': createCliHostRuntimeSource(),
		'entry.js': createCliEntrySource(),
		'main.js': code.replace(
			"'kody:@acme/shades/plan-day'",
			"'./kody:@acme/shades/plan-day'",
		),
	}
	for (const module of graph.modules) files[module.name] = module.esModule

	const { bridge, buckets, calls } = createFakePackageStorageBridge()
	const runtimeStorageSymbol = Symbol.for('kody.runtimeStorage')
	const previousStorage = Reflect.get(globalThis, runtimeStorageSymbol)
	Reflect.set(globalThis, runtimeStorageSymbol, new AsyncLocalStorage())
	Reflect.set(globalThis, '__kodyTestBridge', bridge)
	const moduleGraph = await createTemporaryModuleGraph(files)
	try {
		const entry = (await moduleGraph.importModule('entry.js')) as {
			run: (params: unknown) => Promise<unknown>
		}
		// The legacy copy looks packageStorage up in the shared runtime store
		// by package id. Local runs no longer answer that lookup (hosted
		// answers it only as the run's own package), so any module that names
		// a package id there gets nothing.
		await expect(entry.run({ forecast: { high: 81 } })).rejects.toThrow(
			/packageStorage\(\) is not available/,
		)
	} finally {
		await moduleGraph.cleanup()
		Reflect.deleteProperty(globalThis, '__kodyTestBridge')
		Reflect.set(globalThis, runtimeStorageSymbol, previousStorage)
	}

	expect(buckets.size).toBe(0)
	expect(calls).toEqual([])
})

test('execute --local sends each nested package its own signed binding, never a bare id (GHSA-5fv3-qv7j-rqf5)', async () => {
	vi.clearAllMocks()
	const artifacts = new Map<string, ReturnType<typeof artifactHit>>()
	installRegistry(artifacts)
	for (const pkg of [forecastPackage, shadesPackage]) {
		const bundle = await buildKodyImportableModuleBundle({
			env,
			baseUrl,
			userId,
			sourceFiles: sourceFilesFor(pkg),
			entryPoint: pkg.entryPoint,
			rootPackageId: pkg.id,
		})
		artifacts.set(pkg.sourceId, artifactHit(pkg, bundle))
	}

	const code = `import planDay from 'kody:@acme/shades/plan-day'
export default async function main(params) { return await planDay(params) }`
	const graph = await buildLocalExecutePackageGraph({
		env,
		baseUrl,
		userId,
		actorUserId: 'actor-1',
		code,
	})
	const files: Record<string, string> = {
		'kody:runtime': createCliHostRuntimeSource(),
		'entry.js': createCliEntrySource(),
		'main.js': code.replace(
			"'kody:@acme/shades/plan-day'",
			"'./kody:@acme/shades/plan-day'",
		),
	}
	for (const module of graph.modules) files[module.name] = module.esModule

	const { bridge, buckets, calls } = createFakePackageStorageBridge()
	const runtimeStorageSymbol = Symbol.for('kody.runtimeStorage')
	const previousStorage = Reflect.get(globalThis, runtimeStorageSymbol)
	Reflect.set(globalThis, runtimeStorageSymbol, new AsyncLocalStorage())
	Reflect.set(globalThis, '__kodyTestBridge', bridge)
	const moduleGraph = await createTemporaryModuleGraph(files)
	let result: unknown
	try {
		const entry = (await moduleGraph.importModule('entry.js')) as {
			run: (params: unknown) => Promise<unknown>
		}
		result = await entry.run({ forecast: { high: 81 } })
	} finally {
		await moduleGraph.cleanup()
		Reflect.deleteProperty(globalThis, '__kodyTestBridge')
		Reflect.set(globalThis, runtimeStorageSymbol, previousStorage)
	}

	expect(result).toEqual({
		forecast: { high: 81 },
		config: { synced: true },
		forecastHasWakeToken: false,
		shadesHasWakeToken: false,
	})
	expect(calls.length).toBeGreaterThan(0)
	for (const call of calls) {
		expect(String(call.packageId)).toMatch(/^kpb1\./)
	}
	const subject = { org: userId, actor: 'actor-1' }
	const verify = (binding: unknown) =>
		verifyLocalExecutePackageBinding({
			env,
			token: binding,
			subject,
		})
	const secretChecks = await Promise.all(
		calls
			.filter((call) => call.path === 'kody.packageSecretHas')
			.map((call) => verify(call.packageId)),
	)
	expect(new Set(secretChecks)).toEqual(
		new Set([forecastPackage.id, shadesPackage.id]),
	)
	const bucketsByPackage: Record<string, unknown> = {}
	for (const [binding, rows] of buckets) {
		bucketsByPackage[await verify(binding)] = Object.fromEntries(rows)
	}
	expect(bucketsByPackage).toEqual({
		[forecastPackage.id]: { forecast: { high: 81 } },
		[shadesPackage.id]: { config: { synced: true } },
	})
})

test('execute --local stamped packages reach plain kody.* capabilities through their bound kody', async () => {
	vi.clearAllMocks()
	const artifacts = new Map<string, ReturnType<typeof artifactHit>>()
	installRegistry(artifacts)
	const bundle = await buildKodyImportableModuleBundle({
		env,
		baseUrl,
		userId,
		sourceFiles: sourceFilesFor(rosterPackage),
		entryPoint: rosterPackage.entryPoint,
		rootPackageId: rosterPackage.id,
	})
	artifacts.set(rosterPackage.sourceId, artifactHit(rosterPackage, bundle))

	const code = `import count from 'kody:@acme/roster/count'
export default async function main() { return await count() }`
	const graph = await buildLocalExecutePackageGraph({
		env,
		baseUrl,
		userId,
		actorUserId: 'actor-1',
		code,
	})
	const files: Record<string, string> = {
		'kody:runtime': createCliHostRuntimeSource(),
		'entry.js': createCliEntrySource(),
		'main.js': code.replace(
			"'kody:@acme/roster/count'",
			"'./kody:@acme/roster/count'",
		),
	}
	for (const module of graph.modules) files[module.name] = module.esModule

	const calls: Array<{ path: string; args: Array<unknown> }> = []
	const bridge = async (path: Array<string>, args: Array<unknown>) => {
		const name = path.join('.')
		calls.push({ path: name, args })
		switch (name) {
			case 'kody.adminUserList':
				return { total: 3, users: [] }
			case 'kody.packageStorageGet':
				return { value: 7 }
			default:
				throw new Error(`Unknown runtime function ${name}.`)
		}
	}
	const runtimeStorageSymbol = Symbol.for('kody.runtimeStorage')
	const previousStorage = Reflect.get(globalThis, runtimeStorageSymbol)
	Reflect.set(globalThis, runtimeStorageSymbol, new AsyncLocalStorage())
	Reflect.set(globalThis, '__kodyTestBridge', bridge)
	const moduleGraph = await createTemporaryModuleGraph(files)
	let result: unknown
	try {
		const entry = (await moduleGraph.importModule('entry.js')) as {
			run: (params: unknown) => Promise<unknown>
		}
		result = await entry.run({})
	} finally {
		await moduleGraph.cleanup()
		Reflect.deleteProperty(globalThis, '__kodyTestBridge')
		Reflect.set(globalThis, runtimeStorageSymbol, previousStorage)
	}

	expect(result).toEqual({ total: 3, cached: 7 })
	// One hop per call, on the capability's own path with the caller's input
	// as the only argument (never `kody.<name>.call` with a this-arg).
	expect(calls.map((call) => call.path)).toEqual([
		'kody.adminUserList',
		'kody.packageStorageGet',
	])
	expect(calls[0]?.args).toEqual([{ page: 1, pageSize: 100 }])
	expect(calls[1]?.args).toHaveLength(1)
	const storageInput = calls[1]?.args[0] as { key: string; packageId: string }
	expect(storageInput.key).toBe('count')
	expect(
		await verifyLocalExecutePackageBinding({
			env,
			token: storageInput.packageId,
			subject: { org: userId, actor: 'actor-1' },
		}),
	).toBe(rosterPackage.id)
})

test('stamped package host commands keep their nested path and the current run dispatcher', async () => {
	vi.clearAllMocks()
	const artifacts = new Map<string, ReturnType<typeof artifactHit>>()
	installRegistry(artifacts)
	const bundle = await buildKodyImportableModuleBundle({
		env,
		baseUrl,
		userId,
		sourceFiles: sourceFilesFor(rosterPackage),
		entryPoint: rosterPackage.entryPoint,
		rootPackageId: rosterPackage.id,
	})
	artifacts.set(rosterPackage.sourceId, artifactHit(rosterPackage, bundle))
	const code = `import { hostCommand } from 'kody:@acme/roster/count'
export default async function main(params) { return await hostCommand(params) }`
	const graph = await buildLocalExecutePackageGraph({
		env,
		baseUrl,
		userId,
		actorUserId: 'actor-1',
		code,
	})
	const files: Record<string, string> = {
		'kody:runtime': createCliHostRuntimeSource(),
		'entry.js': createCliEntrySource(),
		'main.js': code.replace(
			"'kody:@acme/roster/count'",
			"'./kody:@acme/roster/count'",
		),
	}
	for (const module of graph.modules) files[module.name] = module.esModule
	const calls: Array<{ path: string; args: Array<unknown> }> = []
	const bridge = async (path: Array<string>, args: Array<unknown>) => {
		calls.push({ path: path.join('.'), args })
		if ((args[0] as { deny?: boolean })?.deny)
			throw new Error('execution_context_commands_off')
		return { commandId: 'command-fixture', exitCode: 0, stdout: 'fixture' }
	}
	const symbol = Symbol.for('kody.runtimeStorage')
	const previous = Reflect.get(globalThis, symbol)
	Reflect.set(globalThis, symbol, new AsyncLocalStorage())
	Reflect.set(globalThis, '__kodyTestBridge', bridge)
	const moduleGraph = await createTemporaryModuleGraph(files)
	try {
		const entry = (await moduleGraph.importModule('entry.js')) as {
			run: (params: unknown) => Promise<unknown>
		}
		for (const method of ['run', 'start', 'status', 'output', 'kill', 'list']) {
			const input =
				method === 'run' || method === 'start'
					? { file: '/usr/bin/true', args: [] }
					: { commandId: 'command-fixture' }
			expect(await entry.run({ method, input })).toEqual({
				commandId: 'command-fixture',
				exitCode: 0,
				stdout: 'fixture',
			})
			expect(calls.at(-1)).toEqual({
				path: `kody.command.${method}`,
				args: [input],
			})
		}
		await expect(
			entry.run({ method: 'run', input: { deny: true } }),
		).rejects.toThrow('execution_context_commands_off')
		const nextRun = vi.fn(async () => ({ stdout: 'next-run' }))
		Reflect.set(globalThis, '__kodyTestBridge', nextRun)
		expect(
			await entry.run({ method: 'run', input: { file: '/usr/bin/true' } }),
		).toEqual({ stdout: 'next-run' })
		expect(nextRun).toHaveBeenCalledWith(
			['kody', 'command', 'run'],
			[{ file: '/usr/bin/true' }],
		)
	} finally {
		await moduleGraph.cleanup()
		Reflect.deleteProperty(globalThis, '__kodyTestBridge')
		Reflect.set(globalThis, symbol, previous)
	}
})
