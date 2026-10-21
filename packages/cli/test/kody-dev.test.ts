import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { resolveCommand, runCli } from '../src/cli.js'
import {
	parseDevSubcommand,
	resolveDevAuth,
	runDevCheck,
	runDevEmit,
	runDevFetch,
	runDevJob,
	runDevWebhook,
} from '../src/dev-command.js'
import { loadPackageManifest } from '../src/package-manifest.js'

const fixtureRoot = join(
	dirname(fileURLToPath(import.meta.url)),
	'fixtures/sample-package',
)

test('resolveCommand recognizes kody dev and --target', () => {
	assert.equal(resolveCommand(['dev']).command, 'dev')
	assert.equal(resolveCommand(['dev', 'fetch', '/']).command, 'dev')
	assert.equal(
		resolveCommand(['dev', 'emit', 'demo.event']).positionals[0],
		'emit',
	)
	assert.equal(
		resolveCommand(['execute', '--target', 'mock']).values.target,
		'mock',
	)
	assert.equal(
		resolveCommand(['search', '--target', 'prod']).values.target,
		'prod',
	)
	assert.equal(
		resolveCommand(['dev', '--reset-storage']).values['reset-storage'],
		true,
	)
})

test('parseDevSubcommand defaults to serve', () => {
	assert.deepEqual(parseDevSubcommand([]), { subcommand: 'serve', rest: [] })
	assert.deepEqual(parseDevSubcommand(['fetch', '/health']), {
		subcommand: 'fetch',
		rest: ['/health'],
	})
	assert.throws(
		() => parseDevSubcommand(['nope']),
		/Unknown kody dev subcommand/,
	)
})

test('loadPackageManifest reads four surfaces from the fixture', async () => {
	const manifest = await loadPackageManifest(fixtureRoot)
	assert.equal(manifest.kodyId, 'sample-dev-package')
	assert.ok(manifest.app?.entry.includes('entry.ts'))
	assert.ok(manifest.jobs.heartbeat)
	assert.ok(manifest.webhooks.ping)
	assert.ok(manifest.subscriptions['demo.event'])
	assert.ok(manifest.exports['./greet'])
})

test('kody dev check passes on the fixture', async () => {
	let stdout = ''
	let sentFiles: Array<string> = []
	const code = await runDevCheck({
		target: 'mock',
		cwd: fixtureRoot,
		runPublishChecks: async (files) => {
			sentFiles = Object.keys(files)
			return { ok: true, checks: [{ kind: 'manifest', ok: true, message: '' }] }
		},
		io: {
			stdout: (text) => {
				stdout += text
			},
			stderr: () => {},
		},
	})
	assert.equal(code, 0)
	assert.match(stdout, /passed/)
	assert.ok(sentFiles.includes('package.json'))
})

test('kody dev check via CLI exits without leaving the mock server open', async () => {
	const previous = process.cwd()
	let stdout = ''
	try {
		process.chdir(fixtureRoot)
		const code = await runCli(
			['dev', 'check', '--target', 'mock', '--offline', '--json'],
			{
				stdout: (text) => {
					stdout += text
				},
				stderr: () => {},
			},
		)
		assert.equal(code, 0)
		assert.match(stdout, /"ok": true/)
	} finally {
		process.chdir(previous)
	}
})

