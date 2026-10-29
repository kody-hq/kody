import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
	removeOwnedReadyFile,
	resolveDevAuth,
	runDevServe,
	tryAttachedDevFetch,
} from '../src/dev-command.js'
import {
	devRegistryPath,
	findRunningDevServer,
	removeDevRegistration,
	writeDevRegistration,
	type DevServerStatus,
} from '../src/dev/dev-registry.js'
import { ensureWorkerdBinary } from '../src/workerd-binary.js'
import { waitFor, withDevServer } from './dev-server-harness.js'

const fixtureRoot = join(
	dirname(fileURLToPath(import.meta.url)),
	'fixtures/sample-package',
)

test('GET /__kody/dev/status reports build id, state, and the last error', async () => {
	await withDevServer(async ({ server, root, writeMessage }) => {
		const ready = await server.fetchPath('/__kody/dev/status')
		assert.equal(ready.status, 200)
		const status = JSON.parse(ready.body) as DevServerStatus
		assert.equal(status.ok, true)
		assert.equal(status.state, 'ready')
		assert.equal(typeof status.buildId, 'number')
		assert.equal(status.target, 'mock')
		assert.equal(status.package.root, root)
		assert.equal(status.package.kodyId, 'sample-dev-package')
		assert.equal(status.url, `${server.hostedUrl}/`)
		assert.equal(status.lastError, null)

		await server.fetchPath('/boom')
		const afterBoom = server.status()
		assert.equal(afterBoom.lastError?.kind, 'runtime')
		assert.match(
			afterBoom.lastError?.kind === 'runtime' ? afterBoom.lastError.stack : '',
			/app\/entry\.ts/,
		)

		await writeMessage(`export const message = = 'broken'\n`)
		const broken = await waitFor(async () => {
			const current = server.status()
			return current.state === 'build_error' ? current : undefined
		}, 'build_error state')
		assert.equal(broken.ok, false)
		assert.equal(broken.lastError?.kind, 'build')
		if (broken.lastError?.kind === 'build') {
			assert.equal(broken.lastError.file, 'app/message.ts')
			assert.equal(broken.lastError.line, 1)
			assert.equal(broken.lastError.col, 24)
		}
	})
})

test('kody dev --json emits NDJSON events and --ready-file is written before ready', async () => {
	const previousWorkerd = process.env.KODY_WORKERD_PATH
	process.env.KODY_WORKERD_PATH = await ensureWorkerdBinary()
	const root = await realpath(await mkdtemp(join(tmpdir(), 'kody-dev-json-')))
	const cache = await mkdtemp(join(tmpdir(), 'kody-dev-json-cache-'))
	const previousCache = process.env.KODY_CACHE_DIR
	process.env.KODY_CACHE_DIR = cache
	await cp(fixtureRoot, root, { recursive: true })
	const readyFile = join(root, 'ready.json')
	const auth = await resolveDevAuth({
		target: 'mock',
		token: 'mock',
		apiUrl: 'https://api.kody.codes',
		resetStorage: true,
		packageId: 'local:sample-dev-package',
	})
	const lines: Array<Record<string, unknown>> = []
	let readyFileAtReady: Record<string, unknown> | null = null
	let registeredAtRebuildStart = false
	let registeredAtReady = false
	try {
		const code = await runDevServe({
			target: 'mock',
			auth,
			cwd: root,
			json: true,
			readyFile,
			serveOnce: true,
			io: {
				stdout: (text) => {
					for (const line of text.split('\n').filter(Boolean)) {
						const event = JSON.parse(line) as Record<string, unknown>
						lines.push(event)
						if (event.type === 'rebuild_start') {
							registeredAtRebuildStart = existsSync(
								devRegistryPath(root, 'mock', cache),
							)
						}
						if (event.type === 'ready') {
							readyFileAtReady = JSON.parse(
								readFileSync(readyFile, 'utf8'),
							) as Record<string, unknown>
							registeredAtReady = existsSync(
								devRegistryPath(root, 'mock', cache),
							)
						}
					}
				},
				stderr: () => {},
			},
		})
		assert.equal(code, 0)
		const types = lines.map((event) => event.type)
		assert.deepEqual(types, ['rebuild_start', 'rebuild_ok', 'ready'])
		for (const event of lines) assert.equal(typeof event.ts, 'string')
		const ready = lines.at(-1)!
		assert.match(String(ready.url), /^http:\/\/127\.0\.0\.1:\d+\/$/)
		assert.equal(typeof ready.port, 'number')
		assert.equal(ready.basePath, '')
		assert.equal(ready.pid, process.pid)
		assert.match(String(ready.statusUrl), /\/__kody\/dev\/status$/)
		assert.ok(readyFileAtReady)
		assert.equal((readyFileAtReady as Record<string, unknown>).url, ready.url)
		assert.equal(
			registeredAtRebuildStart,
			true,
			'registry is advertised as soon as the port binds, before the first build finishes',
		)
		assert.equal(registeredAtReady, true)
		assert.equal(
			existsSync(readyFile),
			false,
			'ready file is removed on shutdown',
		)
		assert.equal(
			existsSync(devRegistryPath(root, 'mock', cache)),
			false,
			'registry is removed on shutdown',
		)
	} finally {
		await auth.closeMock?.()
		if (previousCache === undefined) delete process.env.KODY_CACHE_DIR
		else process.env.KODY_CACHE_DIR = previousCache
		if (previousWorkerd === undefined) delete process.env.KODY_WORKERD_PATH
		else process.env.KODY_WORKERD_PATH = previousWorkerd
		await rm(root, { recursive: true, force: true })
		await rm(cache, { recursive: true, force: true })
	}
})

