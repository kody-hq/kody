import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import type { EntitySourceRow } from '#worker/repo/types.ts'
import {
	type BundleArtifactKind,
	isUsableStoredPublishedBundleArtifact,
	type PublishedBundleArtifact,
	readPackageAppWorkerTemplate,
	readPublishedBundleArtifact,
	writePublishedBundleArtifact,
	writePublishedSourceSnapshot,
} from './published-runtime-artifacts.ts'

test('isUsableStoredPublishedBundleArtifact keeps clean v1 payloads and rejects remix-injected ones', () => {
	expect(
		isUsableStoredPublishedBundleArtifact({
			version: 1,
			modules: { 'dist/out.js': 'export default {}' },
		}),
	).toBe(true)
	expect(
		isUsableStoredPublishedBundleArtifact({
			version: 2,
			modules: { 'dist/out.js': 'export default {}' },
		}),
	).toBe(false)
	expect(
		isUsableStoredPublishedBundleArtifact({
			version: 1,
			modules: { 'dist/out.js': 'export default {}' },
			remixVersion: '3.0.0',
		}),
	).toBe(false)
	expect(
		isUsableStoredPublishedBundleArtifact({
			version: 1,
			modules: { 'dist/out.js': 'export default {}' },
			remixUiVersion: '0.12.1',
		}),
	).toBe(false)
	expect(
		isUsableStoredPublishedBundleArtifact({
			version: 1,
			modules: null,
		}),
	).toBe(false)
})

// A bundle persisted before package `fetch` became lexical: no
// `packageBindingRewrite` marker and a free `fetch`.
function storedPreBindingArtifact(input: {
	kind: BundleArtifactKind
	mainModule: string
	source: string
}) {
	return {
		version: 1,
		kind: input.kind,
		artifactName: null,
		sourceId: 'source-own',
		publishedCommit: 'commit-1',
		entryPoint: 'src/entry.ts',
		mainModule: input.mainModule,
		dynamicDependencies: [],
		dependencies: [],
		packageContext: {
			packageId: 'pkg-own',
			kodyId: 'own',
			sourceId: 'source-own',
		},
		modules: { [input.mainModule]: input.source },
		createdAt: '2026-10-01T00:00:00.000Z',
	}
}

function envWithStoredArtifact(stored: unknown) {
	const kv = {
		async get(key: string, type?: string) {
			expect(key).toBe('bundle-artifact:key')
			expect(type).toBe('json')
			return structuredClone(stored)
		},
	}
	return { BUNDLE_ARTIFACTS_KV: kv } as unknown as Env
}

test('readPublishedBundleArtifact returns an app-client bundle with a free fetch byte-identical', async () => {
	const clientSource = [
		'async function load() {',
		'  const response = await fetch("/api/items");',
		'  return await response.json();',
		'}',
		'load().then((items) => console.log(items));',
	].join('\n')
	const artifact = await readPublishedBundleArtifact({
		env: envWithStoredArtifact(
			storedPreBindingArtifact({
				kind: 'app-client',
				mainModule: 'client.abcdefghijklmnop.js',
				source: clientSource,
			}),
		),
		kvKey: 'bundle-artifact:key',
	})
	const served = artifact?.modules['client.abcdefghijklmnop.js']
	expect(served).toBe(clientSource)
})

test('readPublishedBundleArtifact still binds a pre-fix server bundle fetch to its package', async () => {
	const serverSource =
		'export default async function run() {\n  return await fetch("https://example.com");\n}'
	for (const kind of ['app', 'job', 'module', 'importable-module'] as const) {
		const artifact = await readPublishedBundleArtifact({
			env: envWithStoredArtifact(
				storedPreBindingArtifact({
					kind,
					mainModule: 'bundle.js',
					source: serverSource,
				}),
			),
			kvKey: 'bundle-artifact:key',
		})
		const served = artifact?.modules['bundle.js']
		expect(served).toContain(
			'import { __kodyCreatePackageBoundFetch as __kodyPreBindingBoundFetch } from "./.__kody_virtual__/runtime.js";',
		)
		expect(served).toContain(
			'const fetch = __kodyPreBindingBoundFetch("pkg-own");',
		)
		expect(served).toContain(serverSource)
	}
})

