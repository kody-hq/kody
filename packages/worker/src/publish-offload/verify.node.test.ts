import { expect, test } from 'vitest'
import { sha256Hex, workerLoaderModuleBytes } from './module-hashes.ts'
import { preparePublishBuildSourceTree } from './source-tree.ts'
import type { PublishBuildTargetEntry } from './types.ts'
import {
	assertSameBuildUploadMatches,
	PublishBuildVerificationError,
	matchUploadedTargets,
	verifySourceManifest,
	verifyUploadedTargetModules,
} from './verify.ts'

const encoder = new TextEncoder()

async function manifestFor(files: Record<string, string>) {
	return await Promise.all(
		Object.entries(files).map(async ([path, content]) => ({
			path,
			size: encoder.encode(content).byteLength,
			sha256: await sha256Hex(content),
		})),
	)
}

async function uploadedTarget(
	modules: Record<string, string>,
	overrides: Partial<PublishBuildTargetEntry> = {},
): Promise<PublishBuildTargetEntry> {
	const entries: PublishBuildTargetEntry['modules'] = {}
	for (const [path, source] of Object.entries(modules)) {
		const bytes = workerLoaderModuleBytes(source)
		entries[path] = {
			sha256: await sha256Hex(bytes),
			size: bytes.byteLength,
			chunks: [],
		}
	}
	return {
		kind: 'module',
		bundleKind: 'module',
		artifactName: null,
		entryPoint: 'src/index.ts',
		mainModule: 'index.js',
		modules: entries,
		...overrides,
	}
}

const tree = {
	'package.json': '{"name":"@me/big"}',
	'src/index.ts': 'export default 1',
}

test('a manifest that matches the pushed tree passes', async () => {
	await expect(
		verifySourceManifest({
			serverFiles: tree,
			claimed: await manifestFor(tree),
		}),
	).resolves.not.toThrow()
})

test('a manifest from a dirty or different tree is refused', async () => {
	const edited = await manifestFor({
		...tree,
		'src/index.ts': 'export default 2',
	})
	await expect(
		verifySourceManifest({ serverFiles: tree, claimed: edited }),
	).rejects.toBeInstanceOf(PublishBuildVerificationError)
	const extra = await manifestFor({ ...tree, 'src/extra.ts': 'x' })
	await expect(
		verifySourceManifest({ serverFiles: tree, claimed: extra }),
	).rejects.toThrow(/src\/extra\.ts/)
	const missing = await manifestFor({ 'package.json': tree['package.json'] })
	await expect(
		verifySourceManifest({ serverFiles: tree, claimed: missing }),
	).rejects.toThrow(/src\/index\.ts/)
})

test('the uploaded target set must equal the declared targets', async () => {
	const expected = [
		{ kind: 'module', bundleKind: 'module', entryPoint: 'src/index.ts' },
	] as const
	const ok = await uploadedTarget({ 'index.js': 'export default 1' })
	expect(
		matchUploadedTargets({ expected: expected as never, uploaded: [ok] }),
	).toEqual([{ target: expected[0], uploaded: ok }])
	expect(() =>
		matchUploadedTargets({ expected: expected as never, uploaded: [] }),
	).toThrow(/missing/)
	const stray = await uploadedTarget(
		{ 'index.js': 'x' },
		{ entryPoint: 'src/other.ts' },
	)
	expect(() =>
		matchUploadedTargets({
			expected: expected as never,
			uploaded: [ok, stray],
		}),
	).toThrow(PublishBuildVerificationError)
})

test('a tampered module is refused by hash', async () => {
	const source = 'export default 1'
	const uploaded = await uploadedTarget({ 'index.js': source })
	await expect(
		verifyUploadedTargetModules({
			uploaded,
			modules: { 'index.js': source },
			ownPackageId: 'pkg-1',
			linkedImports: new Map(),
		}),
	).resolves.toEqual({
		totalBytes: 19,
		referencedLinkedImports: new Set(),
	})
	await expect(
		verifyUploadedTargetModules({
			uploaded,
			modules: { 'index.js': 'export default "evil"' },
			ownPackageId: 'pkg-1',
			linkedImports: new Map(),
		}),
	).rejects.toBeInstanceOf(PublishBuildVerificationError)
})

