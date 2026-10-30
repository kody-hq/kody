import { expect, test } from 'vitest'
import {
	formatLargestNonRuntimePaths,
	largestNonRuntimePaths,
} from './publish-size-hints.ts'

test('largestNonRuntimePaths lists the biggest files runtime code does not import', () => {
	const files = {
		'README.md': '# repo\n',
		'pkg/package.json': JSON.stringify({
			name: '@example/demo',
			exports: { '.': './src/index.ts' },
			kody: { jobs: { nightly: { entry: './src/job.ts' } } },
		}),
		'pkg/.kodyignore': 'ignored/\n',
		'pkg/src/index.ts': [
			"import { helper } from './lib/helper.js'",
			"export * from './lib/reexported'",
			"const lazy = () => import('./lib/lazy.ts')",
			'export default async () => helper(lazy)',
		].join('\n'),
		'pkg/src/job.ts': 'export default async () => null',
		'pkg/src/lib/helper.ts': 'export const helper = (value: unknown) => value',
		'pkg/src/lib/reexported/index.ts': 'export const reexported = 1',
		'pkg/src/lib/lazy.ts': 'export default 1',
		'pkg/tools/generate.ts': 'x'.repeat(4096),
		'pkg/fixtures/sample.json': 'y'.repeat(2048),
		'pkg/ignored/huge.ts': 'z'.repeat(8192),
		'pkg/assets/icon.png': '\u00ff'.repeat(1024),
	}

	expect(largestNonRuntimePaths({ files, sourceRoot: '/pkg/' })).toEqual([
		{ path: 'tools/generate.ts', bytes: 4096 },
		{ path: 'fixtures/sample.json', bytes: 2048 },
		{ path: 'assets/icon.png', bytes: 1024 },
	])
	expect(
		largestNonRuntimePaths({ files, sourceRoot: 'pkg', limit: 1 }),
	).toEqual([{ path: 'tools/generate.ts', bytes: 4096 }])
})

test('formatLargestNonRuntimePaths names the files and .kodyignore', () => {
	expect(formatLargestNonRuntimePaths([])).toBe('')
	const message = formatLargestNonRuntimePaths([
		{ path: 'tools/generate.ts', bytes: 3 * 1024 * 1024 },
		{ path: 'fixtures/sample.json', bytes: 2048 },
	])
	expect(message).toContain('`tools/generate.ts` (3.0 MiB)')
	expect(message).toContain('`fixtures/sample.json` (2 KiB)')
	expect(message).toContain('`.kodyignore`')
})
