import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	ensureMockTarget,
	mintMockApiToken,
	startMockServer,
	withMockServer,
} from '../src/mock/mock-server.js'
import { mutateMockSession } from '../src/mock/mock-storage.js'

test('mock session + search + metaGetCurrentUser work', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-mock-cache-'))
	try {
		await withMockServer(
			{ sessionId: 't1', env: { KODY_CACHE_DIR: cache }, resetStorage: true },
			async (server) => {
				const token = mintMockApiToken(server.sessionId)
				const me = await fetch(`${server.url}/v1/me`, {
					headers: { authorization: `Bearer ${token}` },
				})
				assert.equal(me.status, 200)
				const meBody = (await me.json()) as {
					user_id: string
					username: string
					org: { slug: string }
				}
				assert.equal(meBody.username, 'mock-user')
				assert.equal(meBody.user_id, 'user_mock')
				assert.equal(meBody.org.slug, 'mock-org')

				const search = await fetch(`${server.url}/v1/search?query=local`, {
					headers: { authorization: `Bearer ${token}` },
				})
				assert.equal(search.status, 200)
				const searchBody = (await search.json()) as {
					matches: Array<{ id: string }>
				}
				assert.ok(searchBody.matches.some((m) => m.id === 'local_execute'))
			},
		)
	} finally {
		await rm(cache, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		})
	}
})

test('mock CapabilityProxy call for metaGetCurrentUser', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-mock-cache-'))
	try {
		const server = await startMockServer({
			sessionId: 'cap',
			env: { KODY_CACHE_DIR: cache },
			resetStorage: true,
		})
		try {
			const token = mintMockApiToken(server.sessionId)
			const response = await fetch(`${server.url}/v1/capability-proxy/call`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					path: ['kody', 'metaGetCurrentUser'],
					args: [{}],
				}),
			})
			assert.equal(response.status, 200)
			const body = (await response.json()) as {
				result: { user_id: string; org: { slug: string } }
			}
			assert.equal(body.result.user_id, 'user_mock')
			assert.equal(body.result.org.slug, 'mock-org')
		} finally {
			await server.close()
		}
	} finally {
		await rm(cache, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		})
	}
})

test('mock refuses unimplemented capability paths with not_implemented_in_mock', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-mock-cache-'))
	try {
		await withMockServer(
			{
				sessionId: 'refuse',
				env: { KODY_CACHE_DIR: cache },
				resetStorage: true,
			},
			async (server) => {
				const token = mintMockApiToken(server.sessionId)
				const response = await fetch(`${server.url}/v1/capability-proxy/call`, {
					method: 'POST',
					headers: {
						authorization: `Bearer ${token}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify({ path: ['kody', 'emailSend'], args: [{}] }),
				})
				assert.equal(response.status, 501)
				const body = (await response.json()) as {
					error: { code: string; target: string }
				}
				assert.equal(body.error.code, 'not_implemented_in_mock')
				assert.equal(body.error.target, 'mock')
			},
		)
	} finally {
		await rm(cache, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		})
	}
})

test('mock package-graph returns empty modules', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-mock-cache-'))
	try {
		await withMockServer(
			{
				sessionId: 'graph',
				env: { KODY_CACHE_DIR: cache },
				resetStorage: true,
			},
			async (server) => {
				const token = mintMockApiToken(server.sessionId)
				const response = await fetch(
					`${server.url}/v1/local-execute/package-graph`,
					{
						method: 'POST',
						headers: {
							authorization: `Bearer ${token}`,
							'content-type': 'application/json',
						},
						body: JSON.stringify({ code: 'export default async () => ({})' }),
					},
				)
				assert.equal(response.status, 200)
				const body = (await response.json()) as { modules: Array<unknown> }
				assert.deepEqual(body.modules, [])
			},
		)
	} finally {
		await rm(cache, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		})
	}
})

test('ensureMockTarget mints a bearer and can reset storage', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-mock-cache-'))
	const previous = process.env.KODY_CACHE_DIR
	process.env.KODY_CACHE_DIR = cache
	try {
		const first = await ensureMockTarget({
			sessionId: 'ensure',
			resetStorage: true,
		})
		await mutateMockSession({ sessionId: 'ensure' }, (state) => {
			state.packageStorage['p'] = { rows: { a: 1 } }
		})
		assert.deepEqual((await first.server.state()).packageStorage, {
			p: { rows: { a: 1 } },
		})
		await first.server.close()
		const second = await ensureMockTarget({
			sessionId: 'ensure',
			resetStorage: true,
		})
		assert.deepEqual((await second.server.state()).packageStorage, {})
		await second.server.close()
		assert.ok(second.token.startsWith('kody_mock_'))
	} finally {
		if (previous === undefined) delete process.env.KODY_CACHE_DIR
		else process.env.KODY_CACHE_DIR = previous
		await rm(cache, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		})
	}
})

test('mock credentialClientOpen returns hosts so credential() can iterate', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-mock-cred-'))
	try {
		await withMockServer(
			{ sessionId: 'cred', env: { KODY_CACHE_DIR: cache }, resetStorage: true },
			async (server) => {
				const token = mintMockApiToken(server.sessionId)
				const response = await fetch(`${server.url}/v1/capability-proxy/call`, {
					method: 'POST',
					headers: {
						authorization: `Bearer ${token}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						path: ['kody', 'credentialClientOpen'],
						args: [{ key: 'MOCK_SECRET' }],
					}),
				})
				assert.equal(response.status, 200)
				const body = (await response.json()) as {
					result: {
						ok: boolean
						value: { hosts: Array<string>; name: string; kind: string }
					}
				}
				assert.equal(body.result.ok, true)
				assert.equal(body.result.value.name, 'MOCK_SECRET')
				assert.ok(Array.isArray(body.result.value.hosts))
				assert.ok(body.result.value.hosts.length > 0)
			},
		)
	} finally {
		await rm(cache, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		})
	}
})

