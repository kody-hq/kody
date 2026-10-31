import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	cachedMswPackagePath,
	cachedMswRoot,
	ensureMsw,
	importMsw,
	mswPackageSpec,
	mswPinnedVersion,
} from '../src/mock/ensure-msw.js'
import { StructuredCliError } from '../src/structured-error.js'

async function writeFakeMswInstall(
	root: string,
	contents: { version?: string } = {},
): Promise<string> {
	const packageDir = join(root, 'node_modules', 'msw')
	await mkdir(packageDir, { recursive: true })
	await writeFile(
		join(packageDir, 'package.json'),
		`${JSON.stringify(
			{
				name: 'msw',
				version: contents.version ?? mswPinnedVersion,
				type: 'module',
				main: './index.js',
				exports: { '.': './index.js' },
			},
			null,
			2,
		)}\n`,
	)
	await writeFile(
		join(packageDir, 'index.js'),
		`export const http = {}\nexport const HttpResponse = {}\n` +
			`export async function getResponse() { return undefined }\n` +
			`export function isPassthroughResponse() { return false }\n`,
	)
	return packageDir
}

test('ensureMsw returns cached package without installing', async () => {
	const cacheDir = await mkdtemp(join(tmpdir(), 'kody-msw-cached-'))
	try {
		const root = cachedMswRoot(cacheDir)
		await writeFakeMswInstall(root)
		const installs: Array<string> = []
		const packageDir = await ensureMsw({
			cacheDir,
			onInstall: (spec) => installs.push(spec),
			installInto: async () => {
				throw new Error('should not install when already cached')
			},
		})
		assert.equal(packageDir, cachedMswPackagePath(cacheDir))
		assert.deepEqual(installs, [])
		const mod = await importMsw({ cacheDir })
		assert.equal(typeof mod.getResponse, 'function')
	} finally {
		await rm(cacheDir, { recursive: true, force: true, maxRetries: 10 })
	}
})

test('ensureMsw installs into the Kody cache when missing', async () => {
	const cacheDir = await mkdtemp(join(tmpdir(), 'kody-msw-miss-'))
	try {
		const installs: Array<string> = []
		const packageDir = await ensureMsw({
			cacheDir,
			onInstall: (spec) => installs.push(spec),
			installInto: async (staging) => {
				await writeFakeMswInstall(staging)
			},
		})
		assert.deepEqual(installs, [mswPackageSpec])
		assert.equal(packageDir, cachedMswPackagePath(cacheDir))
		assert.equal(existsSync(join(packageDir, 'package.json')), true)
		// Warm path: no second install.
		const again = await ensureMsw({
			cacheDir,
			onInstall: (spec) => installs.push(`again:${spec}`),
			installInto: async () => {
				throw new Error('warm cache must not reinstall')
			},
		})
		assert.equal(again, packageDir)
		assert.deepEqual(installs, [mswPackageSpec])
	} finally {
		await rm(cacheDir, { recursive: true, force: true, maxRetries: 10 })
	}
})

test('ensureMsw reports a clear fix when install fails', async () => {
	const cacheDir = await mkdtemp(join(tmpdir(), 'kody-msw-fail-'))
	try {
		const installs: Array<string> = []
		await assert.rejects(
			() =>
				ensureMsw({
					cacheDir,
					onInstall: (spec) => installs.push(spec),
					installInto: async () => {
						throw new Error('ENOTFOUND registry.npmjs.org')
					},
				}),
			(error: unknown) => {
				assert.ok(error instanceof StructuredCliError)
				assert.equal(error.code, 'bundle_failed')
				assert.match(error.message, new RegExp(mswPackageSpec))
				assert.match(error.message, /ENOTFOUND/)
				assert.match(error.fix ?? '', /Connect to the network/)
				assert.match(error.fix ?? '', /KODY_CACHE_DIR/)
				assert.equal(error.target, 'mock')
				return true
			},
		)
		assert.deepEqual(installs, [mswPackageSpec])
		assert.equal(existsSync(cachedMswRoot(cacheDir)), false)
	} finally {
		await rm(cacheDir, { recursive: true, force: true, maxRetries: 10 })
	}
})
