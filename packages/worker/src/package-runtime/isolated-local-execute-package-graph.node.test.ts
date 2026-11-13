import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'
import { durableObjectIsolateMemoryResetMessage } from '#worker/sentry-options.ts'
import type * as LocalExecutePackageGraphModule from './local-execute-package-graph.ts'
import type * as PackageImportResolutionModule from './package-import-resolution.ts'
import {
	runIsolatedLocalExecutePackageGraphBuild,
	serveLocalExecutePackageGraph,
	type IsolatedLocalExecutePackageGraphRequest,
} from './isolated-local-execute-package-graph.ts'
import {
	LocalExecutePackageGraphError,
	type UnsignedLocalExecutePackageGraph,
} from './local-execute-package-graph.ts'
import { runtimeModulePath } from './module-graph-paths.ts'

const mocks = vi.hoisted(() => ({
	buildUnsigned: vi.fn(),
	resolveSavedPackageImport: vi.fn(),
	loadPackageSourceRowForUser: vi.fn(),
	listArtifacts: vi.fn(),
}))

vi.mock('./local-execute-package-graph.ts', async () => {
	const actual = await vi.importActual<typeof LocalExecutePackageGraphModule>(
		'./local-execute-package-graph.ts',
	)
	return {
		...actual,
		buildUnsignedLocalExecutePackageGraph: (...args: Array<unknown>) =>
			mocks.buildUnsigned(...args),
	}
})

vi.mock('./package-import-resolution.ts', async () => {
	const actual = await vi.importActual<typeof PackageImportResolutionModule>(
		'./package-import-resolution.ts',
	)
	return {
		...actual,
		resolveSavedPackageImport: (...args: Array<unknown>) =>
			mocks.resolveSavedPackageImport(...args),
	}
})

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceRowForUser: (...args: Array<unknown>) =>
		mocks.loadPackageSourceRowForUser(...args),
}))

vi.mock('#worker/repo/published-bundle-artifacts-repo.ts', () => ({
	listPublishedBundleArtifactsBySourceId: (...args: Array<unknown>) =>
		mocks.listArtifacts(...args),
}))

const userId = ownerIdFromStored('user-1')
const baseUrl = 'https://heykody.dev'

type Pkg = {
	name: string
	id: string
	sourceId: string
	commit: string
	artifactUpdatedAt: string
}
let packages: Map<string, Pkg>

function addPackage(name: string, commit = 'commit-1') {
	const leaf = name.split('/')[1]!
	const pkg = {
		name,
		id: `pkg-${leaf}`,
		sourceId: `src-${leaf}`,
		commit,
		artifactUpdatedAt: '2026-11-01T00:00:00.000Z',
	}
	packages.set(name, pkg)
	return pkg
}

function unsignedGraphFor(
	specifiers: Array<string>,
	extraResolvedPackageIds: Array<string> = [],
): UnsignedLocalExecutePackageGraph {
	const ids = specifiers.map((specifier) => {
		const name = specifier
			.replace(/^kody:/, '')
			.split('/')
			.slice(0, 2)
			.join('/')
		return packages.get(name)!.id
	})
	return {
		modules: ids.map((id) => ({
			name: `.__kody_packages__/${id}/.__published_bundle__/index.js`,
			esModule: `export default ${JSON.stringify(`${id}@${[...packages.values()].find((pkg) => pkg.id === id)?.commit}`)}`,
		})),
		primaryRuntimePath: runtimeModulePath,
		includesPrimaryRuntime: true,
		imports: specifiers,
		packageIdsByImport: Object.fromEntries(
			specifiers.map((specifier, index) => [specifier, ids[index]!]),
		),
		graphPackageIds: [...ids, ...extraResolvedPackageIds],
		entryPackageIds: ids,
		resolvedPackageIds: [...ids, ...extraResolvedPackageIds].sort(),
	}
}

function importsIn(code: string) {
	return [...code.matchAll(/from '(kody:@[^']+)'/g)].map((match) => match[1]!)
}

/**
 * `REPO_SESSION` stand-in: every `get` is a separate isolate whose input
 * crosses a structured-clone boundary like Durable Object RPC.
 */