test('mock credentials OpenAll + authenticatedFetch + adminUserList fixtures', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-mock-ops-'))
	try {
		await withMockServer(
			{ sessionId: 'ops', env: { KODY_CACHE_DIR: cache }, resetStorage: true },
			async (server) => {
				const token = mintMockApiToken(server.sessionId)
				const call = async (
					path: Array<string>,
					args: Array<unknown> = [{}],
				) => {
					const response = await fetch(
						`${server.url}/v1/capability-proxy/call`,
						{
							method: 'POST',
							signal: AbortSignal.timeout(30_000),
							headers: {
								authorization: `Bearer ${token}`,
								'content-type': 'application/json',
							},
							body: JSON.stringify({ path, args }),
						},
					)
					assert.equal(response.status, 200)
					return (await response.json()) as { result: unknown }
				}

				const openAll = (await call(
					['kody', 'credentialClientOpenAll'],
					[{ key: 'MOCK_SECRET' }],
				)) as {
					result: {
						ok: boolean
						value: Array<{ name: string; hosts: Array<string> }>
					}
				}
				assert.equal(openAll.result.ok, true)
				assert.equal(openAll.result.value.length, 1)
				assert.equal(openAll.result.value[0]?.name, 'MOCK_SECRET')

				const oauthResponse = await fetch(
					`${server.url}/v1/capability-proxy/call`,
					{
						method: 'POST',
						signal: AbortSignal.timeout(30_000),
						headers: {
							authorization: `Bearer ${token}`,
							'content-type': 'application/json',
						},
						body: JSON.stringify({
							path: ['kody', 'authenticatedFetch'],
							args: [
								{
									providerName: 'linkedin',
									request: {
										url: 'https://api.linkedin.com/v2/userinfo',
										method: 'GET',
									},
								},
							],
						}),
					},
				)
				assert.equal(oauthResponse.status, 400)
				const oauthBody = (await oauthResponse.json()) as {
					error: { code: string }
				}
				assert.equal(oauthBody.error.code, 'unmocked_request')

				const storage = (await call(
					['kody', 'packageStorageSet'],
					[{ key: 'k', value: 1 }],
				)) as { result: { ok: boolean } }
				assert.equal(storage.result.ok, true)
				const got = (await call(
					['kody', 'packageStorageGet'],
					[{ key: 'k' }],
				)) as {
					result: { value: number }
				}
				assert.equal(got.result.value, 1)

				const create = (await call(
					['kody', 'packageStorageSql'],
					[
						{
							query:
								'CREATE TABLE IF NOT EXISTS sightings (file_id TEXT PRIMARY KEY, name TEXT NOT NULL)',
						},
					],
				)) as { result: { rows: Array<unknown> } }
				assert.deepEqual(create.result.rows, [])
				await call(
					['kody', '__mockPackageStorageSql'],
					[
						{
							query: 'INSERT INTO sightings (file_id, name) VALUES (?, ?)',
							bindings: ['f1', 'a.txt'],
						},
					],
				)
				const selected = (await call(
					['kody', 'packageStorageSql'],
					[{ query: 'SELECT file_id, name FROM sightings ORDER BY file_id' }],
				)) as { result: { rows: Array<{ file_id: string; name: string }> } }
				assert.deepEqual(selected.result.rows, [
					{ file_id: 'f1', name: 'a.txt' },
				])

				const admin = (await call(
					['kody', 'adminUserList'],
					[{ page: 1 }],
				)) as {
					result: {
						total: number
						page: number
						pageSize: number
						users: Array<{ username: string; stableUserId: string }>
					}
				}
				assert.equal(admin.result.total, 1)
				assert.equal(admin.result.page, 1)
				assert.equal(admin.result.pageSize, 20)
				assert.equal(admin.result.users[0]?.username, 'mock-user')
				assert.equal(admin.result.users[0]?.stableUserId, 'user_mock')
			},
		)
	} finally {
		await rm(cache, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		})
	}
})

