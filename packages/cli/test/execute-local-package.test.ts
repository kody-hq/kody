import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
	chmod,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { runCli } from '../src/cli.js'
import { findLocalPackageExport } from '../src/dev/execute-local-package.js'
import {
	devRegistryPath,
	findRunningDevServer,
	writeDevRegistration,
} from '../src/dev/dev-registry.js'
import { ensureMockTarget } from '../src/mock/mock-server.js'
import { localKodyStateDir } from '../src/dev/local-kody.js'

test('Windows registration credentials stay within the user cache without getuid', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-win-registration-'))
	const outside = await mkdtemp(join(tmpdir(), 'kody-other-registration-'))
	const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
	const getuid = Object.getOwnPropertyDescriptor(process, 'getuid')
	const previousCache = process.env.KODY_CACHE_DIR
	try {
		process.env.KODY_CACHE_DIR = cache
		Object.defineProperty(process, 'platform', {
			value: 'win32',
			configurable: true,
		})
		Object.defineProperty(process, 'getuid', {
			value: undefined,
			configurable: true,
		})
		const registration = {
			pid: process.pid,
			root: cache,
			target: 'mock' as const,
			origin: 'http://127.0.0.1:4321',
			port: 4321,
			basePath: '',
			localKody: { origin: 'http://127.0.0.1:4322', apiToken: 'private-token' },
		}
		await writeDevRegistration(registration)
		const running = await findRunningDevServer({
			root: cache,
			target: 'mock',
			fetchFn: async () =>
				Response.json({ package: { root: cache }, target: 'mock' }),
		})
		assert.deepEqual(running?.registration.localKody, registration.localKody)
		const external = await writeDevRegistration(registration, outside)
		assert.equal(
			JSON.parse(await readFile(external, 'utf8')).localKody,
			undefined,
		)
	} finally {
		Object.defineProperty(process, 'platform', platform)
		if (getuid) Object.defineProperty(process, 'getuid', getuid)
		else delete (process as { getuid?: unknown }).getuid
		if (previousCache === undefined) delete process.env.KODY_CACHE_DIR
		else process.env.KODY_CACHE_DIR = previousCache
		await rm(cache, { recursive: true, force: true })
		await rm(outside, { recursive: true, force: true })
	}
})

test('declared exports execute through a private attached local Kody session', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'kody-export-')))
	const cache = await mkdtemp(join(tmpdir(), 'kody-export-cache-'))
	const previous = { cwd: process.cwd(), cache: process.env.KODY_CACHE_DIR }
	const calls: Array<{ path: string; body: any; authorization?: string }> = []
	let fail = false
	const api = createServer(async (req, res) => {
		let text = ''
		for await (const chunk of req) text += chunk
		calls.push({
			path: req.url!,
			body: text ? JSON.parse(text) : null,
			authorization: req.headers.authorization,
		})
		res.setHeader('content-type', 'application/json')
		if (req.url === '/__kody/dev/status') {
			res.end(JSON.stringify({ package: { root }, target: 'mock' }))
		} else if (req.url === '/__kody/dev/call') {
			res.end(JSON.stringify({ result: null }))
		} else if (req.url === '/v1/execute') {
			res.end(
				JSON.stringify({
					content: [
						{ type: 'text', text: fail ? 'Error: seed failed' : 'seeded' },
					],
					structuredContent: {},
					isError: fail,
				}),
			)
		} else {
			res.writeHead(404).end()
		}
	})
	await new Promise<void>((done) => api.listen(0, '127.0.0.1', done))
	const port = (api.address() as AddressInfo).port
	const origin = `http://127.0.0.1:${port}`
	try {
		process.env.KODY_CACHE_DIR = cache
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				name: '@seed/app',
				exports: { './seed': './seed.ts' },
			}),
		)
		await writeFile(join(root, 'seed.ts'), 'export default () => 1')
		await writeFile(
			join(root, 'other.ts'),
			'import { packageStorage } from "kody:runtime"; export default async () => packageStorage().set("seed", 2)',
		)
		await writeDevRegistration({
			pid: process.pid,
			root,
			target: 'mock',
			origin,
			port,
			basePath: '',
			localKody: { origin, apiToken: 'private-local-token' },
		})
		const registration = devRegistryPath(root, 'mock')
		if (process.platform !== 'win32')
			assert.equal((await stat(registration)).mode & 0o777, 0o600)
		process.chdir(root)
		for (const source of [
			['--invoke', './seed'],
			['--file', './seed.ts'],
		]) {
			let output = ''
			assert.equal(
				await runCli(['execute', '--local', '--target', 'mock', ...source], {
					stdout: (text) => {
						output += text
					},
					stderr: () => {},
				}),
				0,
				output,
			)
			assert.match(output, /seeded/)
		}
		const executes = calls.filter((call) => call.path === '/v1/execute')
		assert.equal(executes.length, 2)
		const beforeReset = calls.length
		let resetOutput = ''
		assert.equal(
			await runCli(
				[
					'execute',
					'--local',
					'--target',
					'mock',
					'--invoke',
					'./seed',
					'--reset-storage',
				],
				{
					stdout: (text) => {
						resetOutput += text
					},
					stderr: (text) => {
						resetOutput += text
					},
				},
			),
			1,
		)
		assert.match(
			resetOutput,
			/--reset-storage cannot reset the shared local package store/,
		)
		assert.match(resetOutput, /Stop kody dev, then delete that directory/)
		assert.ok(resetOutput.includes(localKodyStateDir(root)))
		assert.equal(calls.length, beforeReset)
		for (const call of executes) {
			assert.match(call.body.code, /import action from "kody:@seed\/app\/seed"/)
			assert.equal(call.authorization, 'Bearer private-local-token')
		}
		assert.equal(
			calls.filter((call) => call.body?.operation === 'sync').length,
			2,
		)
		assert.equal(
			await findLocalPackageExport({ modulePath: './other.ts' }),
			null,
		)
		assert.equal(
			await findLocalPackageExport({ cwd: cache, modulePath: './missing.ts' }),
			null,
		)
		for (const source of [
			['--file', './other.ts'],
			[
				'--code',
				'import { packageStorage } from "kody:runtime"; export default async () => packageStorage().sql("SELECT 1")',
			],
		]) {
			let output = ''
			assert.equal(
				await runCli(['execute', '--local', '--target', 'mock', ...source], {
					stdout: (text) => {
						output += text
					},
					stderr: (text) => {
						output += text
					},
				}),
				1,
				output,
			)
			assert.match(
				output,
				/Local package state is only reachable from package exports/,
			)
			assert.match(output, /execute --local --target mock --invoke <export>/)
		}
		if (process.platform !== 'win32') {
			await symlink(root, join(cache, 'linked'))
			assert.equal(
				(
					await findLocalPackageExport({
						cwd: join(cache, 'linked'),
						modulePath: './seed.ts',
					})
				)?.manifest.root,
				root,
			)
			await chmod(registration, 0o644)
			assert.equal(
				(await findRunningDevServer({ root, target: 'mock' }))?.registration
					.localKody,
				undefined,
			)
			let output = ''
			assert.equal(
				await runCli(
					['execute', '--local', '--target', 'mock', '--invoke', './seed'],
					{
						stdout: (text) => {
							output += text
						},
						stderr: (text) => {
							output += text
						},
					},
				),
				1,
			)
			assert.match(output, /Restart kody dev/)
			await chmod(registration, 0o400)
			assert.equal(
				(await findRunningDevServer({ root, target: 'mock' }))?.registration
					.localKody,
				undefined,
			)
			await chmod(registration, 0o600)
		}
		fail = true
		assert.equal(
			await runCli(
				['execute', '--local', '--target', 'mock', '--invoke', './seed'],
				{
					stdout: () => {},
					stderr: () => {},
				},
			),
			1,
		)
		assert.match(await readFile(registration, 'utf8'), /private-local-token/)
	} finally {
		process.chdir(previous.cwd)
		if (previous.cache === undefined) delete process.env.KODY_CACHE_DIR
		else process.env.KODY_CACHE_DIR = previous.cache
		api.closeAllConnections()
		await new Promise<void>((done) => api.close(() => done()))
		await rm(root, { recursive: true, force: true })
		await rm(cache, { recursive: true, force: true })
	}
})

