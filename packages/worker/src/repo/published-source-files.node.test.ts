import { expect, test } from 'vitest'
import { repoRelativeSourceFiles } from './published-source-files.ts'

const nested = {
	manifest_path: 'packages/demo/package.json',
	source_root: '/packages/demo/',
}

test('repoRelativeSourceFiles re-keys source-root files and keeps repo-root files', () => {
	expect(
		repoRelativeSourceFiles({
			source: nested,
			files: { 'package.json': '{}', 'src/index.ts': 'x' },
		}),
	).toEqual({
		'packages/demo/package.json': '{}',
		'packages/demo/src/index.ts': 'x',
	})
	const repoRelative = {
		'packages/demo/package.json': '{}',
		'packages/demo/src/index.ts': 'x',
	}
	expect(repoRelativeSourceFiles({ source: nested, files: repoRelative })).toBe(
		repoRelative,
	)
	const rootPackage = { 'package.json': '{}' }
	expect(
		repoRelativeSourceFiles({
			source: { manifest_path: 'package.json', source_root: '/' },
			files: rootPackage,
		}),
	).toBe(rootPackage)
})
