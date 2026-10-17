import { type ViteBuilder } from 'vite'
import { expect, test } from 'vitest'
import { startReleaseBase } from './vite-start-release.ts'

test('only a full immutable release SHA enables the candidate namespace', () => {
	expect(startReleaseBase(undefined)).toBe('/')
	expect(startReleaseBase('')).toBe('/')
	expect(startReleaseBase('a'.repeat(40))).toBe(`/__start/${'a'.repeat(40)}/`)
	for (const release of [
		'main',
		'a'.repeat(7),
		'../main',
		'A'.repeat(40),
		' a'.repeat(20),
		'a'.repeat(40) + '/',
	]) {
		expect(() => startReleaseBase(release)).toThrow(
			'full lowercase Git commit SHA',
		)
	}
})

test('Cloudflare asset root contains the full namespace after all builds finish', async () => {
	const { mkdtemp, mkdir, writeFile, readFile, readdir, rm } =
		await import('node:fs/promises')
	const { tmpdir } = await import('node:os')
	const { join } = await import('node:path')
	const { startReleaseAssets } = await import('./vite-start-release.ts')
	const root = await mkdtemp(join(tmpdir(), 'kody-release-assets-'))
	try {
		const client = join(root, 'client')
		await mkdir(join(client, 'assets'), { recursive: true })
		await writeFile(join(client, 'assets/app.js'), 'export {}')
		await writeFile(join(client, 'page-init.js'), 'init()')
		await writeFile(join(client, '.assetsignore'), 'wrangler.json\n')
		const base = startReleaseBase('b'.repeat(40))
		const hook = startReleaseAssets(base).buildApp
		if (!hook || typeof hook === 'function')
			throw new Error('Expected ordered build hook')
		await hook.handler.call(
			{} as ThisParameterType<typeof hook.handler>,
			{
				config: { root },
				environments: {
					client: { isBuilt: true, config: { build: { outDir: 'client' } } },
				},
			} as unknown as ViteBuilder,
		)
		expect(
			await readFile(join(client, base.slice(1), 'assets/app.js'), 'utf8'),
		).toBe('export {}')
		expect(
			await readFile(join(client, base.slice(1), 'page-init.js'), 'utf8'),
		).toBe('init()')
		expect((await readdir(client)).sort()).toEqual(['.assetsignore', '__start'])
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
