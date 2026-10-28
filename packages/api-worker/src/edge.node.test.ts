import { expect, test } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	handleApiEdgeRequest,
	maxApiRequestBodyBytes,
	maxGatewayFetchUploadBytes,
	type ApiWorkerEnv,
} from './edge.ts'

const token = `kody_at_${'a'.repeat(20)}_${'B'.repeat(43)}`

function createEnv(
	input: { ipAllowed?: boolean; tokenAllowed?: boolean } = {},
) {
	const forwarded: Array<Request> = []
	const limited: Array<string> = []
	const limiter = (allowed: boolean) => ({
		async limit({ key }: { key: string }) {
			limited.push(key)
			return { success: allowed }
		},
	})
	const env: ApiWorkerEnv = {
		KODY_API: {
			async fetch(request: Request) {
				forwarded.push(request)
				return Response.json(
					{ ok: true },
					{ headers: { 'Set-Cookie': 'leak=1', 'Cache-Control': 'no-store' } },
				)
			},
		} as unknown as Fetcher,
		API_IP_RATE_LIMITER: limiter(input.ipAllowed ?? true),
		API_TOKEN_RATE_LIMITER: limiter(input.tokenAllowed ?? true),
		APP_COMMIT_SHA: 'abc123',
	}
	return { env, forwarded, limited }
}

test('health answers at the edge with the deployed commit', async () => {
	const { env, forwarded } = createEnv()
	const response = await handleApiEdgeRequest(
		new Request('https://api.kody.test/health'),
		env,
	)
	expect(await response.json()).toEqual({ ok: true, commit: 'abc123' })
	expect(forwarded).toHaveLength(0)
})

test('forwards API routes with only safe headers and CORS on the response', async () => {
	const { env, forwarded, limited } = createEnv()
	const response = await handleApiEdgeRequest(
		new Request('https://api.kody.test/v1/capability-proxy/call', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
				Cookie: 'kody_session=abc',
				'X-Kody-Internal': 'spoofed',
				'CF-Connecting-IP': '203.0.113.9',
				'If-None-Match': '"abc"',
			},
			body: JSON.stringify({ path: ['kody', 'x'], args: [] }),
		}),
		env,
	)
	expect(response.status).toBe(200)
	expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
	expect(response.headers.get('Set-Cookie')).toBeNull()
	const [request] = forwarded
	expect(request?.url).toBe('https://api.kody.test/v1/capability-proxy/call')
	expect(request?.headers.get('Authorization')).toBe(`Bearer ${token}`)
	expect(request?.headers.get('Cookie')).toBeNull()
	expect(request?.headers.get('X-Kody-Internal')).toBeNull()
	expect(request?.headers.get('If-None-Match')).toBe('"abc"')
	expect(response.headers.get('Access-Control-Expose-Headers')).toContain(
		'ETag',
	)
	expect(await request?.json()).toEqual({ path: ['kody', 'x'], args: [] })
	expect(limited).toEqual(['ip:203.0.113.9', `token:${'a'.repeat(20)}`])
	expect(limited.join()).not.toContain('B'.repeat(43))
})

test('forwards signed execution context requests with their ECP headers', async () => {
	const { env, forwarded } = createEnv()
	const signature = 'ec=ec_test, ts=1, n=nonce, s=sig'
	const response = await handleApiEdgeRequest(
		new Request('https://api.kody.test/v1/execution-contexts', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
				'Kody-ECP-Signature': signature,
				'Kody-ECP-Run': 'run_1',
			},
			body: JSON.stringify({ name: 'my-machine' }),
		}),
		env,
	)
	expect(response.status).toBe(200)
	const [request] = forwarded
	expect(request?.headers.get('Kody-ECP-Signature')).toBe(signature)
	expect(request?.headers.get('Kody-ECP-Run')).toBe('run_1')
})

test('opaque OAuth bearers get a hashed per-credential rate-limit key', async () => {
	const oauth = 'cli-oauth-access-token-not-kody-at'
	const { env, forwarded, limited } = createEnv()
	const response = await handleApiEdgeRequest(
		new Request('https://api.kody.test/v1/capability-proxy/session', {
			headers: {
				Authorization: `Bearer ${oauth}`,
				'CF-Connecting-IP': '203.0.113.9',
			},
		}),
		env,
	)
	expect(response.status).toBe(200)
	expect(forwarded).toHaveLength(1)
	expect(limited[0]).toBe('ip:203.0.113.9')
	expect(limited[1]).toMatch(/^bearer:[0-9a-f]{32}$/)
	expect(limited.join()).not.toContain(oauth)

	const tokenLimited = createEnv({ tokenAllowed: false })
	const blocked = await handleApiEdgeRequest(
		new Request('https://api.kody.test/v1/capability-proxy/session', {
			headers: { Authorization: `Bearer ${oauth}` },
		}),
		tokenLimited.env,
	)
	expect(blocked.status).toBe(429)
	expect(tokenLimited.forwarded).toHaveLength(0)
})