test('a bundle that still imports kody:runtime or a kody: package is refused for every target kind', async () => {
	const targets: Array<Partial<PublishBuildTargetEntry>> = [
		{ kind: 'app', bundleKind: 'app', entryPoint: 'src/app.ts' },
		{ kind: 'job', bundleKind: 'module', artifactName: 'tick' },
		{ kind: 'module', bundleKind: 'module' },
		{ kind: 'importable-module', bundleKind: 'importable-module' },
	]
	const sources = [
		'import { packageContext } from "kody:runtime"\nexport default { fetch: () => new Response(String(packageContext)) }',
		'import helper from "kody:@other/pkg/helper"\nexport default helper',
		'export * from "kody:runtime"',
		'export default () => import("kody:runtime")',
	]
	for (const overrides of targets) {
		for (const source of sources) {
			const uploaded = await uploadedTarget(
				{ 'bundle.js': source },
				{
					mainModule: 'bundle.js',
					...overrides,
				},
			)
			await expect(
				verifyUploadedTargetModules({
					uploaded,
					modules: { 'bundle.js': source },
					ownPackageId: 'pkg-1',
					linkedImports: new Map(),
				}),
			).rejects.toThrow(
				/module "bundle\.js" of "[^"]+" still imports "kody:[^"]+"\. A build rewrites kody: imports to modules Kody supplies at load time, and this one did not, so the bundle would fail to load\. Update the Kody CLI/,
			)
		}
	}
	const rewritten =
		'import { packageContext } from "./.__kody_virtual__/runtime.js"\nexport default "kody:runtime is only a string here"'
	await expect(
		verifyUploadedTargetModules({
			uploaded: await uploadedTarget(
				{ 'bundle.js': rewritten },
				{
					mainModule: 'bundle.js',
				},
			),
			modules: { 'bundle.js': rewritten },
			ownPackageId: 'pkg-1',
			linkedImports: new Map(),
		}),
	).resolves.toMatchObject({ referencedLinkedImports: new Set() })
})

test('unsafe module paths and a missing main module are refused', async () => {
	for (const path of [
		'../escape.js',
		'/abs.js',
		'.__kody_virtual__/runtime.js',
	]) {
		const uploaded = await uploadedTarget({ 'index.js': 'a', [path]: 'b' })
		await expect(
			verifyUploadedTargetModules({
				uploaded,
				modules: { 'index.js': 'a', [path]: 'b' },
				ownPackageId: 'pkg-1',
				linkedImports: new Map(),
			}),
		).rejects.toBeInstanceOf(PublishBuildVerificationError)
	}
	const noMain = await uploadedTarget({ 'other.js': 'a' })
	await expect(
		verifyUploadedTargetModules({
			uploaded: noMain,
			modules: { 'other.js': 'a' },
			ownPackageId: 'pkg-1',
			linkedImports: new Map(),
		}),
	).rejects.toThrow(/main module/i)
})

test('the builder manifest matches the server snapshot for binaries and .kodyignore', async () => {
	const png = new Uint8Array([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff,
	])
	const raw = [
		{
			path: 'package.json',
			bytes: new TextEncoder().encode('{"name":"@me/big"}'),
		},
		{ path: '.kodyignore', bytes: new TextEncoder().encode('fixtures/\n') },
		{ path: 'assets/logo.png', bytes: png },
		{
			path: 'fixtures/large.pdf',
			bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xe2]),
		},
	]
	const { sourceFiles, manifest } = await preparePublishBuildSourceTree({
		files: raw,
		sourceRoot: '/',
	})
	expect(Object.keys(sourceFiles).sort()).toEqual([
		'.kodyignore',
		'assets/logo.png',
		'package.json',
	])
	expect(manifest.find((entry) => entry.path === 'assets/logo.png')).toEqual({
		path: 'assets/logo.png',
		size: png.byteLength,
		sha256: await sha256Hex(png),
	})
	// The server's published snapshot of the same commit: ignored files are
	// dropped and the PNG is a latin1 string.
	await expect(
		verifySourceManifest({ serverFiles: sourceFiles, claimed: manifest }),
	).resolves.not.toThrow()
})

