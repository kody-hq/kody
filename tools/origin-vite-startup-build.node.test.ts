import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	copyOriginViteBuildSnapshot,
	findOriginViteDeferredAssets,
	findTwoByteOriginServerModules,
} from './origin-vite-startup-build.ts'

test('classifies hashed Vite origin deferred assets', () => {
	expect(
		findOriginViteDeferredAssets([
			'guide-catalog-BKLgV76U.js',
			'worker-bundler-DkncWciV.js',
			'worker-bundler-typescript-CF82MPh-.js',
			'oauth-provider-DuOVB_DS.js',
			'esbuild-eina1h7z.wasm',
			'index.js',
			'account-area-Bk2HBZxv.js',
		]),
	).toEqual({
		guideCatalog: ['guide-catalog-BKLgV76U.js'],
		workerBundler: [
			'worker-bundler-DkncWciV.js',
			'worker-bundler-typescript-CF82MPh-.js',
		],
		oauthProvider: ['oauth-provider-DuOVB_DS.js'],
		esbuildWasm: ['esbuild-eina1h7z.wasm'],
	})
})

test('startup snapshot keeps the Vite client tree next to SSR wrangler.json', async () => {
	const sourceRoot = await mkdtemp(path.join(tmpdir(), 'origin-vite-source-'))
	const outputRoot = await mkdtemp(path.join(tmpdir(), 'origin-vite-snap-'))
	try {
		await mkdir(path.join(sourceRoot, 'dist', 'server', 'assets'), {
			recursive: true,
		})
		await mkdir(path.join(sourceRoot, 'dist', 'client', 'assets'), {
			recursive: true,
		})
		await writeFile(
			path.join(sourceRoot, 'dist', 'server', 'wrangler.json'),
			JSON.stringify({
				main: 'index.js',
				assets: { directory: '../client' },
			}),
		)
		await writeFile(
			path.join(sourceRoot, 'dist', 'client', 'index.html'),
			'<html></html>\n',
		)
		const snapshot = await copyOriginViteBuildSnapshot({
			sourceRoot,
			outputRoot,
		})
		expect(path.basename(snapshot.serverDir)).toBe('server')
		expect(path.basename(snapshot.clientDir)).toBe('client')
		const copied = JSON.parse(
			await readFile(path.join(snapshot.serverDir, 'wrangler.json'), 'utf8'),
		) as { assets: { directory: string } }
		expect(copied.assets.directory).toBe('../client')
		expect(
			await readFile(path.join(snapshot.clientDir, 'index.html'), 'utf8'),
		).toBe('<html></html>\n')
	} finally {
		await rm(sourceRoot, { recursive: true, force: true })
		await rm(outputRoot, { recursive: true, force: true })
	}
})

test('flags server modules whose source V8 would store as two bytes per character', () => {
	expect(
		findTwoByteOriginServerModules([
			{ name: 'index.js', source: 'const label="caf\u00e9"' },
			{ name: 'guide-catalog-BKLgV76U.js', source: 'const arrow="\u2192"' },
			{ name: 'account-area-Bk2HBZxv.js', source: 'const dash="\\u2014"' },
			{ name: 'pele.global-DGzcz58A.js', source: 'var pele="\u2026"' },
			{ name: 'json-preview.worker-BMF412N5.js', source: 'x="\u2026"' },
		]),
	).toEqual(['guide-catalog-BKLgV76U.js'])
})