test('kody dev job / webhook / emit / fetch against mock', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-dev-e2e-'))
	const previous = process.env.KODY_CACHE_DIR
	process.env.KODY_CACHE_DIR = cache
	const cwd = process.cwd()
	try {
		process.chdir(fixtureRoot)
		const auth = await resolveDevAuth({
			target: 'mock',
			token: 'mock',
			apiUrl: 'https://api.kody.codes',
			resetStorage: true,
			packageId: 'local:sample-dev-package',
		})
		const io = {
			stdout: () => {},
			stderr: () => {},
		}

		assert.equal(
			await runDevJob({
				target: 'mock',
				auth: { ...auth, closeMock: undefined },
				jobName: 'heartbeat',
				json: true,
				io: {
					stdout: (text) => {
						const body = JSON.parse(text) as {
							structuredContent: { result: { ok: boolean } }
						}
						assert.equal(body.structuredContent.result.ok, true)
					},
					stderr: () => {},
				},
			}),
			0,
		)

		const bodyFile = join(cache, 'webhook.json')
		await writeFile(bodyFile, JSON.stringify({ ping: true }))
		assert.equal(
			await runDevWebhook({
				target: 'mock',
				auth: { ...auth, closeMock: undefined },
				webhookName: 'ping',
				bodyPath: bodyFile,
				json: true,
				io: {
					stdout: (text) => {
						const body = JSON.parse(text) as {
							structuredContent: { result: { webhook: boolean } }
						}
						assert.equal(body.structuredContent.result.webhook, true)
					},
					stderr: () => {},
				},
			}),
			0,
		)

		const eventFile = join(cache, 'event.json')
		await writeFile(
			eventFile,
			JSON.stringify({ event: 'demo.event', payload: { n: 1 }, dryRun: true }),
		)
		assert.equal(
			await runDevEmit({
				target: 'mock',
				auth: { ...auth, closeMock: undefined },
				event: 'demo.event',
				bodyPath: eventFile,
				json: true,
				io: {
					stdout: (text) => {
						const body = JSON.parse(text) as {
							structuredContent: {
								result: { handled: boolean; synthetic: boolean }
							}
						}
						assert.equal(body.structuredContent.result.handled, true)
						assert.equal(body.structuredContent.result.synthetic, true)
					},
					stderr: () => {},
				},
			}),
			0,
		)

		assert.equal(
			await runDevFetch({
				target: 'mock',
				auth,
				path: '/health',
				json: true,
				io: {
					stdout: (text) => {
						const body = JSON.parse(text) as {
							status: number
							body: string
						}
						assert.equal(body.status, 200)
						assert.match(body.body, /"ok":true/)
					},
					stderr: io.stderr,
				},
			}),
			0,
		)
	} finally {
		process.chdir(cwd)
		if (previous === undefined) delete process.env.KODY_CACHE_DIR
		else process.env.KODY_CACHE_DIR = previous
		await rm(cache, { recursive: true, force: true })
	}
})

test('kody dev fetch rejects on a bundle error, prints it once, and closes the mock', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kody-dev-broken-'))
	try {
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				name: '@local/broken-dev-package',
				type: 'module',
				kody: { id: 'broken-dev-package', app: { entry: './app/entry.ts' } },
			}),
		)
		await mkdir(join(root, 'app'))
		await writeFile(
			join(root, 'app/entry.ts'),
			'export default { fetch() { return new Response("x" }\n',
		)
		let stderr = ''
		let stdout = ''
		let mockClosed = 0
		const started = Date.now()
		await assert.rejects(
			runDevFetch({
				target: 'mock',
				auth: {
					token: 'mock',
					apiUrl: 'http://127.0.0.1:9',
					closeMock: async () => {
						mockClosed += 1
					},
				},
				path: '/',
				cwd: root,
				io: {
					stdout: (text) => {
						stdout += text
					},
					stderr: (text) => {
						stderr += text
					},
				},
			}),
			/app\/entry\.ts:1:52/,
		)
		assert.ok(Date.now() - started < 10_000)
		assert.equal(mockClosed, 1)
		assert.equal(stdout, '')
		assert.doesNotMatch(stderr, /entry\.ts:1:52/)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('kody dev fetch --json writes a build_error object to stdout on bundle failure', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kody-dev-broken-json-'))
	try {
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				name: '@local/broken-dev-json-package',
				type: 'module',
				kody: {
					id: 'broken-dev-json-package',
					app: { entry: './app/entry.ts' },
				},
			}),
		)
		await mkdir(join(root, 'app'))
		await writeFile(
			join(root, 'app/entry.ts'),
			'export default { fetch() { return new Response("x" }\n',
		)
		let stdout = ''
		await assert.rejects(
			runDevFetch({
				target: 'mock',
				auth: {
					token: 'mock',
					apiUrl: 'http://127.0.0.1:9',
					closeMock: async () => {},
				},
				path: '/',
				cwd: root,
				json: true,
				io: {
					stdout: (text) => {
						stdout += text
					},
					stderr: () => {},
				},
			}),
			/app\/entry\.ts:1:52/,
		)
		const event = JSON.parse(stdout) as {
			type: string
			message: string
			ts: string
		}
		assert.equal(event.type, 'build_error')
		assert.match(event.message, /app\/entry\.ts:1:52/)
		assert.ok(typeof event.ts === 'string' && event.ts.length > 0)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('execute --target mock runs local code against the mock', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-exec-mock-'))
	const previous = process.env.KODY_CACHE_DIR
	process.env.KODY_CACHE_DIR = cache
	try {
		let stdout = ''
		const code = await runCli(
			[
				'execute',
				'--target',
				'mock',
				'--reset-storage',
				'--code',
				`import { kody } from 'kody:runtime'
export default async function main() {
  return await kody.metaGetCurrentUser({})
}`,
			],
			{
				stdout: (text) => {
					stdout += text
				},
				stderr: () => {},
			},
		)
		assert.equal(code, 0)
		assert.match(stdout, /mock-user/)
	} finally {
		if (previous === undefined) delete process.env.KODY_CACHE_DIR
		else process.env.KODY_CACHE_DIR = previous
		await rm(cache, { recursive: true, force: true })
	}
})