for (const [label, source] of [
	[
		'an aliased import',
		'import { __kodyCreatePackageBoundFetch as f } from "./.__kody_virtual__/runtime.js";\nvar x = f("pkg-other");',
	],
	[
		'a creator assigned to a variable',
		'import { __kodyCreatePackageBoundFetch } from "./.__kody_virtual__/runtime.js";\nconst f = __kodyCreatePackageBoundFetch;\nf("pkg-other");',
	],
	[
		'a namespace import of the runtime',
		'import * as rt from "./.__kody_virtual__/runtime.js";\nrt["__kodyCreate" + "PackageBoundFetch"]("pkg-other");',
	],
	[
		'a computed dynamic import',
		'const p = "./.__kody_" + "virtual__/runtime.js";\nconst rt = await import(p);',
	],
	[
		'a re-export of the runtime',
		'export * from "./.__kody_virtual__/runtime.js";',
	],
	[
		'a namespace import with a comment between tokens',
		'import * as/**/rt from "./.__kody_virtual__/runtime.js";\nrt["__kodyCreate" + "PackageBoundSecrets"]("pkg-other");',
	],
	[
		'a namespace import with an escaped specifier',
		'import * as rt from "./.__kody\\u005fvirtual__/runtime.js";\nrt["__kodyCreate" + "PackageBoundSecrets"]("pkg-other");',
	],
	[
		'an escaped specifier on a named import',
		'import { __kodyCreatePackageBoundSecrets } from "./.\\x5f_kody_virtual__/runtime.js";\n__kodyCreatePackageBoundSecrets("pkg-1");',
	],
	[
		'a string import name',
		'import { "__kodyCreatePackageBoundSecrets" as f } from "./.__kody_virtual__/runtime.js";\nf("pkg-other");',
	],
	[
		'a string import name kept as a creator name',
		'import { "__kodyCreatePackageBoundSecrets" as __kodyCreatePackageBoundSecrets } from "./.__kody_virtual__/runtime.js";\n__kodyCreatePackageBoundSecrets("pkg-1");',
	],
	[
		'a namespace re-export with a comment between tokens',
		'export * as/**/rt from "./.__kody_virtual__/runtime.js";',
	],
	[
		'a named re-export of the runtime',
		'export { __kodyCreatePackageBoundSecrets as s } from "./.__kody_virtual__/runtime.js";',
	],
	[
		'a literal dynamic import of the runtime',
		'const rt = await import("./.__kody_virtual__/runtime.js");',
	],
	[
		'a template dynamic import of the runtime',
		'const rt = await import(`./.__kody_virtual__/runtime.js`);',
	],
	[
		'a computed require',
		'const p = "./.__kody_" + "virtual__/runtime.js";\nrequire(p);',
	],
	[
		'an absolute path to the runtime',
		'import { __kodyCreatePackageBoundSecrets } from "/.__kody_virtual__/runtime.js";\n__kodyCreatePackageBoundSecrets("pkg-1");',
	],
	[
		'a percent-encoded path to the runtime',
		'import * as rt from "./.%5F%5Fkody_virtual__/runtime.js";',
	],
	[
		'a creator call with a computed id',
		'import { __kodyCreatePackageBoundSecrets } from "./.__kody_virtual__/runtime.js";\nconst id = "pkg-" + "other";\n__kodyCreatePackageBoundSecrets(id);',
	],
	[
		'a creator call with an extra argument',
		'import { __kodyCreatePackageBoundSecrets } from "./.__kody_virtual__/runtime.js";\n__kodyCreatePackageBoundSecrets("pkg-1", "pkg-other");',
	],
	[
		'a creator re-exported by name',
		'import { __kodyCreatePackageBoundSecrets } from "./.__kody_virtual__/runtime.js";\nexport { __kodyCreatePackageBoundSecrets };',
	],
	[
		'a creator passed as a value',
		'import { __kodyCreatePackageBoundSecrets } from "./.__kody_virtual__/runtime.js";\nexport const all = { __kodyCreatePackageBoundSecrets };',
	],
	[
		'a creator called through a comma expression',
		'import { __kodyCreatePackageBoundSecrets } from "./.__kody_virtual__/runtime.js";\n(0, __kodyCreatePackageBoundSecrets)("pkg-other");',
	],
	[
		'a creator called as a tagged template',
		'import { __kodyCreatePackageBoundSecrets } from "./.__kody_virtual__/runtime.js";\n__kodyCreatePackageBoundSecrets`pkg-other`;',
	],
	[
		'a creator called with an escaped id',
		'import { __kodyCreatePackageBoundSecrets } from "./.__kody_virtual__/runtime.js";\n__kodyCreatePackageBoundSecrets("pkg\\u002dother");',
	],
] as const) {
	test(`binding checks refuse ${label}`, async () => {
		const uploaded = await uploadedTarget({ 'index.js': source })
		await expect(
			verifyUploadedTargetModules({
				uploaded,
				modules: { 'index.js': source },
				ownPackageId: 'pkg-1',
				linkedImports: new Map(),
			}),
		).rejects.toBeInstanceOf(PublishBuildVerificationError)
	})
}

