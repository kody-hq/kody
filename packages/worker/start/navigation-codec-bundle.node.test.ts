import { build } from 'esbuild'
import { expect, test } from 'vitest'

test('eager URL codecs do not evaluate connection or credential editor schemas', async () => {
	const result = await build({
		entryPoints: [
			'packages/worker/start/connect-input.ts',
			'packages/worker/universal/credential-contracts.ts',
			'packages/worker/universal/document-head.ts',
		],
		bundle: true,
		write: false,
		outdir: '.tmp/navigation-codec-bundle',
		platform: 'browser',
		format: 'esm',
		metafile: true,
	})
	const inputs = Object.keys(result.metafile!.inputs)
	expect(inputs.some((input) => input.includes('/zod/'))).toBe(false)
	expect(
		inputs.some((input) => input.endsWith('/connect-input-schema.ts')),
	).toBe(false)
	expect(
		inputs.some((input) =>
			input.endsWith('/credential-fill-placement-input.ts'),
		),
	).toBe(false)
})