test('answers CORS preflight without forwarding', async () => {
	const { env, forwarded } = createEnv()
	const response = await handleApiEdgeRequest(
		new Request('https://api.kody.test/v1/me', { method: 'OPTIONS' }),
		env,
	)
	expect(response.status).toBe(204)
	expect(response.headers.get('Access-Control-Allow-Headers')).toContain(
		'Authorization',
	)
	expect(forwarded).toHaveLength(0)
})

test('rejects unknown paths, oversize bodies, and rate-limited callers', async () => {
	const { env, forwarded } = createEnv()
	const unknown = await handleApiEdgeRequest(
		new Request('https://api.kody.test/login'),
		env,
	)
	expect(unknown.status).toBe(404)
	expect(await unknown.json()).toMatchObject({ error: { code: 'not_found' } })

	const oversize = await handleApiEdgeRequest(
		new Request('https://api.kody.test/v1/memories', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: 'x'.repeat(maxApiRequestBodyBytes + 1),
		}),
		env,
	)
	expect(oversize.status).toBe(413)
	expect(forwarded).toHaveLength(0)

	const ipLimited = createEnv({ ipAllowed: false })
	const ipResponse = await handleApiEdgeRequest(
		new Request('https://api.kody.test/v1/me', {
			headers: { 'CF-Connecting-IP': '203.0.113.9' },
		}),
		ipLimited.env,
	)
	expect(ipResponse.status).toBe(429)
	expect(ipResponse.headers.get('Retry-After')).toBe('60')
	expect(ipResponse.headers.get('RateLimit-Policy')).toBe(
		'ip;q=600;w=60, token;q=300;w=60',
	)
	expect(await ipResponse.json()).toMatchObject({
		error: { code: 'rate_limited' },
	})

	const tokenLimited = createEnv({ tokenAllowed: false })
	const tokenResponse = await handleApiEdgeRequest(
		new Request('https://api.kody.test/v1/me', {
			headers: { Authorization: `Bearer ${token}` },
		}),
		tokenLimited.env,
	)
	expect(tokenResponse.status).toBe(429)
	expect(tokenLimited.forwarded).toHaveLength(0)
})

test('reports origin failures with the error envelope', async () => {
	consoleError.mockImplementation(() => {})
	const env: ApiWorkerEnv = {
		KODY_API: {
			async fetch() {
				throw new Error('binding down')
			},
		} as unknown as Fetcher,
	}
	const response = await handleApiEdgeRequest(
		new Request('https://api.kody.test/openapi.json'),
		env,
	)
	expect(response.status).toBe(503)
	const requestId = response.headers.get('X-Kody-Request-Id')
	expect(requestId).toBeTruthy()
	expect(response.headers.get('Retry-After')).toBe('5')
	expect(await response.json()).toMatchObject({
		error: {
			code: 'internal_error',
			message: expect.stringContaining(`request id ${requestId}`),
			details: { reason: 'origin_unreachable', request_id: requestId },
		},
	})
	expect(consoleError).toHaveBeenCalledWith(
		'api-worker-forward-failed',
		expect.any(Error),
		expect.objectContaining({ requestId, reason: 'origin_unreachable' }),
	)
})

test('names an origin memory or CPU limit and echoes the ray id as the request id', async () => {
	consoleError.mockImplementation(() => {})
	const env: ApiWorkerEnv = {
		KODY_API: {
			async fetch() {
				throw new Error('Worker exceeded memory limit.')
			},
		} as unknown as Fetcher,
	}
	const response = await handleApiEdgeRequest(
		new Request('https://api.kody.test/v1/packages/check', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
				'CF-Ray': '8f00aa11bb22cc33-SJC',
			},
			body: JSON.stringify({ files: { 'package.json': '{}' } }),
		}),
		env,
	)
	expect(response.status).toBe(503)
	expect(response.headers.get('X-Kody-Request-Id')).toBe('8f00aa11bb22cc33-SJC')
	expect(response.headers.get('Retry-After')).toBeNull()
	const body = (await response.json()) as {
		error: { code: string; message: string; details: unknown }
	}
	expect(body.error.code).toBe('internal_error')
	expect(body.error.details).toEqual({
		reason: 'origin_resource_limit',
		request_id: '8f00aa11bb22cc33-SJC',
	})
	expect(body.error.message).toMatch(/ran out of server memory or CPU time/)
	expect(body.error.message).not.toMatch(/temporarily unavailable/)
})

