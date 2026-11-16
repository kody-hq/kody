import assert from 'node:assert/strict'
import {
	createServer,
	request,
	type IncomingHttpHeaders,
	type Server,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import type { DevServerStatus } from '../src/dev/dev-registry.js'
import type { LocalKodyUpstream } from '../src/package-app-dev.js'
import { withDevServer } from './dev-server-harness.js'

type Seen = {
	host: string
	path: string
	cookie: string | null
	origin: string | null
}

// Stands in for local Kody: records what the proxy sends and echoes the
// request URL the way the worker builds it, from the Host header.
async function startFakeLocalKody(): Promise<{
	upstream: LocalKodyUpstream
	seen: Array<Seen>
	signIns: Array<boolean>
	close: () => Promise<void>
}> {
	const seen: Array<Seen> = []
	const signIns: Array<boolean> = []
	const server: Server = createServer((req, res) => {
		const host = req.headers.host ?? ''
		seen.push({
			host,
			path: req.url ?? '',
			cookie: req.headers.cookie ?? null,
			origin: req.headers.origin ?? null,
		})
		res.writeHead(200, {
			'content-type': 'application/json',
			'set-cookie': 'app_pref=dark; Path=/',
		})
		res.end(JSON.stringify({ url: `http://${host}${req.url}` }))
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	return {
		seen,
		signIns,
		upstream: {
			origin: `http://127.0.0.1:${port}`,
			username: 'user',
			appSessionCookie: async ({ rootMounted }) => {
				signIns.push(rootMounted)
				return 'kody_pkg_session=local'
			},
			sync: async () => {},
			listOutbox: async () => [],
			packageId: () => 'local-package-id',
			call: async () => null,
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections()
				server.close(() => resolve())
			}),
	}
}

// Node cannot resolve `*.localhost` on every platform, so connect to the
// loopback address and send the Host a browser would.
function get(input: {
	localUrl: string
	host: string
	path: string
	method?: string
	headers?: Record<string, string>
}) {
	return new Promise<{
		status: number
		headers: IncomingHttpHeaders
		body: string
	}>((resolve, reject) => {
		const req = request(
			new URL(input.path, input.localUrl),
			{
				method: input.method ?? 'GET',
				headers: { host: input.host, ...input.headers },
			},
			(res) => {
				let body = ''
				res.on('data', (chunk) => (body += chunk))
				res.on('end', () =>
					resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
				)
			},
		)
		req.on('error', reject)
		req.end()
	})
}

test('mock target serves the app at the root of its own {leaf}--{handle}.localhost origin', async () => {
	const fake = await startFakeLocalKody()
	try {
		await withDevServer(
			async ({ server }) => {
				const appHost = `sample-dev-package--user.localhost:${server.port}`
				assert.equal(server.hostedUrl, `http://${appHost}`)
				assert.equal(server.localUrl, `http://127.0.0.1:${server.port}`)
				assert.equal(server.appBasePath, '')
				assert.equal(server.packageContext.hostedUrl, `http://${appHost}`)
				const status = server.status() as DevServerStatus
				assert.equal(status.url, `http://${appHost}/`)
				assert.equal(status.basePath, '')

				// The Host and path reach local Kody unchanged, the session is
				// added to the browser's own cookies, and the app's cookie passes
				// back as a host-only cookie at Path=/.
				const page = await get({
					localUrl: server.localUrl,
					host: appHost,
					path: '/notes/1?tab=a',
					headers: { cookie: 'app_pref=light' },
				})
				assert.equal(page.status, 200)
				assert.equal(
					(JSON.parse(page.body) as { url: string }).url,
					`http://${appHost}/notes/1?tab=a`,
				)
				assert.deepEqual(page.headers['set-cookie'], ['app_pref=dark; Path=/'])
				assert.deepEqual(fake.seen.at(-1), {
					host: appHost,
					path: '/notes/1?tab=a',
					cookie: 'app_pref=light; kody_pkg_session=local',
					origin: null,
				})

				// The loopback address is the same app: local Kody still sees the
				// app's host, and a same-origin POST stays same-origin.
				const fallbackHost = `127.0.0.1:${server.port}`
				const fallback = await get({
					localUrl: server.localUrl,
					host: fallbackHost,
					path: '/save',
					method: 'POST',
					headers: { origin: `http://${fallbackHost}` },
				})
				assert.equal(fallback.status, 200)
				assert.deepEqual(fake.seen.at(-1), {
					host: appHost,
					path: '/save',
					cookie: 'kody_pkg_session=local',
					origin: `http://${appHost}`,
				})

				// A cross-origin Origin is passed through for local Kody to reject.
				await get({
					localUrl: server.localUrl,
					host: appHost,
					path: '/save',
					method: 'POST',
					headers: { origin: 'http://evil.localhost' },
				})
				assert.equal(fake.seen.at(-1)?.origin, 'http://evil.localhost')

				const anonymous = await get({
					localUrl: server.localUrl,
					host: appHost,
					path: '/',
					headers: {
						'x-kody-dev-visitor': 'anonymous',
						cookie: 'kody_pkg_ticket_x=signed-in',
					},
				})
				assert.equal(anonymous.status, 200)
				assert.equal(fake.seen.at(-1)?.cookie, null)

				// Signed in once, for the root-mounted host.
				assert.deepEqual(fake.signIns, [true])

				const before = fake.seen.length
				for (const host of [
					`other--user.localhost:${server.port}`,
					`user.localhost:${server.port}`,
					'evil.example',
				]) {
					const rejected = await get({
						localUrl: server.localUrl,
						host,
						path: '/',
					})
					assert.equal(rejected.status, 400, host)
				}
				assert.equal(fake.seen.length, before)
			},
			{ localKody: fake.upstream },
		)
	} finally {
		await fake.close()
	}
})

test('mock target with --app-base-path serves the old path address on the owner host', async () => {
	const fake = await startFakeLocalKody()
	try {
		await withDevServer(
			async ({ server }) => {
				const ownerHost = `user.localhost:${server.port}`
				assert.equal(server.hostedUrl, `http://${ownerHost}`)
				assert.equal(server.appBasePath, '/sample-dev-package')
				assert.equal(
					(server.status() as DevServerStatus).url,
					`http://${ownerHost}/sample-dev-package`,
				)
				const page = await get({
					localUrl: server.localUrl,
					host: ownerHost,
					path: '/sample-dev-package/about',
				})
				assert.equal(page.status, 200)
				assert.deepEqual(fake.seen.at(-1), {
					host: ownerHost,
					path: '/sample-dev-package/about',
					cookie: 'kody_pkg_session=local',
					origin: null,
				})
				assert.deepEqual(fake.signIns, [false])
			},
			{ localKody: fake.upstream, appBasePath: '/sample-dev-package/' },
		)
		await assert.rejects(
			withDevServer(async () => {}, {
				localKody: fake.upstream,
				appBasePath: '/@user/packages/sample-dev-package',
			}),
			/is not an address local Kody serves.*pass \/sample-dev-package for the old path address/,
		)
		// A profile package (leaf equal to the owner handle) has no old path.
		await assert.rejects(
			withDevServer(async () => {}, {
				localKody: { ...fake.upstream, username: 'sample-dev-package' },
				appBasePath: '/sample-dev-package',
			}),
			/a profile package is only served at the root of its owner's host/,
		)
	} finally {
		await fake.close()
	}
})