test('a module re-exporting the runtime namespace is refused even when another module reads it', async () => {
	const modules = {
		'index.js':
			'import { rt } from "./a.js";\nexport default rt["__kodyCreate" + "PackageBoundSecrets"]("pkg-other");',
		'a.js': 'export * as/**/rt from "./.__kody_virtual__/runtime.js";',
	}
	const uploaded = await uploadedTarget(modules)
	await expect(
		verifyUploadedTargetModules({
			uploaded,
			modules,
			ownPackageId: 'pkg-1',
			linkedImports: new Map(),
		}),
	).rejects.toThrow(/re-exports a Kody platform module/)
})

test('CommonJS uploads are refused', async () => {
	const module = { cjs: 'module.exports = 1' }
	const bytes = workerLoaderModuleBytes(module)
	const uploaded = await uploadedTarget({})
	uploaded.modules['index.js'] = {
		sha256: await sha256Hex(bytes),
		size: bytes.byteLength,
		chunks: [],
	}
	await expect(
		verifyUploadedTargetModules({
			uploaded,
			modules: { 'index.js': module },
			ownPackageId: 'pkg-1',
			linkedImports: new Map(),
		}),
	).rejects.toThrow(/CommonJS/)
})

test('binding checks accept the bundler output for the package itself', async () => {
	const source = [
		'import __kodyBaseRuntimeDefault, { __kodyCreatePackageBoundStorage, __kodyCreatePackageBoundFetch, __kodyCreatePackageBoundKody as __kodyCreatePackageBoundKody2 } from "./.__kody_virtual__/runtime.js";',
		'var __kodyBoundFetch = __kodyCreatePackageBoundFetch("pkg-1");',
		'var kody = __kodyCreatePackageBoundKody2("pkg-1");',
		'var packageStorage = __kodyCreatePackageBoundStorage("pkg-1");',
		'const literal = await import("node:buffer");',
		'export default 1;',
	].join('\n')
	const uploaded = await uploadedTarget({ 'index.js': source })
	await expect(
		verifyUploadedTargetModules({
			uploaded,
			modules: { 'index.js': source },
			ownPackageId: 'pkg-1',
			linkedImports: new Map(),
		}),
	).resolves.toEqual({
		totalBytes: 444,
		referencedLinkedImports: new Set(),
	})
})

const linkedNotes = '.__kody_linked__/@them__notes/list.js'
const linkedImports = new Map([[linkedNotes, 'kody:@them/notes/list']])

test('an upload may import the linked placeholders the source imports', async () => {
	const source = [
		'import list from "./.__kody_linked__/@them__notes/list.js";',
		'export default async () => await list();',
	].join('\n')
	const uploaded = await uploadedTarget({ 'index.js': source })
	const result = await verifyUploadedTargetModules({
		uploaded,
		modules: { 'index.js': source },
		ownPackageId: 'pkg-1',
		linkedImports,
	})
	expect([...result.referencedLinkedImports]).toEqual([linkedNotes])
})

