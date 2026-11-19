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

for (const scenario of [
	'404',
	'version missing',
	'published',
	'offline',
	'server error',
] as const) {
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
			Object.assign(child, { stderr: new PassThrough() })
			queueMicrotask(() => child.emit('close', 1))
			return child
		})
		syncBuiltinESMExports()
		t.mock.method(
			globalThis,
			'fetch',
			async (url: URL, options: RequestInit) => {
				assert.equal(url.hostname, 'registry.npmjs.org')
				assert.ok(options.signal)
				if (scenario === 'offline') throw new Error('offline')
				if (scenario === '404') return new Response(null, { status: 404 })
				if (scenario === 'server error')
					return new Response(null, { status: 503 })
				return Response.json({
					versions:
						scenario === 'published' ? { [readPackageVersion()]: {} } : {},
				})
			},
		)
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
