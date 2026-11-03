import { expect, test } from 'vitest'
import {
	hashWorkerLoaderModules,
	sha256Hex,
	workerLoaderModuleBytes,
} from './module-hashes.ts'
import type { PublishBuildTargetEntry } from './types.ts'
import {
	PublishBuildVerificationError,
	assertInlinedDependenciesWritable,
	assertServerRebuildMatches,
	matchUploadedTargets,
	pickServerRebuildSample,
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
	).toHaveLength(1)
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
	const uploaded = await uploadedTarget({ 'index.js': 'export default 1' })
	await expect(
		verifyUploadedTargetModules({
			uploaded,
			modules: { 'index.js': 'export default 1' },
			ownPackageId: 'pkg-1',
			allowedActsAsPackageIds: new Set(['pkg-1']),
		}),
	).resolves.not.toThrow()
	await expect(
		verifyUploadedTargetModules({
			uploaded,
			modules: { 'index.js': 'export default "evil"' },
			ownPackageId: 'pkg-1',
			allowedActsAsPackageIds: new Set(['pkg-1']),
		}),
	).rejects.toBeInstanceOf(PublishBuildVerificationError)
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
				allowedActsAsPackageIds: new Set(['pkg-1']),
			}),
		).rejects.toBeInstanceOf(PublishBuildVerificationError)
	}
	const noMain = await uploadedTarget({ 'other.js': 'a' })
	await expect(
		verifyUploadedTargetModules({
			uploaded: noMain,
			modules: { 'other.js': 'a' },
			ownPackageId: 'pkg-1',
			allowedActsAsPackageIds: new Set(['pkg-1']),
		}),
	).rejects.toThrow(/main module/i)
})

test('an outside build may only inline packages the publisher can write', () => {
	const dependencies = [
		{ packageId: 'pkg-mine', packageName: '@me/dep', kodyId: 'k1' },
		{ packageId: 'pkg-theirs', packageName: '@them/dep', kodyId: 'k2' },
	]
	expect(() =>
		assertInlinedDependenciesWritable({
			entryPoint: 'src/index.ts',
			ownPackageId: 'pkg-1',
			dependencies: dependencies.slice(0, 1) as never,
			writablePackageIds: new Set(['pkg-mine']),
		}),
	).not.toThrow()
	expect(() =>
		assertInlinedDependenciesWritable({
			entryPoint: 'src/index.ts',
			ownPackageId: 'pkg-1',
			dependencies: dependencies as never,
			writablePackageIds: new Set(['pkg-mine']),
		}),
	).toThrow(/@them\/dep|pkg-theirs/)
})

test('the server rebuild sample must hash the same as the upload', async () => {
	const uploaded = await uploadedTarget({ 'index.js': 'export default 1' })
	const same = await hashWorkerLoaderModules({ 'index.js': 'export default 1' })
	expect(() =>
		assertServerRebuildMatches({
			uploaded,
			rebuilt: { mainModule: 'index.js', moduleHashes: same },
		}),
	).not.toThrow()
	const different = await hashWorkerLoaderModules({
		'index.js': 'export default 2',
	})
	expect(() =>
		assertServerRebuildMatches({
			uploaded,
			rebuilt: { mainModule: 'index.js', moduleHashes: different },
		}),
	).toThrow(PublishBuildVerificationError)
})

test('the rebuild sample takes the smallest targets up to the sample size', async () => {
	const small = { uploaded: await uploadedTarget({ 'index.js': 'a' }) }
	const big = {
		uploaded: await uploadedTarget({ 'index.js': 'a'.repeat(1000) }),
	}
	expect(pickServerRebuildSample([big, small], 1)).toEqual([small])
	expect(pickServerRebuildSample([big, small], 3)).toHaveLength(2)
})
