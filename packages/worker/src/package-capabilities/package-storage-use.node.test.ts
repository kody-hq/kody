import { expect, test } from 'vitest'
import {
	findPackageStorageMatchesInSource,
	sourceFilesUsePackageStorage,
} from './package-storage-use.ts'

test('real packageStorage and storageQuery calls still count', () => {
	expect(
		sourceFilesUsePackageStorage({
			'src/index.ts':
				'import { packageStorage } from "kody:runtime"\nawait packageStorage().get("x")',
		}),
	).toBe(true)
	expect(
		sourceFilesUsePackageStorage({
			'src/index.ts': 'await kody.storageQuery({ storage_id: id, sql })',
		}),
	).toBe(true)
	expect(
		sourceFilesUsePackageStorage({
			'src/index.ts': "const op = 'storage' + 'Query'\nawait kody?.[op]({})",
		}),
	).toBe(true)
})

test('bracket-key dynamic access still counts even though the name is quoted', () => {
	expect(
		sourceFilesUsePackageStorage({
			'src/index.ts': 'await runtime["packageStorage"]().get("x")',
		}),
	).toBe(true)
	expect(
		sourceFilesUsePackageStorage({
			'src/index.ts': "await runtime['storageExport']({})",
		}),
	).toBe(true)
})

test('string and template prose does not count, including generated asset blobs', () => {
	expect(
		sourceFilesUsePackageStorage({
			'app/assets.generated.ts':
				'export const assets = { "index.html": { text: `<pre>import { packageStorage } from "kody:runtime"</pre>` } }',
		}),
	).toBe(false)
	expect(
		sourceFilesUsePackageStorage({
			'src/slides.ts':
				'const demo = "await packageStorage().get(\\"sinceId\\")"\nexport const html = demo',
		}),
	).toBe(false)
	expect(
		sourceFilesUsePackageStorage({
			'src/doc.ts': 'export const tip = `use storageQuery carefully`',
		}),
	).toBe(false)
})

test('browser storage and type declarations still do not count', () => {
	expect(
		sourceFilesUsePackageStorage({
			'app/game.ts': "localStorage.setItem('hi', '1')",
			'types/runtime.d.ts': 'export declare function packageStorage(): unknown',
			'README.md': 'Uses packageStorage() for nothing.',
		}),
	).toBe(false)
})

test('matches report file and line for code identifiers', () => {
	const source = [
		'import { createAuthenticatedFetch } from "kody:runtime"',
		'export async function main() {',
		'\tconst store = packageStorage()',
		'\treturn store',
		'}',
	].join('\n')
	const matches = findPackageStorageMatchesInSource('app/router.ts', source)
	expect(matches).toEqual([
		expect.objectContaining({
			path: 'app/router.ts',
			line: 3,
			pattern: 'packageStorage',
		}),
	])
})

test('template literal expressions still count; surrounding text does not', () => {
	expect(
		sourceFilesUsePackageStorage({
			'src/x.ts': 'const a = `hello ${packageStorage().get("x")} world`',
		}),
	).toBe(true)
	expect(
		sourceFilesUsePackageStorage({
			'src/x.ts': 'const a = `hello packageStorage() world`',
		}),
	).toBe(false)
})
