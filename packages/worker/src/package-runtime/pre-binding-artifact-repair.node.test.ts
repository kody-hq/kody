import { expect, test } from 'vitest'
import {
	isPreBindingPublishedArtifact,
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
