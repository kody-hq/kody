import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { verifyStartReleaseBuild } from './verify-start-release-build.ts'

test('checks embedded SSR references against the unchanged Cloudflare asset binding root', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'kody-release-output-'))
	const release = 'c'.repeat(40)
	const base = `/__start/${release}/`
	try {
		const client = path.join(directory, 'client')
		const server = path.join(directory, 'server')
		const publicDirectory = path.join(client, base.slice(1))
		await mkdir(path.join(publicDirectory, 'assets'), { recursive: true })
		await mkdir(path.join(publicDirectory, 'fonts'), { recursive: true })
		await mkdir(server)
		await writeFile(
			path.join(server, 'wrangler.json'),
			JSON.stringify({ assets: { directory: '../client' } }),
		)
		await writeFile(
			path.join(server, 'index.js'),
			`const manifest = {script: '${base}assets/app.js', css: '${base}assets/root.css'}; const rpc = '${base}_serverFn/';`,
		)
		for (const file of [
			'page-init.js',
			'site.webmanifest',
			'fonts/wix-madefor-text-latin.woff2',
			'assets/app.js',
		]) {
			await writeFile(path.join(publicDirectory, file), '')
		}
		await writeFile(
			path.join(publicDirectory, 'assets/root.css'),
			`@font-face{src:url(${base}fonts/wix-madefor-text-latin.woff2)}`,
		)
		expect(await verifyStartReleaseBuild(directory, release)).toBe(2)
		await writeFile(
			path.join(publicDirectory, 'assets/root.css'),
			'@font-face{src:url(/fonts/wix-madefor-text-latin.woff2)}',
		)
		await expect(verifyStartReleaseBuild(directory, release)).rejects.toThrow(
			'namespaced font URLs',
		)
		await writeFile(
			path.join(publicDirectory, 'assets/root.css'),
			`@font-face{src:url(${base}fonts/wix-madefor-text-latin.woff2)}`,
		)
		await rm(path.join(publicDirectory, 'assets/app.js'))
		await expect(verifyStartReleaseBuild(directory, release)).rejects.toThrow(
			'ENOENT',
		)
		await writeFile(path.join(publicDirectory, 'assets/app.js'), '')
		await writeFile(
			path.join(server, 'wrangler.json'),
			JSON.stringify({ assets: { directory: `../client${base}` } }),
		)
		await expect(verifyStartReleaseBuild(directory, release)).rejects.toThrow(
			'client root',
		)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})
