import { expect, test } from 'vitest'
import {
	createBundleArtifactManifest,
	parseStoredBundleArtifactManifest,
} from './bundle-artifact-manifest.ts'
import {
	type PublishedBundleArtifact,
	readPublishedBundleArtifact,
	writePublishedBundleArtifact,
} from './published-runtime-artifacts.ts'

const linkedArtifactModule =
	'.__kody_linked__/artifacts/dep-source/commit-1/dist/index.js'
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
		'dist/index.js': { role: 'main', bytes: 19 },
		'dist/chunk.js': { role: 'module', bytes: 18 },
		'dist/data.bin': { role: 'module', bytes: 3 },
		'dist/config.json': { role: 'module', bytes: 7 },
		[linkedArtifactModule]: { role: 'linked-artifact', bytes: 20 },
		[linkedImportModule]: { role: 'linked-import', bytes: 32 },
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
	expect(read?.manifest).toEqual(createBundleArtifactManifest(artifact))
})

test('writing ignores a manifest carried on the artifact and derives it from the modules written', async () => {
	const { env } = createKvEnv()
	const stale = createBundleArtifactManifest({
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
	const valid = createBundleArtifactManifest({
		mainModule: 'dist/index.js',
		modules: { 'dist/index.js': 'a', 'dist/chunk.js': 'b' },
	})
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
				mainModule: 'dist/index.js',
				modules,
			}),
		}),
	)

	const read = await readPublishedBundleArtifact({ env, kvKey: 'key' })

	expect(read?.modules['dist/index.js']).not.toBe(modules['dist/index.js'])
	expect(read?.manifest).toBeUndefined()
})
