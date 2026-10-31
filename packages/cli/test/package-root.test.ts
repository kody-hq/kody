import assert from 'node:assert/strict'
import {
	mkdtemp,
	mkdir,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadPackageManifest } from '../src/package-manifest.js'

test('package roots use the same canonical path through directory aliases', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'kody-root-'))
	try {
		const root = join(dir, 'package')
		await mkdir(root)
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				name: '@test/root',
				type: 'module',
				exports: { './run': './run.ts' },
				kody: { id: 'root' },
			}),
		)
		const alias = join(dir, 'alias')
		await symlink(root, alias, 'junction')
		assert.equal((await loadPackageManifest(alias)).root, await realpath(root))
		assert.equal((await loadPackageManifest(root)).root, await realpath(root))
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 10 })
	}
})