test('an upload may use linked placeholders as namespaces, re-exports and dynamic imports', async () => {
	const source = [
		'import * as notes from "./.__kody_linked__/@them__notes/list.js";',
		'export * from "./.__kody_linked__/@them__notes/list.js";',
		'export const keys = () => Object.keys(notes);',
		'export const load = () => import("./.__kody_linked__/@them__notes/list.js");',
	].join('\n')
	const uploaded = await uploadedTarget({ 'index.js': source })
	const result = await verifyUploadedTargetModules({
		uploaded,
		modules: { 'index.js': source },
		ownPackageId: 'pkg-1',
		linkedImports,
	})
	expect([...result.referencedLinkedImports]).toEqual([linkedNotes])
})

for (const [label, modules, message] of [
	[
		'inlined dependency code (another package bound by id)',
		{
			'index.js': [
				'import { __kodyCreatePackageBoundStorage } from "./.__kody_virtual__/runtime.js";',
				'var packageStorage = __kodyCreatePackageBoundStorage("pkg-them");',
				'export default async () => await packageStorage().get("secret-notes");',
			].join('\n'),
		},
		/package "pkg-them", not this package/,
	],
	[
		"another package's runtime facade",
		{
			'index.js':
				'import { packageSecrets } from "./.__kody_virtual__/package-runtime/70.js";\nexport default packageSecrets;',
		},
		/not part of this package/,
	],
	[
		'a placeholder the source does not import',
		{
			'index.js':
				'import x from "./.__kody_linked__/@them__other/x.js";\nexport default x;',
		},
		/not a Kody package this source imports/,
	],
	[
		"a linked artifact's internals",
		{
			'index.js':
				'import x from "./.__kody_linked__/artifacts/a/b/index.js";\nexport default x;',
		},
		/not a Kody package this source imports/,
	],
	[
		'a module uploaded at a linked placeholder path',
		{
			'index.js':
				'import list from "./.__kody_linked__/@them__notes/list.js";\nexport default list;',
			[linkedNotes]:
				'import { __kodyCreatePackageBoundStorage } from "../.__kody_virtual__/runtime.js";\nexport default () => __kodyCreatePackageBoundStorage("pkg-1");',
		},
		/linked by Kody and cannot come from a build/,
	],
	[
		'a Kody package import the builder did not link',
		{
			'index.js':
				'import list from "kody:@them/notes/list";\nexport default list;',
		},
		/still imports "kody:@them\/notes\/list"/,
	],
	[
		'a forged metered proxy',
		{
			'index.js':
				'import { __kodyMeterStaticPackageExport } from "./.__kody_virtual__/runtime.js";\nexport default __kodyMeterStaticPackageExport("pkg-them", () => 1);',
		},
		/reserved runtime name __kodyMeterStaticPackageExport/,
	],
] as const) {
	test(`an upload is refused for ${label}`, async () => {
		const uploaded = await uploadedTarget(modules)
		await expect(
			verifyUploadedTargetModules({
				uploaded,
				modules: { ...modules },
				ownPackageId: 'pkg-1',
				linkedImports,
			}),
		).rejects.toThrow(message)
	})
}

test('targets that share a build must upload the same bytes', () => {
	const upload = (sha256: string): PublishBuildTargetEntry => ({
		kind: 'job',
		bundleKind: 'module',
		artifactName: 'daily',
		entryPoint: 'src/job.ts',
		mainModule: 'bundle.js',
		modules: { 'bundle.js': { sha256, size: 10, chunks: [sha256] } },
	})
	expect(() =>
		assertSameBuildUploadMatches({ kept: upload('a'), uploaded: upload('a') }),
	).not.toThrow()
	expect(() =>
		assertSameBuildUploadMatches({ kept: upload('a'), uploaded: upload('b') }),
	).toThrow(PublishBuildVerificationError)
})
