import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { startLocalKody } from '../src/dev/local-kody.js'
import { readPackageVersion } from '../src/package-info.js'
import { StructuredCliError } from '../src/structured-error.js'

const npmStderr = {
	'404':
		'npm error code E404\nnpm error 404 Not Found - GET https://registry.example/@kodycodes%2fdev-runtime',
	'version missing':
		'npm error code ETARGET\nnpm error notarget No matching version found for @kodycodes/dev-runtime@9.9.9.',
	offline:
		'npm error code ENOTFOUND\nnpm error network request to https://registry.example failed',
	'install error': 'npm error code EACCES\nnpm error permission denied',
} as const

for (const scenario of Object.keys(npmStderr) as Array<
	keyof typeof npmStderr
>) {
	test(`runtime install failure diagnoses npm: ${scenario}`, async (t) => {
		const cache = await mkdtemp(join(tmpdir(), 'kody-install-'))
		const existsSync = fs.existsSync
		t.mock.method(
			fs,
			'existsSync',
			(path: Parameters<typeof fs.existsSync>[0]) =>
				String(path).includes('dev-runtime') ? false : existsSync(path),
		)
		t.mock.method(childProcess, 'spawn', () => {
			const child = new EventEmitter()
			const stderr = new PassThrough()
			Object.assign(child, { stderr })
			queueMicrotask(() => {
				stderr.emit('data', Buffer.from(npmStderr[scenario]))
				child.emit('close', 1)
			})
			return child
		})
		syncBuiltinESMExports()
		try {
			await assert.rejects(
				startLocalKody({
					manifest: {
						root: cache,
						packageJsonPath: join(cache, 'package.json'),
						name: '@test/app',
						kodyId: 'app',
						exports: {},
						dev: { ignore: [] },
						jobs: {},
						webhooks: {},
						subscriptions: {},
					},
					packageAppPort: 3000,
					env: { XDG_CACHE_HOME: cache },
				}),
				(error: unknown) => {
					assert.ok(error instanceof StructuredCliError)
					if (scenario === '404' || scenario === 'version missing') {
						assert.equal(
							error.toJSON().message,
							`@kodycodes/dev-runtime@${readPackageVersion()} is not on npm yet (release still propagating).`,
						)
						assert.equal(
							error.fix,
							'Retry in a few minutes or pin the previous CLI version.',
						)
					} else if (scenario === 'offline') {
						assert.match(error.fix ?? '', /Connect to the network/)
					} else {
						assert.doesNotMatch(
							error.fix ?? '',
							/Connect to the network|pin the previous/,
						)
					}
					return true
				},
			)
		} finally {
			t.mock.restoreAll()
			syncBuiltinESMExports()
			await rm(cache, { recursive: true, force: true })
		}
	})
}
