import { expect, test, vi } from 'vitest'
import {
	isPreBindingPublishedArtifact,
	isUnrepairablePreBindingArtifact,
	packageBindingRewriteVersion,
	publishedArtifactNeedsPackageBindingRebuild,
	repairGlobalObjectFetchReadsInArtifact,
	repairPreBindingPublishedArtifact,
} from './pre-binding-artifact-repair.ts'

const packageId = 'pkg-own'

function artifact(source: string, extra: Record<string, unknown> = {}) {
	return {
		modules: { 'bundle.js': source } as Record<string, string>,
		dependencies: [] as Array<{ packageId?: string }>,
		packageContext: { packageId },
		...extra,
	}
}

const preFixSource = [
	'import { packageContext, kody } from "./.__kody_virtual__/runtime.js";',
	'async function wake() {',
	'  await kody.secrets.list();',
	'  return await fetch("https://example.com");',
	'}',
	'export { wake };',
].join('\n')

test('binds a pre-fix bundle free fetch and shared kody to its own package', async () => {
	const repaired = await repairPreBindingPublishedArtifact(
		artifact(preFixSource),
	)
	const source = repaired.modules['bundle.js']!
	expect(source).toContain(
		'import { __kodyCreatePackageBoundFetch as __kodyPreBindingBoundFetch, __kodyCreatePackageBoundKody as __kodyPreBindingBoundKody } from "./.__kody_virtual__/runtime.js";',
	)
	expect(source).toContain(
		'const fetch = __kodyPreBindingBoundFetch("pkg-own");',
	)
	expect(source).toContain('const kody = __kodyPreBindingBoundKody("pkg-own");')
	expect(source).toContain(
		'import { packageContext } from "./.__kody_virtual__/runtime.js";',
	)
	expect(isPreBindingPublishedArtifact(repaired)).toBe(false)
})

test('keeps an aliased shared kody import local name', async () => {
	const repaired = await repairPreBindingPublishedArtifact(
		artifact(
			'import { kody as kody2 } from "./.__kody_virtual__/runtime.js";\nexport const run = () => kody2.secrets.list();',
		),
	)
	const source = repaired.modules['bundle.js']!
	expect(source).toContain(
		'const kody2 = __kodyPreBindingBoundKody("pkg-own");',
	)
	expect(source).not.toContain('import { kody as kody2 }')
})

test('leaves current, marked, unowned, and multi-package bundles unchanged', async () => {
	const current = artifact(
		'var __kodyBoundFetch = __kodyCreatePackageBoundFetch("pkg-own");\nexport const run = () => __kodyBoundFetch("https://example.com");',
	)
	expect(await repairPreBindingPublishedArtifact(current)).toBe(current)
	const marked = artifact(preFixSource, {
		packageBindingRewrite: packageBindingRewriteVersion,
	})
	expect(await repairPreBindingPublishedArtifact(marked)).toBe(marked)
	const unowned = artifact(preFixSource, { packageContext: null })
	expect(await repairPreBindingPublishedArtifact(unowned)).toBe(unowned)
	const mixed = artifact(preFixSource, {
		dependencies: [{ packageId: 'pkg-other' }],
	})
	expect(await repairPreBindingPublishedArtifact(mixed)).toBe(mixed)
})

test('does not shadow a module-level fetch declaration', async () => {
	const own = artifact(
		'const fetch = (url) => globalThis.fetch(url);\nexport const run = () => fetch("https://example.com");',
	)
	expect(
		(await repairPreBindingPublishedArtifact(own)).modules['bundle.js'],
	).toBe(own.modules['bundle.js'])
})

test('multi-package pre-fix bundles rebuild only when source needs no npm install', async () => {
	const mixed = artifact(preFixSource, {
		dependencies: [{ packageId: 'pkg-other' }],
	})
	expect(
		await publishedArtifactNeedsPackageBindingRebuild({
			artifact: mixed,
			sourceFiles: { 'src/index.ts': 'export const wake = () => fetch("x")' },
		}),
	).toBe(true)
	expect(
		await publishedArtifactNeedsPackageBindingRebuild({
			artifact: artifact(preFixSource),
			sourceFiles: {},
		}),
	).toBe(false)
})

test('multi-package unmarked packageStorage-only bundles need a binding rebuild', async () => {
	// No free fetch and no shared kody import: the old free-fetch heuristic
	// treated this as current, so workflow/export load sites and same-commit
	// publish kept the stale bundle. The inlined callee's packageStorage()
	// then fails owner-only checks while execute (fresh build) works.
	const storageOnly = [
		'export default async function run() {',
		'  const storage = packageStorage();',
		'  return await storage.get("skill");',
		'}',
	].join('\n')
	const mixed = artifact(storageOnly, {
		dependencies: [{ packageId: 'pkg-skills' }],
	})
	expect(isPreBindingPublishedArtifact(mixed)).toBe(false)
	expect(await isUnrepairablePreBindingArtifact(mixed)).toBe(true)
	expect(
		await publishedArtifactNeedsPackageBindingRebuild({
			artifact: mixed,
			sourceFiles: { 'src/index.ts': storageOnly },
		}),
	).toBe(true)
	expect(
		await isUnrepairablePreBindingArtifact({
			...mixed,
			packageBindingRewrite: packageBindingRewriteVersion,
		}),
	).toBe(false)
	expect(
		await isUnrepairablePreBindingArtifact(
			artifact(
				'var __kodyBoundFetch = __kodyCreatePackageBoundFetch("pkg-own");\nexport default async () => packageStorage()',
				{ dependencies: [{ packageId: 'pkg-skills' }] },
			),
		),
	).toBe(false)
})

