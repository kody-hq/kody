import { expect, test } from 'vitest'
import {
	type BundleArtifactKind,
	isUsableStoredPublishedBundleArtifact,
	readPublishedBundleArtifact,
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
	expect(served).not.toContain('.__kody_virtual__/runtime.js')
	expect(served).not.toContain('__kodyPreBindingBoundFetch')
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
