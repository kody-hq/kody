import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { runCli } from '../src/cli.js'
import {
	startLocalKody,
	createLocalKodyUpstream,
} from '../src/dev/local-kody.js'
import {
	writeDevRegistration,
	removeDevRegistration,
} from '../src/dev/dev-registry.js'
import { startPackageAppDev } from '../src/package-app-dev.js'
import { loadPackageManifest } from '../src/package-manifest.js'

const built = existsSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		'../../dev-runtime/dist/index.js',
	),
)

test(
	'execute package exports and kody dev share KV and SQL through boot and attach',
	{
		skip:
			!built &&
			!process.env.KODY_REQUIRE_DEV_RUNTIME &&
			'build @kodycodes/dev-runtime first',
		timeout: 360_000,
	},
	async () => {
		const root = await realpath(
			await mkdtemp(join(tmpdir(), 'kody-shared-store-')),
		)
		const cache = await mkdtemp(join(tmpdir(), 'kody-shared-store-cache-'))
		const previous = {
			cwd: process.cwd(),
			cache: process.env.KODY_CACHE_DIR,
			stub: process.env.KODY_DEV_STUB_RUNTIME,
		}
		const seed = `import { packageStorage } from 'kody:runtime'
export default async function seed({ value }) {
	const storage = packageStorage()
	await storage.set('seed', value)
	await storage.sql('CREATE TABLE IF NOT EXISTS seeds (value TEXT)')
	await storage.sql('DELETE FROM seeds')
	await storage.sql('INSERT INTO seeds (value) VALUES (?)', [value])
	return value
}
`
		let kody: Awaited<ReturnType<typeof startLocalKody>> | undefined
		let server: Awaited<ReturnType<typeof startPackageAppDev>> | undefined
		try {
			process.env.KODY_CACHE_DIR = cache
			delete process.env.KODY_DEV_STUB_RUNTIME
			await mkdir(join(root, 'src'))
			for (const [path, content] of Object.entries({
				'package.json': JSON.stringify({
					name: '@seed/shared',
					version: '0.0.0',
					type: 'module',
					exports: { './seed': './src/seed.ts' },
					kody: {
						description: 'Shared local storage fixture',
						app: { entry: 'src/app.ts' },
					},
				}),
				'README.md': '# Shared store fixture\n',
				'AGENTS.md': '# Agents\n\nLocal fixture only.\n',
				'src/seed.ts': seed,
				'src/app.ts': `import { packageStorage } from 'kody:runtime'
export default {
	async fetch() {
		const storage = packageStorage()
		return Response.json({
			kv: await storage.get('seed'),
			sql: (await storage.sql('SELECT value FROM seeds')).rows,
		})
	},
}
`,
			}))
				await writeFile(join(root, path), content)
			process.chdir(root)
			const execute = async (source: Array<string>, value: string) => {
				let output = ''
				let errors = ''
				const code = await runCli(
					[
						'execute',
						'--local',
						'--target',
						'mock',
						...source,
						'--params',
						JSON.stringify({ value }),
					],
					{
						stdout: (text) => {
							output += text
						},
						stderr: (text) => {
							errors += text
						},
					},
				)
				assert.equal(code, 0, `${errors}\n${output}`)
				assert.match(output, new RegExp(value))
				return errors
			}
			assert.match(
				await execute(['--invoke', './seed'], 'boot'),
				/Starting one-shot local Kody/,
			)
			const manifest = await loadPackageManifest(root)
			const reservation = createServer()
			await new Promise<void>((done) =>
				reservation.listen(0, '127.0.0.1', done),
			)
			const port = (reservation.address() as AddressInfo).port
			await new Promise<void>((done) => reservation.close(() => done()))
			kody = await startLocalKody({ manifest, packageAppPort: port })
			server = await startPackageAppDev({
				manifest,
				localKody: createLocalKodyUpstream({ kody, manifest }),
				target: 'mock',
				apiUrl: kody.origin,
				token: kody.apiToken,
				port,
			})
			await writeDevRegistration({
				pid: process.pid,
				root,
				target: 'mock',
				origin: server.localUrl,
				port,
				basePath: server.appBasePath,
				localKody: { origin: kody.origin, apiToken: kody.apiToken },
			})
			const readApp = () =>
				new Promise<unknown>((done, fail) => {
					const req = request(
						server!.localUrl,
						{ headers: { host: new URL(server!.hostedUrl).host } },
						(res) => {
							let text = ''
							res.on('data', (chunk) => {
								text += chunk
							})
							res.on('end', () => {
								try {
									assert.equal(res.statusCode, 200, text)
									done(JSON.parse(text))
								} catch (error) {
									fail(error)
								}
							})
						},
					)
					req.on('error', fail)
					req.end()
				})
			assert.deepEqual(await readApp(), {
				kv: 'boot',
				sql: [{ value: 'boot' }],
			})
			assert.doesNotMatch(
				await execute(['--file', './src/seed.ts'], 'attached'),
				/Starting one-shot/,
			)
			assert.deepEqual(await readApp(), {
				kv: 'attached',
				sql: [{ value: 'attached' }],
			})
			const status = await fetch(`${server.localUrl}/__kody/dev/status`).then(
				(response) => response.text(),
			)
			assert.ok(!status.includes(kody.apiToken))
			assert.ok(!status.includes('localKody'))
			assert.equal(existsSync(join(cache, 'mock-sessions')), false)
		} finally {
			await removeDevRegistration(root, process.pid, 'mock')
			await server?.close()
			await kody?.close()
			process.chdir(previous.cwd)
			if (previous.cache === undefined) delete process.env.KODY_CACHE_DIR
			else process.env.KODY_CACHE_DIR = previous.cache
			if (previous.stub === undefined) delete process.env.KODY_DEV_STUB_RUNTIME
			else process.env.KODY_DEV_STUB_RUNTIME = previous.stub
			await rm(root, { recursive: true, force: true, maxRetries: 10 })
			await rm(cache, { recursive: true, force: true, maxRetries: 10 })
		}
	},
)
