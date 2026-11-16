import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import type { DevServerStatus } from '../src/dev/dev-registry.js'
import type { LocalKodyUpstream } from '../src/package-app-dev.js'
import { withDevServer } from './dev-server-harness.js'

const mount = '/@user/packages/sample-dev-package'

// Stands in for local Kody: serves the app only under its username-path
// mount and renders links for that mount, like packageContext.appBasePath.
async function startFakeLocalKody(): Promise<{
	upstream: LocalKodyUpstream
	paths: Array<string>
	close: () => Promise<void>
}> {
	const paths: Array<string> = []
	const server: Server = createServer((req, res) => {
		const pathname = new URL(req.url ?? '/', 'http://local').pathname
		paths.push(pathname)
		const rest =
			pathname === mount
				? '/'
				: pathname.startsWith(`${mount}/`)
					? pathname.slice(mount.length)
					: null
		if (rest === '/') {
			res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
			res.end(`<a id="about" href="${mount}/about">about</a>`)
			return
		}
		if (rest === '/about') {
			res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
			res.end('about page')
			return
		}
		res.writeHead(404)
		res.end('not found')
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	return {
		paths,
		upstream: {
			origin: `http://127.0.0.1:${port}`,
			appPath: mount,
			cookie: 'kody_session=local',
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

test('mock target with local Kody serves the links it renders and reports the mount as basePath', async () => {
	const fake = await startFakeLocalKody()
	try {
		await withDevServer(
			async ({ server }) => {
				assert.equal(server.appBasePath, mount)
				const statusResponse = await fetch(
					`${server.localUrl}${mount}/__kody/dev/status`,
				)
				const status = (await statusResponse.json()) as DevServerStatus
				assert.equal(status.basePath, mount)
				assert.equal(status.url, `${server.hostedUrl}${mount}`)

				const page = await fetch(status.url)
				assert.equal(page.status, 200)
				const href = /href="([^"]+)"/.exec(await page.text())?.[1]
				assert.equal(href, `${mount}/about`)

				const linked = await fetch(new URL(href!, status.url))
				assert.equal(linked.status, 200)
				assert.equal(await linked.text(), 'about page')
				assert.deepEqual(fake.paths, [mount + '/', `${mount}/about`])
			},
			{ localKody: fake.upstream },
		)
	} finally {
		await fake.close()
	}
})

test('mock target with local Kody rejects an --app-base-path that disagrees with the mount', async () => {
	const fake = await startFakeLocalKody()
	try {
		await assert.rejects(
			withDevServer(async () => {}, {
				localKody: fake.upstream,
				appBasePath: '/sample-dev-package',
			}),
			/does not match the local Kody mount \/@user\/packages\/sample-dev-package/,
		)
		await withDevServer(
			async ({ server }) => {
				assert.equal(server.appBasePath, mount)
			},
			{ localKody: fake.upstream, appBasePath: `${mount}/` },
		)
	} finally {
		await fake.close()
	}
})
