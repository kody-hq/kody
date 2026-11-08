import { expect, test } from 'vitest'
import { dualMajorNodeModulesFixture } from './node-modules-resolution.fixture.ts'
import {
	listNodeModulesPackageDirectories,
	parseBarePackageSpecifier,
	resolveNodeModulesImport,
	type NodeModulesImportKind,
} from './node-modules-resolution.ts'

function resolveIn(
	files: Record<string, string>,
	specifier: string,
	importerDirectory: string,
	kind: NodeModulesImportKind = 'import',
) {
	return resolveNodeModulesImport({
		specifier,
		importerDirectory,
		kind,
		fs: {
			readFile: (path) => files[path] ?? null,
			fileExists: (path) => Object.hasOwn(files, path),
		},
	})
}

test('nested node_modules wins over a hoisted second major', () => {
	const files = dualMajorNodeModulesFixture
	expect(resolveIn(files, 'codec/decode', 'node_modules/parser/esm')).toEqual({
		kind: 'resolved',
		path: 'node_modules/parser/node_modules/codec/dist/decode.js',
	})
	expect(resolveIn(files, 'codec/decode', 'node_modules/serializer')).toEqual({
		kind: 'resolved',
		path: 'node_modules/codec/lib/decode.js',
	})
	expect(resolveIn(files, 'codec/decode', '.__kody_root__/src')).toEqual({
		kind: 'resolved',
		path: 'node_modules/codec/lib/decode.js',
	})
})

test('scoped subpaths resolve nested first and honor export conditions', () => {
	const files = dualMajorNodeModulesFixture
	expect(
		resolveIn(files, '@scope/kit/util', 'node_modules/parser/esm'),
	).toEqual({
		kind: 'resolved',
		path: 'node_modules/parser/node_modules/@scope/kit/util.browser.js',
	})
	expect(resolveIn(files, '@scope/kit/util', 'src')).toEqual({
		kind: 'resolved',
		path: 'node_modules/@scope/kit/util.js',
	})
})

test('import vs require pick their exports condition', () => {
	const files = dualMajorNodeModulesFixture
	expect(
		resolveIn(files, 'codec/decode', 'node_modules/serializer', 'require'),
	).toEqual({ kind: 'resolved', path: 'node_modules/codec/lib/decode.cjs' })
	expect(
		resolveIn(files, 'codec/decode', 'node_modules/parser/esm', 'require'),
	).toEqual({
		kind: 'resolved',
		path: 'node_modules/parser/node_modules/codec/dist/decode.cjs',
	})
})

test('exports is authoritative: unexported subpaths error instead of falling back', () => {
	const files = dualMajorNodeModulesFixture
	const missing = resolveIn(files, 'codec', 'node_modules/parser/esm')
	expect(missing.kind).toBe('error')
	expect(missing.kind === 'error' && missing.message).toContain('codec')
	const missingTarget = resolveIn(
		{
			'node_modules/gone/package.json': JSON.stringify({
				exports: './missing.js',
			}),
		},
		'gone',
		'src',
	)
	expect(missingTarget.kind).toBe('error')
})

test('without exports, module beats main and subpaths use file/index lookup', () => {
	const files = {
		...dualMajorNodeModulesFixture,
		'node_modules/plain/package.json': JSON.stringify({ main: 'lib/main' }),
		'node_modules/plain/lib/main.js': '',
		'node_modules/plain/extra/index.js': '',
		'node_modules/bare/index.js': '',
	}
	expect(resolveIn(files, 'parser', 'src')).toEqual({
		kind: 'resolved',
		path: 'node_modules/parser/esm/index.js',
	})
	expect(resolveIn(files, 'plain', 'src')).toEqual({
		kind: 'resolved',
		path: 'node_modules/plain/lib/main.js',
	})
	expect(resolveIn(files, 'plain/extra', 'src')).toEqual({
		kind: 'resolved',
		path: 'node_modules/plain/extra/index.js',
	})
	expect(resolveIn(files, 'bare', 'src')).toEqual({
		kind: 'resolved',
		path: 'node_modules/bare/index.js',
	})
	expect(resolveIn(files, 'absent', 'src')).toEqual({ kind: 'not-found' })
})

test('ancestor walk skips node_modules/node_modules and keeps absolute roots', () => {
	expect(
		listNodeModulesPackageDirectories('node_modules/a/node_modules/b/lib', 'c'),
	).toEqual([
		'node_modules/a/node_modules/b/lib/node_modules/c',
		'node_modules/a/node_modules/b/node_modules/c',
		'node_modules/a/node_modules/c',
		'node_modules/c',
	])
	expect(listNodeModulesPackageDirectories('/repo/src', '@s/p')).toEqual([
		'/repo/src/node_modules/@s/p',
		'/repo/node_modules/@s/p',
		'/node_modules/@s/p',
	])
	expect(listNodeModulesPackageDirectories('C:/repo', 'p')).toEqual([
		'C:/repo/node_modules/p',
		'C:/node_modules/p',
	])
	expect(listNodeModulesPackageDirectories('', 'p')).toEqual(['node_modules/p'])
})

test('parseBarePackageSpecifier handles scopes, subpaths, and non-bare input', () => {
	expect(parseBarePackageSpecifier('@scope/kit/util')).toEqual({
		packageName: '@scope/kit',
		subpath: './util',
	})
	expect(parseBarePackageSpecifier('entities')).toEqual({
		packageName: 'entities',
		subpath: '.',
	})
	for (const specifier of ['./x', '/x', 'node:fs', 'kody:@a/b', '@scope', '']) {
		expect(parseBarePackageSpecifier(specifier)).toBeNull()
	}
})
