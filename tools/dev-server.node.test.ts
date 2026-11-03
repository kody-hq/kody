import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from 'vitest'
import { findHealthyWorkerOrigin, isWorkerHealthOk } from './dev-server.ts'

function listenHealthServer() {
	const server = http.createServer((request, response) => {
		if (request.url === '/health') {
			response.writeHead(200, { 'content-type': 'application/json' })
			response.end(JSON.stringify({ ok: true }))
			return
		}
		response.writeHead(404)
		response.end()
	})
	return {
		server,
		async listen() {
			await new Promise<void>((resolve) => {
				server.listen(0, '127.0.0.1', () => resolve())
			})
			const address = server.address() as AddressInfo
			return address.port
		},
		async close() {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error)
					else resolve()
				})
			})
		},
	}
}

test('findHealthyWorkerOrigin returns the first origin whose /health is ok', async () => {
	const probed: Array<string> = []
	const origin = await findHealthyWorkerOrigin([3742, 3743, 3744], {
		probe: async (candidate) => {
			probed.push(candidate)
			return candidate === 'http://localhost:3743'
		},
	})
	expect(origin).toBe('http://localhost:3743')
	expect(probed).toEqual(['http://localhost:3742', 'http://localhost:3743'])
})

test('isWorkerHealthOk treats hung, failed, or live /health correctly', async () => {
	const ok = await isWorkerHealthOk('http://localhost:3742', {
		timeoutMs: 20,
		fetchImpl: async () =>
			new Response(JSON.stringify({ ok: true }), { status: 200 }),
	})
	expect(ok).toBe(true)

	const refused = await isWorkerHealthOk('http://localhost:3742', {
		timeoutMs: 20,
		fetchImpl: async () => {
			throw new Error('connect ECONNREFUSED')
		},
	})
	expect(refused).toBe(false)

	const hung = await isWorkerHealthOk('http://localhost:3742', {
		timeoutMs: 20,
		fetchImpl: async (_url, init) => {
			await new Promise<never>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					reject(new DOMException('aborted', 'AbortError'))
				})
			})
			return new Response('late')
		},
	})
	expect(hung).toBe(false)

	const health = listenHealthServer()
	try {
		const port = await health.listen()
		expect(await isWorkerHealthOk(`http://127.0.0.1:${port}`)).toBe(true)
		expect(await isWorkerHealthOk(`http://127.0.0.1:${port + 1}`)).toBe(false)
	} finally {
		await health.close()
	}
})
