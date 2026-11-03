import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	ensureWorkerBundlerModules,
	leftoverSrcGeneratedBundlerNames,
	workerBundlerGeneratedDir,
	workerBundlerWranglerDir,
} from './build-worker-bundler-modules.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const leftoverSrcGeneratedDir = path.join(
	repoRoot,
	'packages/worker/src/generated',
)

async function pathExists(filePath: string) {
	try {
		await stat(filePath)
		return true
	} catch {
		return false
	}
}

test('ensureWorkerBundlerModules writes bundler artifacts outside the src watch root', async () => {
	await ensureWorkerBundlerModules()

	for (const name of [
		'worker-bundler.mjs',
		'worker-bundler-typescript.mjs',
		'oauth-provider.mjs',
		'local-execute-runtime-support.mjs',
		'isomorphic-git.mjs',
		'postal-mime.mjs',
		'codemode-normalize.mjs',
		'disposable-email-domains.mjs',
		'esbuild.wasm',
		'worker-bundler.stamp.json',
	] as const) {
		expect(await pathExists(path.join(workerBundlerGeneratedDir, name))).toBe(
			true,
		)
	}
	expect(
		await pathExists(
			path.join(workerBundlerGeneratedDir, 'package-app-remix.mjs'),
		),
	).toBe(false)
	for (const name of [
		'worker-bundler.mjs',
		'worker-bundler-typescript.mjs',
		'oauth-provider.mjs',
		'local-execute-runtime-support.mjs',
		'isomorphic-git.mjs',
		'postal-mime.mjs',
		'codemode-normalize.mjs',
		'disposable-email-domains.mjs',
		'esbuild.wasm',
	] as const) {
		expect(await pathExists(path.join(workerBundlerWranglerDir, name))).toBe(
			true,
		)
	}
	expect(
		await pathExists(
			path.join(workerBundlerWranglerDir, 'package-app-remix.mjs'),
		),
	).toBe(false)

	const generatedWasm = await readFile(
		path.join(workerBundlerGeneratedDir, 'esbuild.wasm'),
	)
	const wranglerWasm = await readFile(
		path.join(workerBundlerWranglerDir, 'esbuild.wasm'),
	)
	expect(generatedWasm.equals(wranglerWasm)).toBe(true)
})

test('isomorphic-git additional module polyfills Buffer instead of requiring node:buffer', async () => {
	await ensureWorkerBundlerModules()
	const source = await readFile(
		path.join(workerBundlerGeneratedDir, 'isomorphic-git.mjs'),
		'utf8',
	)
	expect(source).not.toContain('node:buffer')
	expect(source).toContain('node:crypto')
	expect(source).not.toMatch(/require\(["']node:buffer["']\)/)
})

test('ensureWorkerBundlerModules removes leftover src/generated bundler artifacts', async () => {
	await ensureWorkerBundlerModules()
	const leftoverWasm = path.join(leftoverSrcGeneratedDir, 'esbuild.wasm')
	await writeFile(leftoverWasm, 'leftover-wasm')
	for (const name of leftoverSrcGeneratedBundlerNames) {
		if (name === 'esbuild.wasm') continue
		await writeFile(path.join(leftoverSrcGeneratedDir, name), 'leftover')
	}

	await ensureWorkerBundlerModules()

	for (const name of leftoverSrcGeneratedBundlerNames) {
		expect(await pathExists(path.join(leftoverSrcGeneratedDir, name))).toBe(
			false,
		)
	}
	expect(
		await pathExists(path.join(leftoverSrcGeneratedDir, 'guide-catalog.mjs')),
	).toBe(true)
})
