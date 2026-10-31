import assert from 'node:assert/strict'
import { posix } from 'node:path'
import { test } from 'node:test'
import {
	examplePath,
	isAbsolute,
	isWithin,
	plainPath,
	samePath,
} from '../src/execution-context/fs-access.js'
import { createHostFsPromisesSource } from '../src/host-fs-shim.js'

test('Windows host paths: drive letters, UNC, and \\\\?\\ prefixes are absolute', () => {
	for (const path of [
		'C:\\Users\\me',
		'c:/Users/me',
		'\\\\server\\share\\dir',
		'//server/share/dir',
	])
		assert.equal(isAbsolute(path, 'win32'), true, path)
	for (const path of ['C:relative', 'relative\\dir', '\\\\.\\pipe\\x', '/tmp'])
		assert.equal(isAbsolute(path, 'win32'), false, path)
	assert.equal(plainPath('\\\\?\\C:\\Users\\me', 'win32'), 'C:\\Users\\me')
	assert.equal(
		plainPath('\\\\?\\UNC\\server\\share\\x', 'win32'),
		'\\\\server\\share\\x',
	)
	assert.equal(plainPath('\\\\?\\C:\\x', 'linux'), '\\\\?\\C:\\x')
	assert.equal(examplePath('win32'), 'C:\\Users\\you\\project')
	assert.equal(examplePath('linux'), '/absolute/path')
})

test('Windows containment is case-insensitive and separator-bounded', () => {
	assert.equal(
		isWithin('C:\\Users\\Me\\Repo\\a.txt', 'c:\\users\\me', 'win32'),
		true,
	)
	assert.equal(isWithin('C:\\USERS\\ME', 'c:\\users\\me', 'win32'), true)
	assert.equal(isWithin('C:\\Users\\Me2', 'C:\\Users\\Me', 'win32'), false)
	assert.equal(isWithin('D:\\Users\\Me', 'C:\\Users\\Me', 'win32'), false)
	assert.equal(isWithin('C:\\a', 'C:\\', 'win32'), true)
	assert.equal(
		isWithin('\\\\srv\\share\\dir\\f', '\\\\SRV\\Share\\dir', 'win32'),
		true,
	)
	assert.equal(samePath('C:\\A', 'c:\\a', 'win32'), true)
	assert.equal(samePath('/A', '/a', 'linux'), false)
	assert.equal(isWithin('/Users/Me/x', '/users/me', 'linux'), false)
})

function hostPathFn(platform: NodeJS.Platform) {
	const source = createHostFsPromisesSource({ routeRoots: ['/'], platform })
	const fn = source.match(
		/export function __kodyHostPath\(path\) \{[\s\S]*?\n\}/,
	)?.[0]
	assert.ok(fn, 'generated __kodyHostPath')
	return new Function(
		'posix',
		'routeRoots',
		'virtualRoots',
		'within',
		`${fn.replace('export ', '')}; return __kodyHostPath;`,
	)(
		posix,
		['/'],
		['/bundle', '/tmp', '/dev'],
		(path: string, root: string) =>
			path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`),
	) as (path: unknown) => string | null
}

test('the Windows host fs shim forwards native paths and leaves virtual roots alone', () => {
	const route = hostPathFn('win32')
	assert.equal(route('C:\\a\\b'), 'C:\\a\\b')
	assert.equal(route('C:/a/b'), 'C:\\a\\b')
	assert.equal(route('\\\\srv\\share\\x'), '\\\\srv\\share\\x')
	assert.equal(route('//srv/share/x'), '\\\\srv\\share\\x')
	assert.equal(route('\\\\?\\C:\\x'), '\\\\?\\C:\\x')
	assert.equal(route(new URL('file:///C:/a%20b/c')), 'C:\\a b\\c')
	assert.equal(route(new URL('file://srv/share/x')), '\\\\srv\\share\\x')
	for (const path of [
		'/tmp/x',
		'/bundle',
		'/dev/null',
		'\\\\.\\pipe\\x',
		'rel',
	])
		assert.equal(route(path), null, path)
})
