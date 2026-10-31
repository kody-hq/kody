import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveDevAuth, runDevServe } from '../src/dev-command.js'
import {
	inferDevAssetContentType,
	parseDevAssetPath,
	resolveDevAssetFile,
} from '../src/dev/dev-assets.js'
import {
	defaultDevPort,
	devPortRange,
	listenDevServer,
	parseDevPort,
} from '../src/dev/dev-port.js'
import {
	devRegistryPath,
	writeDevRegistration,
} from '../src/dev/dev-registry.js'
import { PrebuildError, runPrebuild } from '../src/dev/prebuild.js'
import { startPackageAppDev } from '../src/package-app-dev.js'
import { loadPackageManifest } from '../src/package-manifest.js'
import { StructuredCliError } from '../src/structured-error.js'
import { ensureWorkerdBinary } from '../src/workerd-binary.js'
import { appEntry, waitFor, withDevServer } from './dev-server-harness.js'

const fixtureRoot = join(
	dirname(fileURLToPath(import.meta.url)),
	'fixtures/sample-package',
)

const clientEntryApp = `import { packageContext } from 'kody:runtime'

export default {
  async fetch(): Promise<Response> {
    return Response.json({
      clientModuleUrl: packageContext.clientModuleUrl,
      assetBasePath: packageContext.assetBasePath,
    })
  },
}
`

