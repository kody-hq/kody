import { expect, test } from 'vitest'
import {
	createBundleArtifactManifest,
	parseStoredBundleArtifactManifest,
} from './bundle-artifact-manifest.ts'
import { linkedArtifactPrefix } from './module-graph-artifacts.ts'
import {
	type PublishedBundleArtifact,
	readPublishedBundleArtifact,
	writePublishedBundleArtifact,
} from './published-runtime-artifacts.ts'

const own = { sourceId: 'source-own', publishedCommit: 'commit-1' }
const dependency = {
	specifier: 'kody:@u/dep/read',
	sourceId: 'source-dep',
	publishedCommit: 'a'.repeat(40),
}
const linkedArtifactModule = `${linkedArtifactPrefix(dependency)}/dist/index.js`
const linkedImportModule = '.__kody_linked__/kody_dep.js'

function artifactWithModules(
	modules: PublishedBundleArtifact['modules'],
): PublishedBundleArtifact {
	return {
		version: 1,
		kind: 'module',
		artifactName: null,
		sourceId: 'source-own',
		publishedCommit: 'commit-1',
		entryPoint: 'src/index.ts',
		mainModule: 'dist/index.js',
		modules,
		dependencies: [],
		dynamicDependencies: [],
		packageContext: null,
		createdAt: '2026-11-14T00:00:00.000Z',
		packageBindingRewrite: 1,
	}
}

function createKvEnv() {
	const stored = new Map<string, string>()
	const kv = {
		async put(key: string, value: string) {
			stored.set(key, value)
		},
		async get(key: string) {
			const value = stored.get(key)
			return value == null ? null : JSON.parse(value)
		},
	}
	return { env: { BUNDLE_ARTIFACTS_KV: kv } as unknown as Env, stored }
}

test('createBundleArtifactManifest records a role and UTF-8 byte size for every module', () => {
	const manifest = createBundleArtifactManifest({
		...own,
		mainModule: 'dist/index.js',
		modules: {
			'dist/index.js': 'export default "é"',
			'dist/chunk.js': { js: 'export const a = 1' },
			'dist/data.bin': { data: new Uint8Array([1, 2, 3]).buffer },
			'dist/config.json': { json: { a: 1 } },
			[linkedArtifactModule]: 'export const dep = 1',
			[linkedImportModule]: 'export * from "./artifacts/x.js"',
		},
	})

	expect(manifest.modules).toEqual({
		'dist/index.js': { role: 'main', bytes: 19, owner: own },
		'dist/chunk.js': { role: 'module', bytes: 18, owner: own },
		'dist/data.bin': { role: 'module', bytes: 3, owner: own },
		'dist/config.json': { role: 'module', bytes: 7, owner: own },
		[linkedArtifactModule]: {
			role: 'linked-artifact',
			bytes: 20,
			owner: dependency,
		},
		[linkedImportModule]: { role: 'linked-import', bytes: 32, owner: own },
	})
	expect(manifest.totalBytes).toBe(19 + 18 + 3 + 7 + 20 + 32)
})

test('a written artifact reads back with a manifest matching its modules', async () => {
	const { env } = createKvEnv()
	const artifact = artifactWithModules({
		'dist/index.js': 'export default 1',
		[linkedArtifactModule]: 'export const dep = 1',
	})
	await writePublishedBundleArtifact({ env, artifact, kvKey: 'key' })

	const read = await readPublishedBundleArtifact({ env, kvKey: 'key' })

	expect(read?.modules).toEqual(artifact.modules)
	expect(read?.manifest).toEqual({
		version: 1,
		totalBytes: 36,
		modules: {
			'dist/index.js': { role: 'main', bytes: 16, owner: own },
			[linkedArtifactModule]: {
				role: 'linked-artifact',
				bytes: 20,
				owner: dependency,
			},
		},
	})
})

test('writing ignores a manifest carried on the artifact and derives it from the modules written', async () => {
	const { env } = createKvEnv()
	const stale = createBundleArtifactManifest({
		...own,
		mainModule: 'dist/index.js',
		modules: { 'dist/index.js': 'x' },
	})
	const artifact = {
		...artifactWithModules({ 'dist/index.js': 'export default 12345' }),
		manifest: stale,
	}
	await writePublishedBundleArtifact({ env, artifact, kvKey: 'key' })

	const read = await readPublishedBundleArtifact({ env, kvKey: 'key' })

	expect(read?.manifest?.totalBytes).toBe(20)
})

test('an artifact stored without a manifest still reads, with no manifest', async () => {
	const { env, stored } = createKvEnv()
	stored.set(
		'key',
		JSON.stringify(
			artifactWithModules({ 'dist/index.js': 'export default 1' }),
		),
	)

	const read = await readPublishedBundleArtifact({ env, kvKey: 'key' })

	expect(read?.modules['dist/index.js']).toBe('export default 1')
	expect(read?.manifest).toBeUndefined()
})

