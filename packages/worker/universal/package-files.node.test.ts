import { expect, test } from 'vitest'
import { bytesToLatin1String } from './package-file-media.ts'
import {
	buildPackageFilesAncestors,
	buildPackageFilesApiHref,
	buildPackageFilesView,
	findDirectoryReadmePath,
	getAccountPackageFilesHref,
	getCommunityPackageFilesHref,
	getCommunityPackageRawHref,
	getPackageSettingsHref,
	getPackageTreeHref,
	isReservedPackageFilesKodyId,
	joinPackageFilesPath,
	listPackageFilesChildren,
	normalizePackageFilesPath,
} from './package-files.ts'

const files = {
	'README.md': '# Hello\n\n## Intent\n\nDo a thing.',
	'package.json': '{"name":"@owner/demo"}',
	'src/index.ts': 'export const answer = 42\n',
	'src/lib/util.ts':
		'export function add(a: number, b: number) { return a + b }\n',
	'docs/guide.md': '# Guide\n',
}

test('package files views normalize paths and distinguish root, directories, files, and misses', () => {
	const paths: Array<[string | null, string | null]> = [
		[null, ''],
		['', ''],
		['/', ''],
		['src/index.ts', 'src/index.ts'],
		['/src/lib/util.ts/', 'src/lib/util.ts'],
		['src/%2E%2E/secrets', null],
		['../package.json', null],
		['src\\index.ts', null],
		['src/%2Findex.ts', 'src/index.ts'],
	]
	expect(
		paths.map(([path]) => [path, normalizePackageFilesPath(path)]),
	).toEqual(paths)

	const root = buildPackageFilesView({ files, selectedPath: '' })
	expect(root).toMatchObject({
		kind: 'directory',
		selectedPath: '',
		contentPath: 'README.md',
		contentKind: 'markdown',
	})
	expect(root?.children.map((child) => child.name)).toEqual([
		'docs',
		'src',
		'package.json',
		'README.md',
	])

	const src = buildPackageFilesView({ files, selectedPath: 'src' })
	expect(src).toMatchObject({
		kind: 'directory',
		contentPath: null,
		content: null,
	})
	expect(src?.children).toEqual([
		{ name: 'lib', path: 'src/lib', kind: 'directory' },
		{ name: 'index.ts', path: 'src/index.ts', kind: 'file' },
	])

	const file = buildPackageFilesView({ files, selectedPath: 'src/index.ts' })
	expect(file).toMatchObject({
		kind: 'file',
		content: 'export const answer = 42\n',
		contentPath: 'src/index.ts',
		contentKind: 'code',
		language: 'ts',
	})

	const pngBytes = Uint8Array.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1,
	])
	const png = bytesToLatin1String(pngBytes)
	const image = buildPackageFilesView({
		files: { ...files, 'docs/logo.png': png },
		selectedPath: 'docs/logo.png',
	})
	expect(image).toMatchObject({
		kind: 'file',
		content: null,
		contentKind: 'image',
		language: null,
		contentByteLength: pngBytes.byteLength,
	})
	expect(
		buildPackageFilesView({
			files: { 'app.wasm': 'wasm\0module' },
			selectedPath: 'app.wasm',
		}),
	).toMatchObject({
		kind: 'file',
		content: null,
		contentKind: 'binary',
	})
	expect(
		buildPackageFilesView({
			files: { 'evil.svg': '<!DOCTYPE html><script>alert(1)</script>' },
			selectedPath: 'evil.svg',
		}),
	).toMatchObject({
		kind: 'file',
		content: '<!DOCTYPE html><script>alert(1)</script>',
		contentKind: 'code',
		language: 'xml',
	})

	for (const selectedPath of [
		'missing',
		'constructor',
		'toString',
		'__proto__',
	]) {
		expect(buildPackageFilesView({ files, selectedPath })).toBeNull()
	}
	expect(buildPackageFilesView({ files: {}, selectedPath: '' })?.kind).toBe(
		'directory',
	)
	expect(
		buildPackageFilesView({
			files: { constructor: 'export {}\n' },
			selectedPath: 'constructor',
		}),
	).toMatchObject({
		kind: 'file',
		content: 'export {}\n',
	})

	expect(findDirectoryReadmePath(files, '')).toBe('README.md')
	expect(findDirectoryReadmePath(files, 'docs')).toBeNull()
	expect(listPackageFilesChildren(Object.keys(files), 'docs')).toEqual([
		{ name: 'guide.md', path: 'docs/guide.md', kind: 'file' },
	])
	expect(
		buildPackageFilesAncestors('src/lib/util.ts').map((entry) => entry.name),
	).toEqual(['src', 'lib', 'util.ts'])
})

test('files hrefs use the default-branch fallback and avoid reserved kody ids', () => {
	expect(isReservedPackageFilesKodyId('packages')).toBe(true)
	expect(isReservedPackageFilesKodyId('devin')).toBe(false)
	const listing = (kodyId: string) => ({
		listingId: 'listing-1',
		ownerUsername: 'kentcdodds',
		kodyId,
	})
	expect([
		getCommunityPackageFilesHref({
			...listing('devin'),
			relativePath: 'src/index.ts',
		}),
		getCommunityPackageFilesHref({ ...listing('devin'), ref: 'HEAD' }),
		getCommunityPackageFilesHref({ ...listing('devin'), ref: 'release' }),
		getCommunityPackageFilesHref({
			...listing('packages'),
			relativePath: 'src/index.ts',
		}),
		getAccountPackageFilesHref({ packageId: 'pkg-1' }),
		getPackageTreeHref({ username: 'kentcdodds', kodyId: 'friction-log' }),
		getPackageTreeHref({
			username: 'kentcdodds',
			kodyId: 'grok-bot',
			listingId: 'listing-1',
			ref: 'develop',
		}),
		getPackageTreeHref({
			username: 'kentcdodds',
			kodyId: 'packages',
			listingId: 'listing-1',
			ref: 'develop',
		}),
		getPackageSettingsHref({ username: 'kentcdodds', kodyId: 'friction-log' }),
		joinPackageFilesPath('/@kentcdodds/devin/tree/main', 'src/index.ts'),
		buildPackageFilesApiHref(
			'/profiles/kentcdodds/packages/devin/files.json',
			'src/index.ts',
		),
		getCommunityPackageRawHref({
			...listing('devin'),
			relativePath: 'docs/logo.png',
		}),
		getCommunityPackageRawHref({
			...listing('packages'),
			relativePath: 'docs/logo.png',
		}),
	]).toEqual([
		'/@kentcdodds/devin/tree/main/src/index.ts',
		'/@kentcdodds/devin/tree/main',
		'/@kentcdodds/devin/tree/release',
		'/community/listing-1/files/src/index.ts',
		'/account/packages/pkg-1/files',
		'/@kentcdodds/friction-log/tree/main',
		'/@kentcdodds/grok-bot/tree/develop',
		'/community/listing-1/files',
		'/@kentcdodds/friction-log/settings',
		'/@kentcdodds/devin/tree/main/src/index.ts',
		'/profiles/kentcdodds/packages/devin/files.json?path=src%2Findex.ts',
		'/@kentcdodds/devin/raw/main/docs/logo.png',
		'/community/listing-1/raw/docs/logo.png',
	])
})
