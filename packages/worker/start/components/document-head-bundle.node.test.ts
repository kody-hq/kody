import { build } from 'esbuild'
import { expect, test } from 'vitest'

test('query head formatting does not load the page catalog', async () => {
	const result = await build({
		entryPoints: [
			'packages/worker/start/components/document-head.ts',
			'packages/worker/start/components/home-document-head.ts',
		],
		bundle: true,
		splitting: true,
		write: false,
		outdir: '.tmp/head-boundary-test',
		platform: 'browser',
		format: 'esm',
		metafile: true,
	})
	const outputs = result.metafile!.outputs
	const pending = Object.entries(outputs)
		.filter(
			([, output]) =>
				output.entryPoint ===
					'packages/worker/start/components/document-head.ts' ||
				output.entryPoint ===
					'packages/worker/start/components/home-document-head.ts',
		)
		.map(([path]) => path)
	const visited = new Set<string>()
	const eagerInputs = new Set<string>()
	while (pending.length) {
		const path = pending.pop()!
		if (visited.has(path)) continue
		visited.add(path)
		const output = outputs[path]!
		for (const input of Object.keys(output.inputs)) eagerInputs.add(input)
		for (const dependency of output.imports) {
			if (dependency.kind !== 'dynamic-import' && outputs[dependency.path])
				pending.push(dependency.path)
		}
	}
	expect(
		eagerInputs.has('packages/worker/universal/document-head-resolver.ts'),
	).toBe(false)
	expect(
		eagerInputs.has('packages/worker/universal/acquisition/metadata.ts'),
	).toBe(false)
})

test('the shared loader-data contract does not load unrelated runtime catalogs', async () => {
	const result = await build({
		entryPoints: ['packages/worker/universal/loader-data.ts'],
		bundle: true,
		write: false,
		platform: 'browser',
		format: 'esm',
		metafile: true,
	})
	expect(Object.keys(result.metafile!.inputs)).toEqual([
		'packages/worker/universal/loader-data.ts',
	])
})
