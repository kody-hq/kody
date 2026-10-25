import { expect, test, vi } from 'vitest'
import {
	isPreBindingPublishedArtifact,
	isUnrepairablePreBindingArtifact,
	packageBindingRewriteVersion,
	publishedArtifactNeedsPackageBindingRebuild,
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

test('binds a pre-fix bundle free fetch and shared kody to its own package', () => {
	const repaired = repairPreBindingPublishedArtifact(artifact(preFixSource))
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

test('keeps an aliased shared kody import local name', () => {
	const repaired = repairPreBindingPublishedArtifact(
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

test('leaves current, marked, unowned, and multi-package bundles unchanged', () => {
	const current = artifact(
		'var __kodyBoundFetch = __kodyCreatePackageBoundFetch("pkg-own");\nexport const run = () => __kodyBoundFetch("https://example.com");',
	)
	expect(repairPreBindingPublishedArtifact(current)).toBe(current)
	const marked = artifact(preFixSource, {
		packageBindingRewrite: packageBindingRewriteVersion,
	})
	expect(repairPreBindingPublishedArtifact(marked)).toBe(marked)
	const unowned = artifact(preFixSource, { packageContext: null })
	expect(repairPreBindingPublishedArtifact(unowned)).toBe(unowned)
	const mixed = artifact(preFixSource, {
		dependencies: [{ packageId: 'pkg-other' }],
	})
	expect(repairPreBindingPublishedArtifact(mixed)).toBe(mixed)
})

test('does not shadow a module-level fetch declaration', () => {
	const own = artifact(
		'const fetch = (url) => globalThis.fetch(url);\nexport const run = () => fetch("https://example.com");',
	)
	expect(repairPreBindingPublishedArtifact(own).modules['bundle.js']).toBe(
		own.modules['bundle.js'],
	)
})

test('multi-package pre-fix bundles rebuild only when source needs no npm install', () => {
	const mixed = artifact(preFixSource, {
		dependencies: [{ packageId: 'pkg-other' }],
	})
	expect(
		publishedArtifactNeedsPackageBindingRebuild({
			artifact: mixed,
			sourceFiles: { 'src/index.ts': 'export const wake = () => fetch("x")' },
		}),
	).toBe(true)
	expect(
		publishedArtifactNeedsPackageBindingRebuild({
			artifact: artifact(preFixSource),
			sourceFiles: {},
		}),
	).toBe(false)
})

test('multi-package unmarked packageStorage-only bundles need a binding rebuild', () => {
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
	expect(isUnrepairablePreBindingArtifact(mixed)).toBe(true)
	expect(
		publishedArtifactNeedsPackageBindingRebuild({
			artifact: mixed,
			sourceFiles: { 'src/index.ts': storageOnly },
		}),
	).toBe(true)
	expect(
		isUnrepairablePreBindingArtifact({
			...mixed,
			packageBindingRewrite: packageBindingRewriteVersion,
		}),
	).toBe(false)
	expect(
		isUnrepairablePreBindingArtifact(
			artifact(
				'var __kodyBoundFetch = __kodyCreatePackageBoundFetch("pkg-own");\nexport default async () => packageStorage()',
				{ dependencies: [{ packageId: 'pkg-skills' }] },
			),
		),
	).toBe(false)
})

test('reports a module the repair cannot bind instead of skipping it silently', () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	try {
		const unparsable = artifact('export const run = ( => fetch("x")', {
			sourceId: 'src-own',
		})
		expect(repairPreBindingPublishedArtifact(unparsable).modules).toEqual(
			unparsable.modules,
		)
		const collision = artifact(
			'const __kodyPreBindingBoundFetch = 1;\nexport const run = () => fetch("x");',
			{ sourceId: 'src-own' },
		)
		expect(repairPreBindingPublishedArtifact(collision).modules).toEqual(
			collision.modules,
		)
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

test('a multi-package pre-fix bundle that needs an npm install to rebuild is reported', () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	try {
		const mixed = artifact(preFixSource, {
			dependencies: [{ packageId: 'pkg-other' }],
			sourceId: 'src-own',
		})
		expect(
			publishedArtifactNeedsPackageBindingRebuild({
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

test('never treats a browser app-client bundle as pre-binding', () => {
	const clientSource =
		'const response = await fetch("/api/items");\nconsole.log(await response.json());'
	const client = artifact(clientSource, { kind: 'app-client' })
	expect(isPreBindingPublishedArtifact(client)).toBe(false)
	expect(repairPreBindingPublishedArtifact(client)).toBe(client)
	expect(client.modules['bundle.js']).toBe(clientSource)
	const mixedClient = artifact(clientSource, {
		kind: 'app-client',
		dependencies: [{ packageId: 'pkg-other' }],
	})
	expect(isUnrepairablePreBindingArtifact(mixedClient)).toBe(false)
	expect(
		publishedArtifactNeedsPackageBindingRebuild({
			artifact: mixedClient,
			sourceFiles: {},
		}),
	).toBe(false)
	// Isolate-loaded kinds keep the repair.
	const app = artifact(clientSource, { kind: 'app' })
	expect(isPreBindingPublishedArtifact(app)).toBe(true)
	expect(repairPreBindingPublishedArtifact(app).modules['bundle.js']).toContain(
		'const fetch = __kodyPreBindingBoundFetch("pkg-own");',
	)
})