function fakeKvEnv() {
	const store = new Map<string, string>()
	const kv = {
		async put(key: string, value: string) {
			store.set(key, value)
		},
		async get(key: string, type?: string) {
			const value = store.get(key)
			if (value === undefined) return null
			return type === 'json' ? JSON.parse(value) : value
		},
		async delete(key: string) {
			store.delete(key)
		},
	}
	return { store, env: { BUNDLE_ARTIFACTS_KV: kv } as unknown as Env }
}

function publishedArtifact(
	kind: BundleArtifactKind,
	overrides: Partial<PublishedBundleArtifact> = {},
): PublishedBundleArtifact {
	return {
		version: 1,
		kind,
		artifactName: null,
		sourceId: 'source-app',
		publishedCommit: 'commit-2',
		entryPoint: kind === 'app' ? 'src/app.ts' : 'src/client.ts',
		mainModule: kind === 'app' ? 'app.js' : 'client-abc123.js',
		modules: { [kind === 'app' ? 'app.js' : 'client-abc123.js']: 'export {}' },
		dependencies: [],
		dynamicDependencies: [],
		packageContext: {
			packageId: 'pkg-app',
			kodyId: 'hello',
			sourceId: 'source-app',
		},
		createdAt: '2026-10-31T00:00:00.000Z',
		packageBindingRewrite: 1,
		...overrides,
	}
}

test('publish writes the package-app worker template next to the app and client bundles', async () => {
	const { env } = fakeKvEnv()
	await writePublishedBundleArtifact({
		env,
		artifact: publishedArtifact('app'),
	})
	await writePublishedBundleArtifact({
		env,
		artifact: publishedArtifact('app-client'),
	})
	const parts = await readPackageAppWorkerTemplate({
		env,
		sourceId: 'source-app',
		publishedCommit: 'commit-2',
		appEntry: './src/app.ts',
		clientEntry: 'src/client.ts',
	})
	expect(parts.app?.mainModule).toBe('app.js')
	expect(parts.app?.modules).toEqual({ 'app.js': 'export {}' })
	expect(parts.client).toEqual({ mainModule: 'client-abc123.js' })
})

test('a package published before templates reads no template, so serve falls back', async () => {
	const { env } = fakeKvEnv()
	await expect(
		readPackageAppWorkerTemplate({
			env,
			sourceId: 'source-app',
			publishedCommit: 'commit-2',
			appEntry: 'src/app.ts',
			clientEntry: 'src/client.ts',
		}),
	).resolves.toEqual({ app: null, client: undefined })
})

test('a template for another commit or entry is ignored; no client entry means no client', async () => {
	const { env } = fakeKvEnv()
	await writePublishedBundleArtifact({
		env,
		artifact: publishedArtifact('app'),
	})
	await expect(
		readPackageAppWorkerTemplate({
			env,
			sourceId: 'source-app',
			publishedCommit: 'commit-2',
			appEntry: 'src/other.ts',
			clientEntry: null,
		}),
	).resolves.toEqual({ app: null, client: null })
	await expect(
		readPackageAppWorkerTemplate({
			env,
			sourceId: 'source-app',
			publishedCommit: 'commit-3',
			appEntry: 'src/app.ts',
			clientEntry: null,
		}),
	).resolves.toMatchObject({ app: null })
})

test('module and job bundles never write a package-app template', async () => {
	const { env, store } = fakeKvEnv()
	await writePublishedBundleArtifact({
		env,
		artifact: publishedArtifact('module', { artifactName: 'run' }),
	})
	expect([...store.keys()].some((key) => key.startsWith('package-app'))).toBe(
		false,
	)
})

