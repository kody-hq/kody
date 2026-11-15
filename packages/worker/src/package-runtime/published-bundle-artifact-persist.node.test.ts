import { expect, test } from 'vitest'
import type { WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import {
	bundleArtifactSha256,
	toDbRowInput,
} from './published-bundle-artifact-persist.ts'

test('bundleArtifactSha256 ignores module order and changes with any module content, path, or the main module', async () => {
	const data = new TextEncoder().encode('wasm').buffer
	const base = {
		mainModule: 'main.js',
		modules: {
			'main.js': 'export default 1',
			'dep.js': { js: 'export const a = 1' },
			'blob.bin': { data },
		},
	}
	const hash = await bundleArtifactSha256(base)
	expect(hash).toMatch(/^[0-9a-f]{64}$/)
	expect(
		await bundleArtifactSha256({
			mainModule: 'main.js',
			modules: {
				'blob.bin': { data },
				'dep.js': { js: 'export const a = 1' },
				'main.js': 'export default 1',
			},
		}),
	).toBe(hash)

	const variants: Array<{
		mainModule: string
		modules: WorkerLoaderModules
	}> = [
		{ ...base, mainModule: 'dep.js' },
		{ ...base, modules: { ...base.modules, 'main.js': 'export default 2' } },
		{
			...base,
			modules: { ...base.modules, 'dep.js': { cjs: 'export const a = 1' } },
		},
		{
			...base,
			modules: {
				...base.modules,
				'blob.bin': { data: new TextEncoder().encode('wasn').buffer },
			},
		},
		{
			mainModule: 'main.js',
			modules: {
				'main.js': 'export default 1',
				'other.js': { js: 'export const a = 1' },
				'blob.bin': { data },
			},
		},
	]
	for (const variant of variants) {
		expect(await bundleArtifactSha256(variant)).not.toBe(hash)
	}
})

test('toDbRowInput records cloud by default, the context name only for a context build, and unknown as null', () => {
	const row = {
		userId: 'user-1',
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		kind: 'module' as const,
		artifactName: null,
		entryPoint: 'src/index.ts',
		kvKey: 'kv-1',
		dependencies: [],
		totalBytes: 1,
		bundleSha256: 'aa',
	}
	expect(toDbRowInput(row)).toMatchObject({
		builtIn: 'cloud',
		builtContextName: null,
		bundleSha256: 'aa',
	})
	expect(
		toDbRowInput({
			...row,
			builtIn: { origin: 'context', contextName: 'laptop' },
		}),
	).toMatchObject({ builtIn: 'context', builtContextName: 'laptop' })
	expect(
		toDbRowInput({ ...row, builtIn: { origin: 'cli', contextName: 'x' } }),
	).toMatchObject({ builtIn: 'cli', builtContextName: null })
	expect(toDbRowInput({ ...row, builtIn: null })).toMatchObject({
		builtIn: null,
		builtContextName: null,
	})
})
