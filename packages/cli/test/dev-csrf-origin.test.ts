/**
 * kody dev must expose the trusted listen origin on request.url so app CSRF
 * checks (Origin === new URL(request.url).origin) work. Never copy the
 * incoming Host through to workerd (DNS rebinding).
 */

import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { test } from 'node:test'
import { withDevServer } from './dev-server-harness.js'

const csrfAppEntry = `export default {
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === 'GET') {
      return Response.json({
        url: request.url,
        origin: url.origin,
        host: request.headers.get('host'),
      })
    }
    if (request.method === 'POST') {
      const origin = request.headers.get('origin')
      if (!origin || origin !== url.origin) {
        return new Response('csrf', { status: 403 })
      }
      return new Response('ok', { status: 200 })
    }
    return new Response('method', { status: 405 })
  },
}
`

// Sends the Host a browser on `hostedUrl` would, over the loopback address:
// Node cannot resolve `*.localhost` on every platform.
function proxyRequest(
	server: { hostedUrl: string; localUrl: string },
	input: {
		method: string
		path: string
		headers?: Record<string, string>
		body?: string
	},
): Promise<{ status: number; body: string }> {
	const url = new URL(input.path, server.localUrl)
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			url,
			{
				method: input.method,
				headers: {
					host: new URL(server.hostedUrl).host,
					...input.headers,
				},
			},
			(res) => {
				const chunks: Array<Buffer> = []
				res.on('data', (chunk) => chunks.push(chunk))
				res.on('end', () => {
					resolve({
						status: res.statusCode ?? 0,
						body: Buffer.concat(chunks).toString('utf8'),
					})
				})
			},
		)
		req.on('error', reject)
		if (input.body !== undefined) req.write(input.body)
		req.end()
	})
}

test('kody dev request.url uses the trusted listen origin', async () => {
	await withDevServer(
		async ({ server }) => {
			const response = await proxyRequest(server, {
				method: 'GET',
				path: '/',
			})
			assert.equal(response.status, 200)
			const body = JSON.parse(response.body) as {
				url: string
				origin: string
				host: string
			}
			const expected = new URL(server.hostedUrl)
			assert.equal(body.origin, expected.origin)
			assert.equal(body.host, expected.host)
			assert.equal(new URL(body.url).origin, expected.origin)
			assert.equal(new URL(body.url).port, expected.port)
		},
		{
			prepare: async (root) => {
				await writeFile(join(root, 'app/entry.ts'), csrfAppEntry)
			},
		},
	)
})

test('same-origin POST passes app CSRF; cross-origin POST gets 403', async () => {
	await withDevServer(
		async ({ server }) => {
			const origin = new URL(server.hostedUrl).origin
			const same = await proxyRequest(server, {
				method: 'POST',
				path: '/form',
				headers: {
					origin,
					'content-type': 'application/x-www-form-urlencoded',
				},
				body: 'a=1',
			})
			assert.equal(same.status, 200)
			assert.equal(same.body, 'ok')

			const cross = await proxyRequest(server, {
				method: 'POST',
				path: '/form',
				headers: {
					origin: 'http://evil.example',
					'content-type': 'application/x-www-form-urlencoded',
				},
				body: 'a=1',
			})
			assert.equal(cross.status, 403)
			assert.equal(cross.body, 'csrf')

			// The loopback address is the same app: it is presented on the app's
			// origin, so a same-origin POST from there still passes.
			const loopback = {
				hostedUrl: server.localUrl,
				localUrl: server.localUrl,
			}
			const viaLoopback = await proxyRequest(loopback, {
				method: 'POST',
				path: '/form',
				headers: {
					origin: server.localUrl,
					'content-type': 'application/x-www-form-urlencoded',
				},
				body: 'a=1',
			})
			assert.equal(viaLoopback.status, 200)
			const seen = await proxyRequest(loopback, { method: 'GET', path: '/' })
			assert.equal((JSON.parse(seen.body) as { origin: string }).origin, origin)
		},
		{
			prepare: async (root) => {
				await writeFile(join(root, 'app/entry.ts'), csrfAppEntry)
			},
		},
	)
})

test('unrecognized Host is rejected before the package app runs', async () => {
	await withDevServer(
		async ({ server }) => {
			const url = new URL(server.localUrl)
			const rejected = await new Promise<{ status: number; body: string }>(
				(resolve, reject) => {
					const req = httpRequest(
						{
							hostname: url.hostname,
							port: url.port,
							path: '/',
							method: 'GET',
							headers: { host: 'evil.example' },
						},
						(res) => {
							const chunks: Array<Buffer> = []
							res.on('data', (chunk) => chunks.push(chunk))
							res.on('end', () => {
								resolve({
									status: res.statusCode ?? 0,
									body: Buffer.concat(chunks).toString('utf8'),
								})
							})
						},
					)
					req.on('error', reject)
					req.end()
				},
			)
			assert.equal(rejected.status, 400)
			assert.match(rejected.body, /Unrecognized Host/)
			assert.match(rejected.body, /evil\.example/)
		},
		{
			prepare: async (root) => {
				await writeFile(join(root, 'app/entry.ts'), csrfAppEntry)
			},
		},
	)
})