test('removeOwnedReadyFile only deletes the ready file when the pid still matches', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'kody-ready-file-'))
	try {
		const path = join(dir, 'ready.json')
		await writeFile(
			path,
			`${JSON.stringify({ url: 'http://127.0.0.1:1/', pid: 111 }, null, 2)}\n`,
		)
		await removeOwnedReadyFile(path, 222)
		assert.equal(
			existsSync(path),
			true,
			'leaves a successor process ready file alone',
		)
		await removeOwnedReadyFile(path, 111)
		assert.equal(existsSync(path), false, 'removes the file this process wrote')
		await removeOwnedReadyFile(path, 111)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('kody dev fetch attaches to the running server for the same package and target', async () => {
	await withDevServer(async ({ server, root, writeMessage }) => {
		await writeDevRegistration({
			pid: process.pid,
			origin: server.hostedUrl,
			port: server.port,
			basePath: server.appBasePath,
			target: 'mock',
			root,
		})
		await writeMessage(`export const message = 'attached'\n`)
		let stdout = ''
		let stderr = ''
		const code = await waitFor(async () => {
			stdout = ''
			const result = await tryAttachedDevFetch({
				target: 'mock',
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
			})
			return stdout.includes('attached') ? result : undefined
		}, 'attached fetch sees the new build')
		assert.equal(code, 0)
		assert.match(stdout, /^HTTP 200\n/)
		assert.match(stderr, /Attached to running kody dev/)

		const otherTarget = await tryAttachedDevFetch({
			target: 'prod',
			path: '/',
			cwd: root,
			io: { stdout: () => {}, stderr: () => {} },
		})
		assert.equal(otherTarget, null)
	})
})

test('findRunningDevServer drops registrations whose process is gone', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-dev-registry-'))
	try {
		const path = await writeDevRegistration(
			{
				pid: 2 ** 22 + 12345,
				origin: 'http://127.0.0.1:1',
				port: 1,
				basePath: '',
				target: 'mock',
				root: '/nowhere',
			},
			cache,
		)
		assert.equal(existsSync(path), true)
		assert.equal(
			await findRunningDevServer({
				root: '/nowhere',
				target: 'mock',
				cacheDir: cache,
			}),
			null,
		)
		assert.equal(existsSync(path), false)
		await writeFile(path, 'not json')
		assert.equal(
			await findRunningDevServer({
				root: '/nowhere',
				target: 'mock',
				cacheDir: cache,
			}),
			null,
		)
	} finally {
		await rm(cache, { recursive: true, force: true })
	}
})

test('dev registry keys by target and removeDevRegistration refuses successor/unreadable files', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-dev-registry-target-'))
	try {
		const mockPath = await writeDevRegistration(
			{
				pid: 111,
				origin: 'http://127.0.0.1:1',
				port: 1,
				basePath: '',
				target: 'mock',
				root: '/pkg',
			},
			cache,
		)
		const prodPath = await writeDevRegistration(
			{
				pid: 222,
				origin: 'http://127.0.0.1:2',
				port: 2,
				basePath: '',
				target: 'prod',
				root: '/pkg',
			},
			cache,
		)
		assert.notEqual(mockPath, prodPath)
		assert.equal(existsSync(mockPath), true)
		assert.equal(existsSync(prodPath), true)

		await removeDevRegistration('/pkg', 999, 'mock', cache)
		assert.equal(
			existsSync(mockPath),
			true,
			'wrong pid leaves the registration alone',
		)
		await removeDevRegistration('/pkg', 111, 'mock', cache)
		assert.equal(
			existsSync(mockPath),
			false,
			'matching pid removes this target only',
		)
		assert.equal(
			existsSync(prodPath),
			true,
			'other target registration survives',
		)

		await writeFile(prodPath, 'not json')
		await removeDevRegistration('/pkg', 222, 'prod', cache)
		assert.equal(
			existsSync(prodPath),
			true,
			'unreadable successor file is not deleted',
		)
	} finally {
		await rm(cache, { recursive: true, force: true })
	}
})

test('status reports building during watcher debounce and fetch waits for the new build', async () => {
	await withDevServer(
		async ({ server, writeMessage }) => {
			await writeMessage(`export const message = 'after-debounce'\n`)
			await waitFor(async () => {
				return server.status().state === 'building' ? true : undefined
			}, 'building state while debounce is open')
			const response = await server.fetchPath('/')
			assert.equal(response.status, 200)
			assert.match(response.body, /after-debounce/)
			await waitFor(async () => {
				return server.status().state === 'ready' ? true : undefined
			}, 'ready after the debounced rebuild settles')
		},
		{ debounceMs: 80 },
	)
})