test('gateway-fetch streams the body past the JSON cap and forwards hop headers', async () => {
	const { env, forwarded } = createEnv()
	const body = 'x'.repeat(maxApiRequestBodyBytes + 1)
	const response = await handleApiEdgeRequest(
		new Request('https://api.kody.test/v1/capability-proxy/gateway-fetch', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'text/plain',
				'X-Kody-Gateway-Url': 'https://example.com/upload',
				'X-Kody-Gateway-Method': 'POST',
				'X-Kody-Gateway-Package-Id': 'pkg-1',
				'X-Kody-Gateway-Headers': JSON.stringify({
					authorization: 'Bearer {{secret:demo}}',
				}),
				'x-kody-secret-resolution': 'headers-only',
				Cookie: 'kody_session=abc',
				'X-Kody-Internal': 'spoofed',
			},
			body,
		}),
		env,
	)
	expect(response.status).toBe(200)
	const [request] = forwarded
	expect(request?.url).toBe(
		'https://api.kody.test/v1/capability-proxy/gateway-fetch',
	)
	expect(request?.headers.get('Authorization')).toBe(`Bearer ${token}`)
	expect(request?.headers.get('X-Kody-Gateway-Url')).toBe(
		'https://example.com/upload',
	)
	expect(request?.headers.get('X-Kody-Gateway-Method')).toBe('POST')
	expect(request?.headers.get('X-Kody-Gateway-Package-Id')).toBe('pkg-1')
	expect(request?.headers.get('X-Kody-Gateway-Headers')).toContain('demo')
	expect(request?.headers.get('x-kody-secret-resolution')).toBe('headers-only')
	expect(request?.headers.get('Cookie')).toBeNull()
	expect(request?.headers.get('X-Kody-Internal')).toBeNull()
	expect(await request?.text()).toBe(body)
})

test('gateway-fetch rejects a declared body over the Worker upload limit', async () => {
	const { env, forwarded } = createEnv()
	const oversize = await handleApiEdgeRequest(
		new Request('https://api.kody.test/v1/capability-proxy/gateway-fetch', {
			method: 'POST',
			headers: {
				'Content-Type': 'text/plain',
				'Content-Length': String(maxGatewayFetchUploadBytes + 1),
			},
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array([0x78]))
					controller.close()
				},
			}),
			duplex: 'half',
		} as RequestInit),
		env,
	)
	expect(oversize.status).toBe(413)
	expect(await oversize.json()).toMatchObject({
		error: {
			code: 'payload_too_large',
			message: expect.stringMatching(/100 MiB/),
		},
	})
	expect(forwarded).toHaveLength(0)
})

test('execution context connect forwards the WebSocket upgrade to origin', async () => {
	const { env, forwarded, limited } = createEnv()
	const response = await handleApiEdgeRequest(
		new Request(
			'https://api.kody.test/v1/execution-contexts/connect?ticket=ec_test.abc',
			{
				headers: {
					Upgrade: 'websocket',
					Connection: 'Upgrade',
					'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
					'Sec-WebSocket-Version': '13',
					'CF-Connecting-IP': '203.0.113.9',
					Cookie: 'leak=1',
				},
			},
		),
		env,
	)
	expect(response.status).toBe(200)
	expect(forwarded).toHaveLength(1)
	const [request] = forwarded
	expect(new URL(request!.url).searchParams.get('ticket')).toBe('ec_test.abc')
	expect(request!.headers.get('Upgrade')).toBe('websocket')
	expect(request!.headers.get('Sec-WebSocket-Key')).toBe(
		'dGhlIHNhbXBsZSBub25jZQ==',
	)
	expect(request!.headers.get('Cookie')).toBeNull()
	expect(limited).toEqual(['ecp-connect:ec_test:203.0.113.9'])
})

test('execution context connect is rate limited per context and IP', async () => {
	const { env, forwarded } = createEnv({ ipAllowed: false })
	const response = await handleApiEdgeRequest(
		new Request(
			'https://api.kody.test/v1/execution-contexts/connect?ticket=ec_test.abc',
			{ headers: { Upgrade: 'websocket' } },
		),
		env,
	)
	expect(response.status).toBe(429)
	expect(forwarded).toHaveLength(0)
})