test('a stored manifest that does not describe the stored modules is dropped, not trusted', () => {
	const modulePaths = ['dist/index.js', 'dist/chunk.js']
	const valid = {
		version: 1,
		totalBytes: 2,
		modules: {
			'dist/index.js': { role: 'main', bytes: 1, owner: own },
			'dist/chunk.js': { role: 'module', bytes: 1, owner: own },
		},
	}
	expect(parseStoredBundleArtifactManifest(valid, modulePaths)).toEqual(valid)

	const rejected: Array<unknown> = [
		undefined,
		'manifest',
		{ ...valid, version: 2 },
		{ ...valid, totalBytes: '2' },
		{ ...valid, modules: null },
		{ ...valid, modules: { 'dist/index.js': valid.modules['dist/index.js'] } },
		{
			...valid,
			modules: {
				...valid.modules,
				'dist/extra.js': { role: 'module', bytes: 1 },
			},
		},
		{
			...valid,
			modules: {
				...valid.modules,
				'dist/chunk.js': { role: 'unknown', bytes: 1 },
			},
		},
		{
			...valid,
			modules: {
				...valid.modules,
				'dist/chunk.js': { role: 'module', bytes: 1.5 },
			},
		},
		{ ...valid, totalBytes: 0 },
		{
			...valid,
			totalBytes: 0,
			modules: {
				'dist/index.js': { role: 'main', bytes: 1 },
				'dist/chunk.js': { role: 'module', bytes: -1 },
			},
		},
	]
	for (const stored of rejected) {
		expect(parseStoredBundleArtifactManifest(stored, modulePaths)).toBeNull()
	}
})

test('a read-time repair that rewrites module source drops the stored manifest', async () => {
	const { env, stored } = createKvEnv()
	const modules = {
		'dist/index.js': 'export default async () => await fetch("https://x.test")',
	}
	const { packageBindingRewrite: _rewrite, ...preBinding } = {
		...artifactWithModules(modules),
		packageContext: {
			packageId: 'pkg-own',
			kodyId: 'own',
			sourceId: 'source-own',
		},
	}
	stored.set(
		'key',
		JSON.stringify({
			...preBinding,
			manifest: createBundleArtifactManifest({
				...own,
				mainModule: 'dist/index.js',
				modules,
			}),
		}),
	)

	const read = await readPublishedBundleArtifact({ env, kvKey: 'key' })

	expect(read?.modules['dist/index.js']).not.toBe(modules['dist/index.js'])
	expect(read?.manifest).toBeUndefined()
})

test('a module nested under two linked artifacts is owned by the innermost one', () => {
	const inner = {
		specifier: 'kody:@u/ai/ask',
		sourceId: 'source-ai',
		publishedCommit: 'b'.repeat(40),
	}
	const nested = `${linkedArtifactPrefix(dependency)}/${linkedArtifactPrefix(inner)}/bundle.js`
	const manifest = createBundleArtifactManifest({
		...own,
		mainModule: 'dist/index.js',
		modules: { 'dist/index.js': 'a', [nested]: 'b' },
	})

	expect(manifest.modules[nested]?.owner).toEqual(inner)
})

test('a linked artifact path that names no dependency version gets no owner', () => {
	const unreadable = '.__kody_linked__/artifacts/dep-source/commit-1/index.js'
	const manifest = createBundleArtifactManifest({
		...own,
		mainModule: 'dist/index.js',
		modules: { 'dist/index.js': 'a', [unreadable]: 'b' },
	})

	expect(manifest.modules[unreadable]).toEqual({
		role: 'linked-artifact',
		bytes: 1,
	})
})

test('a manifest written before owners were recorded is still read, and a malformed owner is not', () => {
	const modules = { 'dist/index.js': { role: 'main', bytes: 1 } }
	expect(
		parseStoredBundleArtifactManifest({ version: 1, totalBytes: 1, modules }, [
			'dist/index.js',
		]),
	).toEqual({ version: 1, totalBytes: 1, modules })
	expect(
		parseStoredBundleArtifactManifest(
			{
				version: 1,
				totalBytes: 1,
				modules: {
					'dist/index.js': { role: 'main', bytes: 1, owner: { sourceId: 1 } },
				},
			},
			['dist/index.js'],
		),
	).toBeNull()
})

test('a hex-named module directory after a key that fills its last path chunk is not read as part of the key', () => {
	// 48 characters encode to exactly one 96-character path chunk.
	const exact = {
		specifier: 'kody',
		sourceId: 'ab',
		publishedCommit: 'c'.repeat(40),
	}
	const prefix = linkedArtifactPrefix(exact)
	expect(prefix.split('/').at(-1)).toHaveLength(96)
	const modulePath = `${prefix}/ab/index.js`
	const manifest = createBundleArtifactManifest({
		...own,
		mainModule: 'dist/index.js',
		modules: { 'dist/index.js': 'a', [modulePath]: 'b' },
	})

	expect(manifest.modules[modulePath]?.owner).toEqual(exact)
})