test('reports a module the repair cannot bind instead of skipping it silently', async () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	try {
		const unparsable = artifact('export const run = ( => fetch("x")', {
			sourceId: 'src-own',
		})
		expect(
			(await repairPreBindingPublishedArtifact(unparsable)).modules,
		).toEqual(unparsable.modules)
		const collision = artifact(
			'const __kodyPreBindingBoundFetch = 1;\nexport const run = () => fetch("x");',
			{ sourceId: 'src-own' },
		)
		expect(
			(await repairPreBindingPublishedArtifact(collision)).modules,
		).toEqual(collision.modules)
		const events = warn.mock.calls.map((call) => JSON.parse(String(call[0])))
		expect(events).toEqual([
			{
				event: 'pre_binding_module_unrepaired',
				sourceId: 'src-own',
				modulePath: 'bundle.js',
				reason: 'parse-failed',
			},
			{
				event: 'pre_binding_module_unrepaired',
				sourceId: 'src-own',
				modulePath: 'bundle.js',
				reason: 'creator-name-collision',
			},
		])
	} finally {
		warn.mockRestore()
	}
})

test('a multi-package pre-fix bundle that needs an npm install to rebuild is reported', async () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	try {
		const mixed = artifact(preFixSource, {
			dependencies: [{ packageId: 'pkg-other' }],
			sourceId: 'src-own',
		})
		expect(
			await publishedArtifactNeedsPackageBindingRebuild({
				artifact: mixed,
				sourceFiles: {
					'package.json': JSON.stringify({ dependencies: { marked: '1.0.0' } }),
					'src/index.ts': 'export const wake = () => fetch("x")',
				},
			}),
		).toBe(false)
		expect(warn.mock.calls.map((call) => JSON.parse(String(call[0])))).toEqual([
			{
				event: 'pre_binding_bundle_needs_republish',
				sourceId: 'src-own',
				missingDependencyCount: 1,
			},
		])
	} finally {
		warn.mockRestore()
	}
})

test('never treats a browser app-client bundle as pre-binding', async () => {
	const clientSource =
		'const response = await fetch("/api/items");\nconsole.log(await response.json());'
	const client = artifact(clientSource, { kind: 'app-client' })
	expect(isPreBindingPublishedArtifact(client)).toBe(false)
	expect(await repairPreBindingPublishedArtifact(client)).toBe(client)
	expect(client.modules['bundle.js']).toBe(clientSource)
	const mixedClient = artifact(clientSource, {
		kind: 'app-client',
		dependencies: [{ packageId: 'pkg-other' }],
	})
	expect(await isUnrepairablePreBindingArtifact(mixedClient)).toBe(false)
	expect(
		await publishedArtifactNeedsPackageBindingRebuild({
			artifact: mixedClient,
			sourceFiles: {},
		}),
	).toBe(false)
	// Isolate-loaded kinds keep the repair.
	const app = artifact(clientSource, { kind: 'app' })
	expect(isPreBindingPublishedArtifact(app)).toBe(true)
	expect(
		(await repairPreBindingPublishedArtifact(app)).modules['bundle.js'],
	).toContain('const fetch = __kodyPreBindingBoundFetch("pkg-own");')
})

const globalReadSource = [
	'var __kodyBoundFetch = __kodyCreatePackageBoundFetch("pkg-own");',
	'export const wake = () => globalThis.fetch("https://example.com");',
].join('\n')

test('binds global-object fetch reads in a single-package bundle built before the builder did', async () => {
	for (const extra of [{}, { packageBindingRewrite: 1 }]) {
		const repaired = await repairGlobalObjectFetchReadsInArtifact(
			artifact(globalReadSource, extra),
		)
		const source = repaired.modules['bundle.js']!
		expect(source).toContain(
			'import { __kodyCreatePackageBoundFetch as __kodyPreBindingGlobalReadCreator } from "./.__kody_virtual__/runtime.js";',
		)
		expect(source).toContain(
			'const __kodyPreBindingGlobalReadFetch = __kodyPreBindingGlobalReadCreator("pkg-own");',
		)
		expect(source).toContain(
			'export const wake = () => __kodyPreBindingGlobalReadFetch("https://example.com");',
		)
	}
})

test('leaves current, unowned, multi-package and write-only bundles alone', async () => {
	for (const unchanged of [
		artifact(globalReadSource, {
			packageBindingRewrite: packageBindingRewriteVersion,
		}),
		artifact(globalReadSource, { packageContext: null }),
		artifact(globalReadSource, { dependencies: [{ packageId: 'pkg-other' }] }),
		artifact('globalThis.fetch = polyfill;', { packageBindingRewrite: 1 }),
		artifact('const g = globalThis; g.fetch(url);', {
			packageBindingRewrite: 1,
		}),
		artifact(globalReadSource, { kind: 'app-client' }),
	]) {
		expect(await repairGlobalObjectFetchReadsInArtifact(unchanged)).toBe(
			unchanged,
		)
	}
})

test('a multi-package bundle with a global-object fetch read is rebuilt once, to the current version', async () => {
	const mixed = { dependencies: [{ packageId: 'pkg-other' }] }
	expect(
		await isUnrepairablePreBindingArtifact(
			artifact(globalReadSource, { ...mixed, packageBindingRewrite: 1 }),
		),
	).toBe(true)
	expect(
		await isUnrepairablePreBindingArtifact(
			artifact(globalReadSource, {
				...mixed,
				packageBindingRewrite: packageBindingRewriteVersion,
			}),
		),
	).toBe(false)
	expect(
		await isUnrepairablePreBindingArtifact(
			artifact(
				'var __kodyBoundFetch = __kodyCreatePackageBoundFetch("pkg-own"); export const wake = () => __kodyBoundFetch(url);',
				{ ...mixed, packageBindingRewrite: 1 },
			),
		),
	).toBe(false)
})