test('execute mock storage capabilities refuse scratch writes while other capabilities still work', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-no-scratch-'))
	const mock = await ensureMockTarget({
		allowPackageStorage: false,
		env: { KODY_CACHE_DIR: cache },
	})
	try {
		for (const name of [
			'packageStorageSet',
			'packageStorageSql',
			'__mockPackageStorageGet',
		]) {
			const response = await fetch(`${mock.apiUrl}/v1/capability-proxy/call`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${mock.token}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					path: ['kody', name],
					args: [
						{ key: 'seed', value: 1, query: 'CREATE TABLE seed (id INTEGER)' },
					],
				}),
			})
			assert.equal(response.status, 501)
			const body = await response.text()
			assert.match(
				body,
				/Local package state is only reachable from package exports/,
			)
			assert.match(body, /execute --local --target mock --invoke <export>/)
		}
		assert.deepEqual((await mock.server.state()).packageStorage, {})
		const response = await fetch(`${mock.apiUrl}/v1/capability-proxy/call`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${mock.token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ path: ['kody', 'metaGetCurrentUser'], args: [] }),
		})
		assert.equal(response.status, 200)
	} finally {
		await mock.server.close()
		await rm(cache, { recursive: true, force: true })
	}
})

test('local export files match the runtime import target before default', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kody-export-conditions-'))
	try {
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				name: '@seed/conditions',
				exports: {
					'./seed': { default: './default.ts', import: './import.ts' },
					'./fallback': { default: './default.ts' },
					'./require': { require: './require.ts' },
				},
			}),
		)
		for (const file of ['default.ts', 'import.ts', 'require.ts'])
			await writeFile(join(root, file), 'export default () => 1')
		assert.equal(
			(await findLocalPackageExport({ cwd: root, modulePath: './import.ts' }))
				?.key,
			'./seed',
		)
		assert.equal(
			(await findLocalPackageExport({ cwd: root, modulePath: './default.ts' }))
				?.key,
			'./fallback',
		)
		assert.equal(
			await findLocalPackageExport({ cwd: root, modulePath: './require.ts' }),
			null,
		)
		assert.equal(
			(
				await findLocalPackageExport({
					cwd: root,
					modulePath: './default.ts',
					exportKey: './seed',
				})
			)?.key,
			'./seed',
		)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