function createEnv(
	isolate?: (
		input: IsolatedLocalExecutePackageGraphRequest,
	) => Promise<unknown>,
) {
	const { kv, store } = createMemoryKvNamespace()
	const isolateNames: Array<string> = []
	const env = {
		APP_DB: {},
		SECRET_STORE_KEY: 'test-secret-store-key',
		BUNDLE_ARTIFACTS_KV: kv,
		CF_VERSION_METADATA: { id: 'worker-version-1' },
		REPO_SESSION: {
			idFromName(name: string) {
				isolateNames.push(name)
				return name
			},
			get() {
				return {
					async buildIsolatedLocalExecutePackageGraph(
						input: IsolatedLocalExecutePackageGraphRequest,
					) {
						const cloned = structuredClone(input)
						return isolate
							? await isolate(cloned)
							: await runIsolatedLocalExecutePackageGraphBuild(env, cloned)
					},
				}
			},
		},
	} as unknown as Env
	return { env, store, isolateNames }
}

function serve(env: Env, code: string, actorUserId: string | null = 'actor-1') {
	return serveLocalExecutePackageGraph({
		env,
		baseUrl,
		userId,
		actorUserId,
		code,
		request: null,
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.spyOn(console, 'info').mockImplementation(() => {})
	packages = new Map()
	mocks.resolveSavedPackageImport.mockImplementation(
		async (input: { specifier: string }) => {
			const name = input.specifier
				.replace(/^kody:/, '')
				.split('/')
				.slice(0, 2)
				.join('/')
			const pkg = packages.get(name)
			return pkg
				? { row: { id: pkg.id, sourceId: pkg.sourceId, userId, name } }
				: null
		},
	)
	mocks.loadPackageSourceRowForUser.mockImplementation(
		async (input: { sourceId: string }) => {
			const pkg = [...packages.values()].find(
				(entry) => entry.sourceId === input.sourceId,
			)!
			return { published_commit: pkg.commit, serving_commit: pkg.commit }
		},
	)
	mocks.listArtifacts.mockImplementation(
		async (_db: unknown, _userId: string, sourceId: string) => {
			const pkg = [...packages.values()].find(
				(entry) => entry.sourceId === sourceId,
			)!
			return [
				{
					id: `artifact-${pkg.id}`,
					kvKey: `kv-${pkg.id}-${pkg.commit}`,
					updatedAt: pkg.artifactUpdatedAt,
				},
			]
		},
	)
	mocks.buildUnsigned.mockImplementation(async (input: { code: string }) =>
		unsignedGraphFor(importsIn(input.code)),
	)
})

const hubCode = `import hub from 'kody:@acme/hub/run'
export default async () => hub()`

test('a cache hit serves the stored graph without rebuilding it', async () => {
	addPackage('@acme/hub')
	const { env, store, isolateNames } = createEnv()

	const first = await serve(env, hubCode, 'actor-1')
	const second = await serve(env, hubCode, 'actor-2')

	expect(mocks.buildUnsigned).toHaveBeenCalledTimes(1)
	expect(isolateNames).toHaveLength(1)
	expect(store.size).toBe(1)
	expect(second.modules).toEqual(
		first.modules.map((module) =>
			module.name === runtimeModulePath
				? { name: runtimeModulePath, esModule: expect.any(String) }
				: module,
		),
	)
	expect(second.packageIdsByImport).toEqual({
		'kody:@acme/hub/run': 'pkg-hub',
	})
	// Bindings are signed per caller, never cached.
	expect(first.packageBindings['pkg-hub']).toMatch(/^kpb1\./)
	expect(second.packageBindings['pkg-hub']).toMatch(/^kpb1\./)
	expect(second.packageBindings['pkg-hub']).not.toBe(
		first.packageBindings['pkg-hub'],
	)
	expect([...store.values()].join('')).not.toContain('kpb1.')
})

test('a new commit on an imported package misses the cache and rebuilds', async () => {
	const hub = addPackage('@acme/hub', 'commit-1')
	const { env, store } = createEnv()

	const before = await serve(env, hubCode)
	hub.commit = 'commit-2'
	const after = await serve(env, hubCode)
	const again = await serve(env, hubCode)

	expect(mocks.buildUnsigned).toHaveBeenCalledTimes(2)
	expect(store.size).toBe(2)
	expect(JSON.stringify(before.modules)).toContain('pkg-hub@commit-1')
	expect(JSON.stringify(after.modules)).toContain('pkg-hub@commit-2')
	expect(again.modules).toEqual(
		after.modules.map((module) =>
			module.name === runtimeModulePath
				? { name: runtimeModulePath, esModule: expect.any(String) }
				: module,
		),
	)
})

test('an artifact repaired at the same commit misses the cache and rebuilds', async () => {
	const hub = addPackage('@acme/hub')
	const { env, store } = createEnv()

	await serve(env, hubCode)
	hub.artifactUpdatedAt = '2026-11-02T00:00:00.000Z'
	await serve(env, hubCode)

	expect(mocks.buildUnsigned).toHaveBeenCalledTimes(2)
	expect(store.size).toBe(2)
})

test('entry code that imports an internal runtime module is rejected even when the graph is cached', async () => {
	addPackage('@acme/hub')
	const { env } = createEnv()
	await serve(env, hubCode)

	const error = await serve(
		env,
		`import hub from 'kody:@acme/hub/run'
import { stamp } from './.__kody_packages__/pkg-hub/.__kody_virtual__/runtime.js'
export default async () => [hub(), stamp]`,
	).catch((caught: unknown) => caught)

	expect(error).toBeInstanceOf(LocalExecutePackageGraphError)
	expect((error as Error).message).toContain('.__kody_virtual__/')
	expect(mocks.buildUnsigned).toHaveBeenCalledTimes(1)
})

test('a build over the isolate limits fails only its own request and names the package', async () => {
	addPackage('@acme/huge')
	addPackage('@acme/small')
	const hugeCode = `import huge from 'kody:@acme/huge/run'
export default async () => huge()`
	const smallCode = `import small from 'kody:@acme/small/run'
export default async () => small()`
	let releaseHuge!: () => void
	const hugeStarted = new Promise<void>((resolve) => {
		releaseHuge = resolve
	})
	const { env, store, isolateNames } = createEnv(async (input) => {
		if (input.code.includes('@acme/huge')) {
			await hugeStarted
			throw new Error(durableObjectIsolateMemoryResetMessage)
		}
		return await runIsolatedLocalExecutePackageGraphBuild(env, input)
	})

	const huge = serve(env, hugeCode)
	const small = serve(env, smallCode)
	const smallGraph = await small
	releaseHuge()

	await expect(huge).rejects.toBeInstanceOf(LocalExecutePackageGraphError)
	const error = (await huge.catch(
		(caught: unknown) => caught,
	)) as LocalExecutePackageGraphError
	expect(error.code).toBe('package_graph_resource_limit')
	expect(error.message).toContain('@acme/huge')
	expect(error.message).not.toContain('@acme/small')
	expect(error.message).toContain('.kodyignore')
	expect(error.message).not.toContain('\u2014')
	expect(smallGraph.packageIdsByImport).toEqual({
		'kody:@acme/small/run': 'pkg-small',
	})
	// Each build gets its own throwaway isolate; the failed one cached nothing.
	expect(new Set(isolateNames).size).toBe(2)
	expect(
		isolateNames.every((name) => name.startsWith('isolated-package-graph-')),
	).toBe(true)
	expect(store.size).toBe(1)
})

test('a graph that resolved packages beyond its keyed imports is not cached', async () => {
	addPackage('@acme/hub')
	const nested = addPackage('@acme/nested')
	mocks.listArtifacts.mockImplementation(
		async (_db: unknown, _userId: string, sourceId: string) => {
			const pkg = [...packages.values()].find(
				(entry) => entry.sourceId === sourceId,
			)!
			return [
				{
					id: `artifact-${pkg.id}`,
					kvKey: `kv-${pkg.id}-${pkg.commit}`,
					updatedAt: pkg.artifactUpdatedAt,
				},
			]
		},
	)
	mocks.buildUnsigned.mockImplementation(async (input: { code: string }) =>
		unsignedGraphFor(importsIn(input.code), [nested.id]),
	)
	const { env, store } = createEnv()

	await serve(env, hubCode)
	await serve(env, hubCode)

	expect(store.size).toBe(0)
	expect(mocks.buildUnsigned).toHaveBeenCalledTimes(2)
})

test('graph errors from the isolate keep their code and message', async () => {
	addPackage('@acme/hub')
	mocks.buildUnsigned.mockRejectedValue(
		new LocalExecutePackageGraphError(
			'package_import_unpublished',
			'Saved package import kody:@acme/hub/run has no published importable-module artifact for local execute.',
		),
	)
	const { env, store } = createEnv()

	await expect(serve(env, hubCode)).rejects.toMatchObject({
		name: 'LocalExecutePackageGraphError',
		code: 'package_import_unpublished',
		message: expect.stringContaining('kody:@acme/hub/run'),
	})
	expect(store.size).toBe(0)
})

test('unresolved imports and import-free code never start an isolate', async () => {
	const { env, isolateNames } = createEnv()

	await expect(
		serve(env, `import x from 'kody:@acme/missing/run'\nexport default x`),
	).rejects.toMatchObject({ code: 'package_import_unresolved' })
	const empty = await serve(env, 'export default async () => 1')

	expect(empty.modules.map((module) => module.name)).toEqual([
		runtimeModulePath,
	])
	expect(isolateNames).toHaveLength(0)
	expect(mocks.buildUnsigned).not.toHaveBeenCalled()
})