test('execute --invoke local export against mock', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-invoke-mock-'))
	const previous = process.env.KODY_CACHE_DIR
	const cwd = process.cwd()
	process.env.KODY_CACHE_DIR = cache
	try {
		process.chdir(fixtureRoot)
		let stdout = ''
		const code = await runCli(
			[
				'execute',
				'--target',
				'mock',
				'--invoke',
				'./greet',
				'--params',
				JSON.stringify({ name: 'kent' }),
			],
			{
				stdout: (text) => {
					stdout += text
				},
				stderr: () => {},
			},
		)
		assert.equal(code, 0)
		assert.match(stdout, /kent/)
	} finally {
		process.chdir(cwd)
		if (previous === undefined) delete process.env.KODY_CACHE_DIR
		else process.env.KODY_CACHE_DIR = previous
		await rm(cache, { recursive: true, force: true })
	}
})

test('kody dev job --dry-run prints the plan without invoking', async () => {
	const auth = await resolveDevAuth({
		target: 'mock',
		token: 'mock',
		apiUrl: 'https://api.kody.codes',
		resetStorage: true,
		packageId: 'local:sample-dev-package',
	})
	try {
		let stdout = ''
		const code = await runDevJob({
			target: 'mock',
			auth: { ...auth, closeMock: undefined },
			jobName: 'heartbeat',
			cwd: fixtureRoot,
			dryRun: true,
			json: true,
			io: {
				stdout: (text) => {
					stdout += text
				},
				stderr: () => {},
			},
		})
		assert.equal(code, 0)
		const plan = JSON.parse(stdout) as {
			dryRun: boolean
			surface: string
			modulePath: string
			wouldInvoke: boolean
		}
		assert.equal(plan.dryRun, true)
		assert.equal(plan.wouldInvoke, true)
		assert.equal(plan.surface, 'job:heartbeat')
		assert.match(plan.modulePath, /heartbeat-job/)
	} finally {
		await auth.closeMock?.()
	}
})

test('search --target mock hits the mock catalog', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-search-mock-'))
	const previous = process.env.KODY_CACHE_DIR
	process.env.KODY_CACHE_DIR = cache
	try {
		let stdout = ''
		const code = await runCli(['search', '--target', 'mock', 'local'], {
			stdout: (text) => {
				stdout += text
			},
			stderr: () => {},
		})
		assert.equal(code, 0)
		assert.match(stdout, /local_execute|Local CLI execute/)
	} finally {
		if (previous === undefined) delete process.env.KODY_CACHE_DIR
		else process.env.KODY_CACHE_DIR = previous
		await rm(cache, { recursive: true, force: true })
	}
})