async function storageCall(
	server: { url: string; sessionId: string },
	name: string,
	input: unknown,
) {
	const res = await fetch(`${server.url}/v1/capability-proxy/call`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${mintMockApiToken(server.sessionId)}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify({ path: ['kody', name], args: [input] }),
	})
	return { status: res.status, body: (await res.json()) as any }
}

test('a running mock sees outside writes and never overwrites them', async () => {
	const cache = await mkdtemp(join(tmpdir(), 'kody-mock-cache-'))
	const env = { ...process.env, KODY_CACHE_DIR: cache }
	// `kody dev` and a separate `kody execute --target mock` each start a mock
	// on the same session store.
	const dev = await startMockServer({
		sessionId: 'shared',
		packageId: 'p',
		env,
	})
	const outside = await startMockServer({
		sessionId: 'shared',
		packageId: 'p',
		env,
	})
	try {
		await storageCall(dev, 'packageStorageSet', { key: 'a', value: 'dev' })
		const set = await storageCall(outside, 'packageStorageSet', {
			key: 'b',
			value: 'outside',
		})
		assert.deepEqual(set.body, { result: { ok: true } })
		const seen = await storageCall(dev, 'packageStorageGet', { key: 'b' })
		assert.deepEqual(seen.body, { result: { value: 'outside' } })

		const statePath = join(cache, 'mock-sessions', 'shared', 'state.json')
		const onDisk = JSON.parse(await readFile(statePath, 'utf8'))
		onDisk.packageStorage.p.rows.c = 'hand edit'
		await writeFile(statePath, JSON.stringify(onDisk))

		await storageCall(dev, 'packageStorageSet', { key: 'd', value: 'dev' })
		await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				storageCall(i % 2 ? dev : outside, 'packageStorageSet', {
					key: `k${i}`,
					value: i,
				}),
			),
		)
		const list = await storageCall(dev, 'packageStorageList', {})
		const rows = Object.fromEntries(
			list.body.result.entries.map((e: { key: string; value: unknown }) => [
				e.key,
				e.value,
			]),
		)
		assert.equal(rows.a, 'dev')
		assert.equal(rows.b, 'outside')
		assert.equal(rows.c, 'hand edit')
		assert.equal(rows.d, 'dev')
		for (let i = 0; i < 10; i++) assert.equal(rows[`k${i}`], i)

		await writeFile(statePath, '{ "version": 1, ')
		const refused = await storageCall(dev, 'packageStorageSet', {
			key: 'e',
			value: 'lost?',
		})
		assert.equal(refused.status, 409)
		assert.equal(refused.body.error.code, 'mock_store_unreadable')
		assert.match(refused.body.error.message, /not valid JSON/)
		assert.match(refused.body.error.message, /--reset-storage/)
		assert.equal(await readFile(statePath, 'utf8'), '{ "version": 1, ')
	} finally {
		await dev.close()
		await outside.close()
		await rm(cache, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		})
	}
})