test('a same-commit snapshot repair drops the template so cold builds fall back', async () => {
	const { env } = fakeKvEnv()
	await writePublishedBundleArtifact({
		env,
		artifact: publishedArtifact('app'),
	})
	await writePublishedBundleArtifact({
		env,
		artifact: publishedArtifact('app-client'),
	})
	await writePublishedSourceSnapshot({
		env,
		source: {
			id: 'source-app',
			published_commit: 'commit-2',
			manifest_path: 'package.json',
			source_root: '/',
			repo_id: 'repo-1',
			entity_kind: 'package',
			entity_id: 'pkg-app',
		} as unknown as EntitySourceRow,
		files: { 'package.json': '{}' },
		invalidateExistingArtifacts: true,
	})
	await expect(
		readPackageAppWorkerTemplate({
			env,
			sourceId: 'source-app',
			publishedCommit: 'commit-2',
			appEntry: 'src/app.ts',
			clientEntry: 'src/client.ts',
		}),
	).resolves.toEqual({ app: null, client: undefined })
})

const linkedDependencyPrefix = `.__kody_linked__/artifacts/${'ab'.repeat(48)}/cd12`

function linkedBuildArtifact(
	overrides: Partial<PublishedBundleArtifact> = {},
): PublishedBundleArtifact {
	return publishedArtifact('app', {
		kind: 'module',
		entryPoint: 'src/a.ts',
		mainModule: 'a.js',
		modules: {
			'a.js': 'import "./.__kody_linked__/dep.js"',
			'.__kody_linked__/dep.js': 'export * from "./artifacts/x"',
			[`${linkedDependencyPrefix}/main.js`]: 'export const dep = 1',
			[`${linkedDependencyPrefix}/lib/util.js`]: 'export const util = 2',
		},
		...overrides,
	})
}

test('targets of one commit that link the same dependency store its modules once and read them back', async () => {
	const { env, store } = fakeKvEnv()
	const first = linkedBuildArtifact()
	const second = linkedBuildArtifact({
		entryPoint: 'src/b.ts',
		mainModule: 'b.js',
		modules: { ...first.modules, 'b.js': 'export {}' },
	})
	const firstKey = await writePublishedBundleArtifact({ env, artifact: first })
	const secondKey = await writePublishedBundleArtifact({
		env,
		artifact: second,
	})

	const linkedKeys = [...store.keys()].filter((key) =>
		key.startsWith('linked-artifact:v1:source-app:commit-2:'),
	)
	expect(linkedKeys).toHaveLength(1)
	const stored = JSON.parse(store.get(firstKey)!)
	expect(Object.keys(stored.modules).sort()).toEqual([
		'.__kody_linked__/dep.js',
		'a.js',
	])
	expect(stored.linkedArtifacts).toEqual([
		{
			prefix: linkedDependencyPrefix,
			sha256: linkedKeys[0]!.split(':').at(-1),
		},
	])

	for (const [kvKey, artifact] of [
		[firstKey, first],
		[secondKey, second],
	] as const) {
		const loaded = await readPublishedBundleArtifact({ env, kvKey })
		expect(loaded?.modules).toEqual(artifact.modules)
		expect(loaded?.manifest?.modules).toHaveProperty([
			`${linkedDependencyPrefix}/main.js`,
		])
	}
})

test('an artifact whose linked dependency modules are gone reads as missing', async () => {
	const { env, store } = fakeKvEnv()
	const kvKey = await writePublishedBundleArtifact({
		env,
		artifact: linkedBuildArtifact({ publishedCommit: 'commit-gone' }),
	})
	for (const key of store.keys()) {
		if (key.startsWith('linked-artifact:')) store.delete(key)
	}
	consoleWarn.mockImplementation(() => {})
	await expect(readPublishedBundleArtifact({ env, kvKey })).resolves.toBeNull()
	expect(consoleWarn).toHaveBeenCalledWith(
		'published-bundle-linked-artifact-missing',
		expect.objectContaining({ prefix: linkedDependencyPrefix }),
	)
})

test('an artifact stored with its linked dependency modules inline still reads', async () => {
	const { env, store } = fakeKvEnv()
	const artifact = linkedBuildArtifact()
	store.set('legacy', JSON.stringify(artifact))
	const loaded = await readPublishedBundleArtifact({ env, kvKey: 'legacy' })
	expect(loaded?.modules).toEqual(artifact.modules)
})
