import { expect, test } from 'vitest'
import { createKodyIgnoreMatcher, omitKodyIgnoredFiles } from './kodyignore.ts'

test('createKodyIgnoreMatcher uses gitignore syntax and never ignores package.json or itself', () => {
	expect(createKodyIgnoreMatcher(null)).toBeNull()
	expect(createKodyIgnoreMatcher('  \n')).toBeNull()
	const isIgnored = createKodyIgnoreMatcher(
		[
			'# fixtures and notes',
			'fixtures/',
			'*.data.ts',
			'!keep.data.ts',
			'*',
			'!src/',
		].join('\n'),
	)
	expect(isIgnored).not.toBeNull()
	const ignoredByFixtures = createKodyIgnoreMatcher(
		'fixtures/\n*.data.ts\n!keep.data.ts',
	)!
	expect(ignoredByFixtures('fixtures/a/b.ts')).toBe(true)
	expect(ignoredByFixtures('src/big.data.ts')).toBe(true)
	expect(ignoredByFixtures('keep.data.ts')).toBe(false)
	expect(ignoredByFixtures('src/index.ts')).toBe(false)
	expect(isIgnored!('package.json')).toBe(false)
	expect(isIgnored!('.kodyignore')).toBe(false)
})

test('omitKodyIgnoredFiles drops matches under the source root only', () => {
	const files = {
		'README.md': '# repo',
		'tools/fixtures/x.ts': 'outside root',
		'pkg/.kodyignore': 'fixtures/\n',
		'pkg/package.json': '{}',
		'pkg/src/index.ts': 'export default 1',
		'pkg/fixtures/big.ts': 'ignored',
	}
	expect(Object.keys(omitKodyIgnoredFiles(files, '/pkg/')).sort()).toEqual([
		'README.md',
		'pkg/.kodyignore',
		'pkg/package.json',
		'pkg/src/index.ts',
		'tools/fixtures/x.ts',
	])
	const noIgnoreFile = { 'src/index.ts': 'x' }
	expect(omitKodyIgnoredFiles(noIgnoreFile)).toBe(noIgnoreFile)
})
