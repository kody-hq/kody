import { expect, test } from 'vitest'
import {
	getPackageAppAssetsDirectory,
	parseAuthoredPackageJson,
} from '#worker/package-registry/manifest.ts'
import {
	resolvePackageAppAssetSourcePath,
	validatePackageAppAssetsDirectory,
} from './package-app-assets-directory.ts'

const sourceFiles = {
	'package.json': '{}',
	'src/app.ts': 'export default {}',
	'public/index.css': 'body {}',
	'public/img/logo.png': 'png',
	'public-extra/other.txt': 'not inside public',
}

test('getPackageAppAssetsDirectory normalizes ./ prefixes and trailing slashes', () => {
	const parse = (assets: string) =>
		getPackageAppAssetsDirectory(
			parseAuthoredPackageJson({
				content: JSON.stringify({
					name: '@kentcdodds/demo',
					exports: {},
					kody: {
						id: 'demo',
						description: 'Demo',
						app: { entry: './src/app.ts', assets },
					},
				}),
			}),
		)
	expect(parse('./public/')).toBe('public')
	expect(parse('public/static')).toBe('public/static')
	expect(parse('./')).toBeNull()
})

test('validatePackageAppAssetsDirectory accepts populated subdirectories and rejects roots, node_modules, and empty directories', () => {
	expect(
		validatePackageAppAssetsDirectory({ assetsDirectory: null, sourceFiles }),
	).toEqual({ ok: true, message: 'No kody.app.assets directory declared.' })
	expect(
		validatePackageAppAssetsDirectory({
			assetsDirectory: 'public',
			sourceFiles,
		}),
	).toEqual({
		ok: true,
		message: 'kody.app.assets serves 2 file(s) from "public".',
	})
	for (const assetsDirectory of [
		'.',
		'node_modules',
		'node_modules/x',
		'../x',
	]) {
		const result = validatePackageAppAssetsDirectory({
			assetsDirectory,
			sourceFiles,
		})
		expect({ assetsDirectory, ok: result.ok }).toEqual({
			assetsDirectory,
			ok: false,
		})
		expect(result.message).toContain('must name a subdirectory')
	}
	const missing = validatePackageAppAssetsDirectory({
		assetsDirectory: 'static',
		sourceFiles,
	})
	expect(missing.ok).toBe(false)
	expect(missing.message).toContain('no files exist under that directory')
})

test('validatePackageAppAssetsDirectory rejects root files the platform answers itself', () => {
	const withReserved = {
		...sourceFiles,
		'public/__version.json': '{}',
		'public/client.0123456789abcdef.js': 'x',
		'public/client.production.js': 'fine',
		'public/nested/client.0123456789abcdef.js': 'fine too',
	}
	const withClient = validatePackageAppAssetsDirectory({
		assetsDirectory: 'public',
		sourceFiles: withReserved,
		clientDeclared: true,
	})
	expect(withClient.ok).toBe(false)
	expect(withClient.message).toContain('"public/__version.json"')
	expect(withClient.message).toContain('"public/client.0123456789abcdef.js"')
	expect(withClient.message).not.toContain('client.production.js')
	expect(withClient.message).not.toContain('nested/')

	// Without a declared client the module namespace is not reserved, but
	// the version JSON always is.
	const withoutClient = validatePackageAppAssetsDirectory({
		assetsDirectory: 'public',
		sourceFiles: withReserved,
	})
	expect(withoutClient.ok).toBe(false)
	expect(withoutClient.message).toContain('"public/__version.json"')
	expect(withoutClient.message).not.toContain('client.0123456789abcdef.js')

	const clean = validatePackageAppAssetsDirectory({
		assetsDirectory: 'public',
		sourceFiles: {
			...sourceFiles,
			'public/client.production.js': 'fine',
			'public/nested/__version.json': 'fine too',
		},
		clientDeclared: true,
	})
	expect(clean.ok).toBe(true)
})

test('resolvePackageAppAssetSourcePath blocks traversal and malformed segments', () => {
	const resolve = (relativePath: string) =>
		resolvePackageAppAssetSourcePath({
			assetsDirectory: 'public',
			relativePath,
		})
	expect(resolve('img/logo.png')).toBe('public/img/logo.png')
	expect(resolve('')).toBeNull()
	expect(resolve('../package.json')).toBeNull()
	expect(resolve('img/../../src/app.ts')).toBeNull()
	expect(resolve('./index.css')).toBeNull()
	expect(resolve('img//logo.png')).toBeNull()
	expect(resolve('img\\logo.png')).toBeNull()
	expect(resolve('a\0b')).toBeNull()
})
