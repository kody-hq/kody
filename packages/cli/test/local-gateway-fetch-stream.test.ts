import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { type AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import {
	callCapabilityProxyGatewayFetchStream,
	gatewayFetchHeadersHeaderName,
	gatewayFetchMethodHeaderName,
	gatewayFetchUrlHeaderName,
} from '../src/capability-proxy.js'
import { forwardLocalGatewayFetchStream } from '../src/local-gateway-fetch-forward.js'
import {
	localBridgeGatewayFetchPath,
	startLocalRuntimeBridge,
	writeWebResponse,
} from '../src/local-runtime-bridge.js'
import { runSecretHeader } from '../src/local-runtime-source.js'
import { createMockFetchGateway } from '../src/mock/mock-fetch-gateway.js'

test('callCapabilityProxyGatewayFetchStream posts metadata headers and streams the body', async () => {
	const chunks: Array<Buffer> = []
	let requestHeaders: Record<string, string | Array<string> | undefined> = {}
	const server = createServer((request, response) => {
		requestHeaders = { ...request.headers }
		request.on('data', (chunk: Buffer) => chunks.push(chunk))
		request.on('end', () => {
			response.writeHead(201, {
				'content-type': 'text/plain',
				'x-upstream': '1',
			})
			response.end('upstream-ok')
		})
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	try {
		const body = Readable.from([Buffer.from('hello-stream')])
		const response = await callCapabilityProxyGatewayFetchStream({
			apiUrl: `http://127.0.0.1:${port}`,
			token: 'kody_at_test',
			gateway: {
				url: 'https://example.com/upload',
				method: 'POST',
				packageId: 'pkg-1',
				headers: { authorization: 'Bearer {{secret:demo}}' },
				contentType: 'text/plain',
				secretResolution: 'on',
			},
			body,
			contentLength: String(Buffer.byteLength('hello-stream')),
		})
		assert.equal(response.status, 201)
		assert.equal(await response.text(), 'upstream-ok')
		assert.equal(
			requestHeaders[gatewayFetchUrlHeaderName.toLowerCase()],
			'https://example.com/upload',
		)
		assert.equal(
			requestHeaders[gatewayFetchMethodHeaderName.toLowerCase()],
			'POST',
		)
		assert.equal(requestHeaders['content-type'], 'text/plain')
		assert.equal(
			requestHeaders[gatewayFetchHeadersHeaderName.toLowerCase()],
			JSON.stringify({ authorization: 'Bearer {{secret:demo}}' }),
		)
		assert.equal(Buffer.concat(chunks).toString('utf8'), 'hello-stream')
		assert.equal(requestHeaders.authorization, 'Bearer kody_at_test')
	} finally {
		server.close()
	}
})

test('local runtime bridge streams gateway-fetch to the mock MSW gateway', async () => {
	const { http, HttpResponse } = await import('msw')
	const gateway = createMockFetchGateway({
		handlers: [
			http.post('https://api.example.com/upload', async ({ request }) => {
				const text = await request.text()
				return HttpResponse.json({ ok: true, echo: text }, { status: 202 })
			}),
		],
	})
	const bridge = await startLocalRuntimeBridge({
		runSecret: 'secret',
		forwardCall: async () => {
			throw new Error('JSON /call should not be used for gatewayFetchStream')
		},
		forwardGatewayFetchStream: async ({ request, response, signal }) => {
			await forwardLocalGatewayFetchStream({
				request,
				response,
				signal,
				client: {
					apiUrl: 'http://127.0.0.1:9',
					token: 'kody_at_unused',
				},
				mockFetchGateway: gateway,
			})
		},
	})
	try {
		const response = await fetch(
			`http://127.0.0.1:${bridge.port}${localBridgeGatewayFetchPath}`,
			{
				method: 'POST',
				headers: {
					[runSecretHeader]: 'secret',
					[gatewayFetchUrlHeaderName]: 'https://api.example.com/upload',
					[gatewayFetchMethodHeaderName]: 'POST',
					'content-type': 'text/plain',
				},
				body: 'payload-bytes',
				duplex: 'half',
			} as RequestInit,
		)
		assert.equal(response.status, 202)
		assert.deepEqual(await response.json(), {
			ok: true,
			echo: 'payload-bytes',
		})
	} finally {
		await bridge.close()
	}
})

test('bridge gateway-fetch failures return Open API error envelopes (no-store)', async () => {
	const bridge = await startLocalRuntimeBridge({
		runSecret: 'secret',
		forwardCall: async () => null,
		forwardGatewayFetchStream: async () => {
			throw new Error('upstream blew up')
		},
	})
	try {
		const response = await fetch(
			`http://127.0.0.1:${bridge.port}${localBridgeGatewayFetchPath}`,
			{
				method: 'POST',
				headers: {
					[runSecretHeader]: 'secret',
					[gatewayFetchUrlHeaderName]: 'https://api.example.com/upload',
				},
				body: 'x',
				duplex: 'half',
			} as RequestInit,
		)
		assert.equal(response.status, 502)
		assert.match(response.headers.get('cache-control') ?? '', /no-store/)
		assert.deepEqual(await response.json(), {
			error: { code: 'gateway_fetch_failed', message: 'upstream blew up' },
		})
	} finally {
		await bridge.close()
	}
})

test('mock gateway-fetch null-body statuses do not throw', async () => {
	const gateway = createMockFetchGateway({
		handlers: [],
		passthroughAll: true,
		fetchFn: (async () =>
			new Response(null, {
				status: 204,
				statusText: 'No Content',
			})) as typeof fetch,
	})
	const bridge = await startLocalRuntimeBridge({
		runSecret: 'secret',
		forwardCall: async () => null,
		forwardGatewayFetchStream: async ({ request, response, signal }) => {
			await forwardLocalGatewayFetchStream({
				request,
				response,
				signal,
				client: { apiUrl: 'http://127.0.0.1:9', token: 'kody_at_unused' },
				mockFetchGateway: gateway,
			})
		},
	})
	try {
		const response = await fetch(
			`http://127.0.0.1:${bridge.port}${localBridgeGatewayFetchPath}`,
			{
				method: 'POST',
				headers: {
					[runSecretHeader]: 'secret',
					[gatewayFetchUrlHeaderName]: 'https://api.example.com/empty',
					[gatewayFetchMethodHeaderName]: 'POST',
				},
				body: '',
				duplex: 'half',
			} as RequestInit,
		)
		assert.equal(response.status, 204)
		assert.equal(await response.text(), '')
	} finally {
		await bridge.close()
	}
})

test('writeWebResponse pipes status, headers, and body', async () => {
	const server = createServer(async (_request, response) => {
		await writeWebResponse(
			response,
			new Response('piped', {
				status: 203,
				headers: { 'x-test': 'yes', 'content-type': 'text/plain' },
			}),
		)
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	try {
		const response = await fetch(`http://127.0.0.1:${port}/`)
		assert.equal(response.status, 203)
		assert.equal(response.headers.get('x-test'), 'yes')
		assert.equal(await response.text(), 'piped')
	} finally {
		server.close()
	}
})

test('callCapabilityProxyGatewayFetchStream sends through a caller fetchFn with the buffered body', async () => {
	const seen: Array<{ url: string; headers: Headers; body: string }> = []
	const fetchFn: typeof fetch = async (resource, init) => {
		const request = new Request(resource, init)
		seen.push({
			url: request.url,
			headers: request.headers,
			body: await request.text(),
		})
		return new Response('signed-ok', { status: 202 })
	}
	const response = await callCapabilityProxyGatewayFetchStream({
		apiUrl: 'https://api.kody.test',
		token: 'execution-context-run',
		fetchFn,
		gateway: {
			url: 'https://discord.com/api/v10/channels/1/messages/2',
			method: 'PATCH',
			headers: { authorization: 'Bot {{secret:demo}}' },
			contentType: 'application/json',
		},
		body: Readable.from([Buffer.from('{"content":'), Buffer.from('"hi"}')]),
	})
	assert.equal(response.status, 202)
	assert.equal(await response.text(), 'signed-ok')
	assert.equal(seen.length, 1)
	const [request] = seen
	assert.equal(
		request?.url,
		'https://api.kody.test/v1/capability-proxy/gateway-fetch',
	)
	assert.equal(request?.body, '{"content":"hi"}')
	assert.equal(
		request?.headers.get(gatewayFetchUrlHeaderName),
		'https://discord.com/api/v10/channels/1/messages/2',
	)
	assert.equal(request?.headers.get(gatewayFetchMethodHeaderName), 'PATCH')
	assert.equal(request?.headers.get('content-type'), 'application/json')
})

test('execution context runs sign gateway-fetch instead of sending the placeholder bearer', async () => {
	const { runScopedFetch } = await import('../src/execution-context/daemon.js')
	const { generateContextKey, importContextKey } =
		await import('../src/execution-context/client.js')
	const { privateKeyJwk } = await generateContextKey()
	const privateKey = await importContextKey(privateKeyJwk)
	const seen: Array<Headers> = []
	const fetchFn = runScopedFetch({
		apiUrl: 'https://api.kody.test',
		ecid: 'ec_test',
		runId: 'run_test',
		privateKey,
		fetchFn: async (resource, init) => {
			seen.push(new Request(resource, init).headers)
			return new Response(null, { status: 204 })
		},
	})
	const response = await callCapabilityProxyGatewayFetchStream({
		apiUrl: 'https://api.kody.test',
		token: 'execution-context-run',
		fetchFn,
		gateway: { url: 'https://discord.com/api/v10/users/@me', method: 'GET' },
		body: null,
	})
	assert.equal(response.status, 204)
	assert.equal(seen.length, 1)
	assert.equal(seen[0]?.get('authorization'), null)
	assert.ok(seen[0]?.get('kody-ecp-signature'))
	assert.equal(seen[0]?.get('kody-ecp-run'), 'run_test')
})