async function editPackageJson(
	root: string,
	edit: (kody: Record<string, any>) => void,
) {
	const path = join(root, 'package.json')
	const pkg = JSON.parse(await readFile(path, 'utf8'))
	edit(pkg.kody)
	await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`)
}

async function occupy(port: number, host = '127.0.0.1'): Promise<Server> {
	const server = createServer()
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(port, host, () => resolve())
	})
	return server
}

const closeServer = (server: Server) =>
	new Promise<void>((resolve) => server.close(() => resolve()))

test('defaultDevPort is stable per package and inside the dev range', () => {
	const port = defaultDevPort('asteroids')
	assert.equal(defaultDevPort('asteroids'), port)
	assert.notEqual(defaultDevPort('slideshow'), port)
	for (const id of ['a', 'b', 'asteroids', 'slideshow', 'x'.repeat(100)]) {
		const value = defaultDevPort(id)
		assert.ok(
			value >= devPortRange.min && value <= devPortRange.max,
			`${id} → ${value}`,
		)
	}
})

test('parseDevPort rejects non-integer and out-of-range values', () => {
	assert.equal(parseDevPort('0'), 0)
	assert.equal(parseDevPort('4321'), 4321)
	for (const bad of ['abc', '-1', '65536', '1.5', '']) {
		assert.throws(() => parseDevPort(bad), /--port must be an integer/)
	}
})

test('listenDevServer walks to the next free port unless the port is explicit', async () => {
	const blocker = await occupy(0)
	const taken = (blocker.address() as AddressInfo).port
	const fallback = createServer()
	const exact = createServer()
	try {
		const bound = await listenDevServer(fallback, {
			host: '127.0.0.1',
			port: taken,
			explicit: false,
		})
		assert.notEqual(bound, taken)
		assert.ok(bound > taken && bound <= taken + 20)

		await assert.rejects(
			listenDevServer(exact, {
				host: '127.0.0.1',
				port: taken,
				explicit: true,
			}),
			(error: unknown) => {
				assert.ok(error instanceof StructuredCliError)
				assert.equal(error.code, 'dev_port_in_use')
				assert.match(
					error.message,
					new RegExp(`Port ${taken} on 127\\.0\\.0\\.1 is already in use`),
				)
				assert.match(error.message, /lsof -nP -iTCP:\d+ -sTCP:LISTEN/)
				return true
			},
		)
	} finally {
		await closeServer(blocker)
		if (fallback.listening) await closeServer(fallback)
		if (exact.listening) await closeServer(exact)
	}
})

test('dev asset paths are decoded and never escape the assets dir', () => {
	assert.equal(parseDevAssetPath('/_assets/app.css'), 'app.css')
	assert.equal(parseDevAssetPath('/_assets/a%20b.png'), 'a b.png')
	assert.equal(parseDevAssetPath('/_assets/'), null)
	assert.equal(parseDevAssetPath('/other'), null)
	assert.equal(parseDevAssetPath('/_assets/%E0%A4%A'), null)
	assert.equal(
		resolveDevAssetFile('/pkg/public', 'css/app.css'),
		resolve('/pkg/public/css/app.css'),
	)
	assert.equal(resolveDevAssetFile('/pkg/public', '../package.json'), null)
	assert.equal(resolveDevAssetFile('/pkg/public', '/etc/passwd'), null)
	assert.equal(resolveDevAssetFile('/pkg/public', 'a\0b'), null)
	assert.equal(inferDevAssetContentType('x/app.CSS'), 'text/css; charset=utf-8')
	assert.equal(
		inferDevAssetContentType('sw.js'),
		'text/javascript; charset=utf-8',
	)
	assert.equal(inferDevAssetContentType('LICENSE'), 'application/octet-stream')
})

test('loadPackageManifest reads kody.dev and the object form of kody.app.client', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kody-dev-manifest-'))
	try {
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				name: 'm',
				kody: {
					id: 'm',
					app: {
						entry: './app/entry.ts',
						client: { entry: './app/client.ts', externals: ['preact'] },
						assets: './public',
					},
					dev: { prebuild: ' node gen.mjs ', ignore: ['public/generated'] },
				},
			}),
		)
		const manifest = await loadPackageManifest(root)
		assert.equal(manifest.app?.client, './app/client.ts')
		assert.deepEqual(manifest.app?.clientExternals, ['preact'])
		assert.deepEqual(manifest.dev, {
			prebuild: 'node gen.mjs',
			ignore: ['public/generated'],
		})

		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				name: 'm',
				kody: { id: 'm', dev: { ignore: 'public' } },
			}),
		)
		await assert.rejects(
			loadPackageManifest(root),
			/kody\.dev\.ignore must be an array/,
		)

		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				name: 'm',
				kody: {
					id: 'm',
					app: { entry: './app/entry.ts', client: { file: './app/client.ts' } },
				},
			}),
		)
		await assert.rejects(
			loadPackageManifest(root),
			/kody\.app\.client\.entry must be a non-empty string/,
		)
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 10 })
	}
})

test('kody dev serves kody.app.client, __version.json, and the assets dir like the platform', async () => {
	await withDevServer(
		async ({ server, root, events }) => {
			const context = JSON.parse((await server.fetchPath('/')).body) as {
				clientModuleUrl: string
				assetBasePath: string
			}
			assert.equal(context.assetBasePath, '/_assets')
			assert.match(
				context.clientModuleUrl,
				new RegExp(
					`^${server.hostedUrl}/_assets/client\\.[A-Za-z0-9_-]{16}\\.js$`,
				),
			)
			const clientPath = new URL(context.clientModuleUrl).pathname
			const client = await server.fetchPath(clientPath)
			assert.equal(client.status, 200)
			assert.match(client.headers['content-type'] ?? '', /text\/javascript/)
			assert.match(client.body, /client-v1/)
			assert.match(
				client.body,
				/from "preact"/,
				'declared externals stay bare imports',
			)
			assert.match(client.body, /sourceMappingURL=data:application\/json/)

			const version = JSON.parse(
				(await server.fetchPath('/_assets/__version.json')).body,
			)
			assert.deepEqual(version, {
				clientModuleUrl: context.clientModuleUrl,
				assetBasePath: '/_assets',
				publishedCommit: null,
			})

			const css = await server.fetchPath('/_assets/app.css')
			assert.equal(css.status, 200)
			assert.equal(css.headers['content-type'], 'text/css; charset=utf-8')
			assert.equal(css.headers['cache-control'], 'no-store')
			assert.equal(css.body, 'body { color: red }\n')
			assert.equal((await server.fetchPath('/_assets/missing.css')).status, 404)
			assert.equal(
				(await server.fetchPath('/_assets/..%2Fpackage.json')).status,
				404,
			)

			await writeFile(join(root, 'app/client.ts'), clientSource('client-v2'))
			const nextUrl = await waitFor(async () => {
				const body = JSON.parse((await server.fetchPath('/')).body) as {
					clientModuleUrl: string
				}
				return body.clientModuleUrl !== context.clientModuleUrl
					? body.clientModuleUrl
					: undefined
			}, 'client hash changes after editing the client entry')
			const next = await server.fetchPath(new URL(nextUrl).pathname)
			assert.match(next.body, /client-v2/)
			assert.equal((await server.fetchPath(clientPath)).status, 404)

			const reloadsBefore = events.filter(
				(event) => event.type === 'rebuild_ok',
			).length
			await writeFile(join(root, 'public/app.css'), 'body { color: blue }\n')
			await waitFor(async () => {
				const response = await server.fetchPath('/_assets/app.css')
				return response.body.includes('blue') ? true : undefined
			}, 'asset edits are served immediately')
			await waitFor(
				async () =>
					events.filter((event) => event.type === 'rebuild_ok').length >
					reloadsBefore
						? true
						: undefined,
				'an asset edit runs a (no-op) rebuild so live reload fires',
			)
		},
		{
			prepare: async (root) => {
				await writeFile(join(root, 'app/entry.ts'), clientEntryApp)
				await writeFile(join(root, 'app/client.ts'), clientSource('client-v1'))
				await mkdir(join(root, 'public'), { recursive: true })
				await writeFile(join(root, 'public/app.css'), 'body { color: red }\n')
				await editPackageJson(root, (kody) => {
					kody.app = {
						entry: './app/entry.ts',
						client: { entry: './app/client.ts', externals: ['preact'] },
						assets: './public',
					}
				})
			},
		},
	)
})

function clientSource(marker: string): string {
	return `import { h } from 'preact'\nconsole.log(${JSON.stringify(marker)}, h)\n`
}

test('kody.dev.prebuild runs before every build, without retriggering itself', async () => {
	await withDevServer(
		async ({ server, root, events, writeMessage }) => {
			const first = await server.fetchPath('/')
			assert.match(first.body, /v0 gen-1/)

			await writeMessage(`export const message = 'v1'\n`)
			const next = await waitFor(async () => {
				const response = await server.fetchPath('/')
				return response.body.includes('v1') ? response : undefined
			}, 'rebuild after an edit')
			assert.match(next.body, /v1 gen-2/)
			await new Promise((resolve) => setTimeout(resolve, 400))
			assert.equal(
				(await readFile(join(root, 'count.txt'), 'utf8')).trim(),
				'2',
			)
			assert.ok(
				events.some(
					(event) =>
						event.type === 'log' &&
						event.source === 'prebuild' &&
						/generated/.test(event.message),
				),
			)

			await writeFile(
				join(root, 'gen.sh'),
				'echo "boom from prebuild" >&2\nexit 3\n',
			)
			await writeMessage(`export const message = 'v2'\n`)
			const failed = await waitFor(async () => {
				const response = await server.fetchPath('/')
				return response.status === 500 ? response : undefined
			}, 'prebuild failure becomes a build error')
			assert.match(
				failed.body,
				/kody\.dev\.prebuild failed \(exit 3\): sh gen\.sh/,
			)
			assert.match(failed.body, /boom from prebuild/)
			const rebuildStartsAfterFailure = events.filter(
				(event) => event.type === 'rebuild_start',
			).length
			// Longer than failedPrebuildAbsorbMs so late chokidar/poll echoes are
			// covered on slow CI (lts/* runners have shown +1 rebuild_start at ~1s).
			await new Promise((resolve) => setTimeout(resolve, 2000))
			assert.equal(
				events.filter((event) => event.type === 'rebuild_start').length,
				rebuildStartsAfterFailure,
				'failed prebuild output must not retrigger the rebuild loop',
			)
			assert.equal(server.status().state, 'build_error')
		},
		{
			prepare: async (root) => {
				await writeFile(
					join(root, 'gen.sh'),
					[
						'n=$(cat count.txt 2>/dev/null || echo 0)',
						'n=$((n + 1))',
						'echo "$n" > count.txt',
						'echo "export const gen = \'gen-$n\'" > app/generated.ts',
						'echo "generated gen-$n (KODY_DEV=$KODY_DEV)"',
						'',
					].join('\n'),
				)
				await writeFile(
					join(root, 'app/entry.ts'),
					`import { message } from './message.ts'\nimport { gen } from './generated.ts'\n\nexport default {\n  async fetch(): Promise<Response> {\n    return new Response(message + ' ' + gen)\n  },\n}\n`,
				)
				await editPackageJson(root, (kody) => {
					kody.dev = { prebuild: 'sh gen.sh' }
				})
			},
		},
	)
})

test('runPrebuild keeps a final incomplete stderr line and aborts on signal', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kody-prebuild-unit-'))
	try {
		await writeFile(
			join(root, 'partial.sh'),
			'printf "no-newline-error" >&2\nexit 2\n',
		)
		await assert.rejects(
			runPrebuild({ command: 'sh partial.sh', cwd: root }),
			(error: unknown) => {
				assert.ok(error instanceof PrebuildError)
				assert.match(error.message, /no-newline-error/)
				return true
			},
		)

		await writeFile(join(root, 'slow.sh'), 'sleep 30\n')
		const abort = new AbortController()
		const pending = runPrebuild({
			command: 'sh slow.sh',
			cwd: root,
			signal: abort.signal,
		})
		abort.abort()
		await assert.rejects(pending, /kody\.dev\.prebuild aborted/)
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 10 })
	}
})

test('kody dev refuses to start a second server for the same package unless --port is passed', async () => {
	await withDevServer(async ({ server, root }) => {
		await writeDevRegistration({
			pid: process.pid,
			origin: server.hostedUrl,
			port: server.port,
			basePath: server.appBasePath,
			target: 'mock',
			root,
		})
		await assert.rejects(
			runDevServe({
				target: 'mock',
				auth: { token: 'mock', apiUrl: 'https://api.kody.codes' },
				cwd: root,
				io: { stdout: () => {}, stderr: () => {} },
				serveOnce: true,
			}),
			(error: unknown) => {
				assert.ok(error instanceof StructuredCliError)
				assert.equal(error.code, 'dev_already_running')
				assert.match(
					error.message,
					new RegExp(
						`already running .* at ${server.hostedUrl}/ \\(pid ${process.pid}\\)`,
					),
				)
				assert.match(error.message, /kody dev fetch/)
				return true
			},
		)
	})
})

test('kody dev --port leaves the primary attach registry alone', async () => {
	await withDevServer(async ({ server, root }) => {
		// Own the registry under a different live pid so shutdown of the
		// second server cannot delete it via removeDevRegistration's pid check.
		await writeDevRegistration({
			pid: process.ppid,
			origin: server.hostedUrl,
			port: server.port,
			basePath: server.appBasePath,
			target: 'mock',
			root,
		})
		const registryPath = devRegistryPath(root, 'mock')
		const before = await readFile(registryPath, 'utf8')
		const code = await runDevServe({
			target: 'mock',
			auth: { token: 'mock', apiUrl: 'https://api.kody.codes' },
			port: 0,
			cwd: root,
			io: { stdout: () => {}, stderr: () => {} },
			serveOnce: true,
		})
		assert.equal(code, 0)
		assert.equal(await readFile(registryPath, 'utf8'), before)
	})
})

test('onListening failure closes the bound HTTP server', async () => {
	const workerdPath = await ensureWorkerdBinary()
	const root = await mkdtemp(join(tmpdir(), 'kody-dev-onlistening-'))
	const cache = await mkdtemp(join(tmpdir(), 'kody-dev-onlistening-cache-'))
	const previousCache = process.env.KODY_CACHE_DIR
	process.env.KODY_CACHE_DIR = cache
	let boundPort: number | undefined
	try {
		await cp(fixtureRoot, root, { recursive: true })
		await writeFile(join(root, 'app/entry.ts'), appEntry)
		await writeFile(
			join(root, 'app/message.ts'),
			`export const message = 'v0'\n`,
		)
		const auth = await resolveDevAuth({
			target: 'mock',
			token: 'mock',
			apiUrl: 'https://api.kody.codes',
			resetStorage: true,
			packageId: 'local:sample-dev-package',
		})
		try {
			await assert.rejects(
				startPackageAppDev({
					manifest: await loadPackageManifest(root),
					token: auth.token,
					apiUrl: auth.apiUrl,
					target: 'mock',
					workerdPath,
					onListening: ({ port }) => {
						boundPort = port
						throw new Error('registry boom')
					},
				}),
				/registry boom/,
			)
			assert.ok(boundPort !== undefined)
			const probe = createServer()
			try {
				await listenDevServer(probe, {
					host: '127.0.0.1',
					port: boundPort!,
					explicit: true,
				})
			} finally {
				await closeServer(probe)
			}
		} finally {
			await auth.closeMock?.()
		}
	} finally {
		if (previousCache === undefined) delete process.env.KODY_CACHE_DIR
		else process.env.KODY_CACHE_DIR = previousCache
		await rm(root, { recursive: true, force: true, maxRetries: 10 })
		await rm(cache, { recursive: true, force: true, maxRetries: 10 })
	}
})
