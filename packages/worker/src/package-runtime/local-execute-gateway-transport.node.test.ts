import { expect, test, vi } from 'vitest'
import { credentialClientHeaderName } from '#worker/credentials/credential-client-header.ts'
import {
	gatewayFetchJsonEnvelopeHeadroomBytes,
	maxApiRequestBodyBytes,
	maxGatewayFetchJsonHopBodyBytes,
} from '#worker/open-api/api-body-limits.ts'
import { createLocalExecuteRuntimeShimSource } from './local-execute-runtime-support.ts'
import { runtimeModulePath } from './module-graph-path-basics.ts'

type GatewayFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>

type Shim = {
	__kodyGatewayFetch: GatewayFetch
	__kodyBytesToBase64: (bytes: Uint8Array) => string
	__kodyBase64ToBytes: (value: string) => Uint8Array
	__kodyGatewayFetchJsonHopMaxBodyBytes: number
	credential: (key: string) => Promise<{ fetch: GatewayFetch }>
}

type JsonHop = {
	packageId?: string
	request: {
		url: string
		method: string
		headers: Record<string, string>
		bodyBase64?: string
	}
}

type StreamHop = {
	request: {
		url: string
		method: string
		headers: Record<string, string>
		body?: unknown
		signal?: AbortSignal
		redirect?: string
	}
}

const mib = 1024 * 1024
const threshold = maxGatewayFetchJsonHopBodyBytes
const handle = 'kch1.synthetic-handle'

/**
 * Loads the real local-execute shim (gateway fetch + credential client) with
 * a fake `kody` host and a native fetch spy, the way local workerd runs it.
 */
function loadShim(
	options: {
		stream?: boolean
		respond?: (hop: StreamHop) => Response | Promise<Response>
		kind?: string
		jsonError?: Error
	} = {},
) {
	const shim = createLocalExecuteRuntimeShimSource(runtimeModulePath)
	const start = shim.indexOf('function __kodyCreateCredentialRuntime(')
	const end = shim.indexOf('export function __kodyCreatePackageBoundStorage')
	expect(start).toBeGreaterThan(-1)
	expect(end).toBeGreaterThan(start)
	const source = shim.slice(start, end).replaceAll(/^export /gm, '')
	const jsonHops: Array<JsonHop> = []
	const streamHops: Array<StreamHop> = []
	const nativeCalls: Array<unknown> = []
	const kody: Record<string, unknown> = {
		credentialClientOpen: async () => ({
			ok: true,
			value: {
				handle,
				name: 'sink',
				scope: 'personal',
				kind: options.kind ?? 'secret',
				hosts: ['upload.example.test'],
			},
		}),
		credentialClientRefresh: async () => ({
			ok: true,
			value: { refreshed: true },
		}),
		gatewayFetch: async (args: JsonHop) => {
			jsonHops.push(args)
			if (options.jsonError) throw options.jsonError
			return { status: 200, statusText: 'OK', headers: {}, bodyBase64: '' }
		},
	}
	if (options.stream !== false) {
		kody.gatewayFetchStream = async (args: StreamHop) => {
			streamHops.push(args)
			return options.respond
				? await options.respond(args)
				: new Response('streamed', { status: 200 })
		}
	}
	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: unknown, init?: unknown) => {
		nativeCalls.push({ input, init })
		return new Response('native')
	}) as typeof fetch
	let loaded: Shim
	try {
		loaded = new Function(
			'kody',
			`${source}; return { __kodyGatewayFetch, __kodyBytesToBase64, __kodyBase64ToBytes, __kodyGatewayFetchJsonHopMaxBodyBytes, credential };`,
		)(kody) as Shim
	} finally {
		globalThis.fetch = originalFetch
	}
	// The shim captured the spy as its native fetch; route the credential
	// client's global fetch through the shim the way local execute does.
	vi.stubGlobal('fetch', loaded.__kodyGatewayFetch)
	return { ...loaded, jsonHops, streamHops, nativeCalls }
}

async function bodyBytes(body: unknown) {
	return new Uint8Array(await new Response(body as BodyInit).arrayBuffer())
}

function patterned(size: number) {
	const bytes = new Uint8Array(size)
	for (let index = 0; index < size; index += 1)
		bytes[index] = (index * 31) & 0xff
	return bytes
}

test('the JSON-hop threshold is derived from the API body limit with envelope headroom', () => {
	expect(maxApiRequestBodyBytes).toBe(5 * mib)
	expect(gatewayFetchJsonEnvelopeHeadroomBytes).toBe(mib)
	expect(threshold).toBe(3 * mib)
	const shim = loadShim()
	expect(shim.__kodyGatewayFetchJsonHopMaxBodyBytes).toBe(threshold)
	const envelope = (size: number) =>
		new TextEncoder().encode(
			JSON.stringify({
				path: ['kody', 'gatewayFetch'],
				args: [
					{
						packageId: 'b'.repeat(512),
						request: {
							url: `https://upload.example.test/${'p'.repeat(2048)}?${'q'.repeat(4096)}`,
							method: 'PUT',
							headers: {
								'content-type': 'application/octet-stream',
								authorization: `Bearer ${'t'.repeat(8192)}`,
							},
							bodyBase64: 'A'.repeat(4 * Math.ceil(size / 3)),
						},
					},
				],
				credentials: { sink: 'n'.repeat(1024) },
			}),
		).byteLength
	// At the threshold the encoded envelope fits with room to spare.
	expect(envelope(threshold)).toBeLessThan(maxApiRequestBodyBytes - 900 * 1024)
	// A raw 4 MiB body does not fit once base64-encoded (the old cutoff).
	expect(4 * Math.ceil((4 * mib) / 3)).toBeGreaterThan(maxApiRequestBodyBytes)
	expect(envelope(4 * mib)).toBeGreaterThan(maxApiRequestBodyBytes)
})

test('chunked base64 matches Buffer at window edges, with and without native helpers', () => {
	const shim = loadShim()
	const sizes = [0, 1, 2, 3, 24575, 24576, 24577, 3 * 24576 + 1, 256 * 1024 + 2]
	const proto = Uint8Array.prototype as { toBase64?: unknown }
	const ctor = Uint8Array as { fromBase64?: unknown }
	const nativeTo = proto.toBase64
	const nativeFrom = ctor.fromBase64
	for (const useNative of [true, false]) {
		if (!useNative) {
			proto.toBase64 = undefined
			ctor.fromBase64 = undefined
		}
		try {
			for (const size of sizes) {
				const bytes = patterned(size)
				const expected = Buffer.from(bytes).toString('base64')
				expect(shim.__kodyBytesToBase64(bytes)).toBe(expected)
				expect(
					Buffer.from(shim.__kodyBase64ToBytes(expected)).equals(
						Buffer.from(bytes),
					),
				).toBe(true)
			}
		} finally {
			proto.toBase64 = nativeTo
			ctor.fromBase64 = nativeFrom
		}
	}
})

test('placeholder bodies take the JSON hop up to the threshold and stream above it', async () => {
	const cases = [
		{ size: 3 * mib, hop: 'json' },
		{ size: threshold - 1, hop: 'json' },
		{ size: threshold, hop: 'json' },
		{ size: threshold + 1, hop: 'stream' },
		{ size: 4 * mib, hop: 'stream' },
	] as const
	for (const { size, hop } of cases) {
		const shim = loadShim()
		const body = patterned(size)
		await shim.__kodyGatewayFetch('https://api.example.com/upload', {
			method: 'PUT',
			headers: { authorization: 'Bearer {{secret:demoToken}}' },
			body,
		})
		expect(shim.nativeCalls).toHaveLength(0)
		if (hop === 'json') {
			expect(shim.streamHops).toHaveLength(0)
			expect(shim.jsonHops).toHaveLength(1)
			const encoded = shim.jsonHops[0]!.request.bodyBase64 ?? ''
			expect(encoded.length).toBe(4 * Math.ceil(size / 3))
		} else {
			expect(shim.jsonHops).toHaveLength(0)
			expect(shim.streamHops).toHaveLength(1)
			expect(
				(await bodyBytes(shim.streamHops[0]!.request.body)).byteLength,
			).toBe(size)
		}
	}
})

test("credential headers-only binary bodies always stream as the caller's own value", async () => {
	const bytes = patterned(3 * mib)
	const bodies: Array<{ name: string; body: () => unknown }> = [
		{ name: 'Uint8Array', body: () => bytes },
		{ name: 'ArrayBuffer', body: () => bytes.buffer },
		{ name: 'DataView', body: () => new DataView(bytes.buffer) },
		{ name: 'Blob', body: () => new Blob([bytes], { type: 'video/mp4' }) },
		{ name: 'small Uint8Array', body: () => bytes.subarray(0, 16) },
	]
	for (const entry of bodies) {
		const shim = loadShim()
		const client = await shim.credential('sink')
		const body = entry.body()
		const response = await client.fetch(
			'https://upload.example.test/session?upload_id=cap',
			{
				method: 'PUT',
				headers: {
					'content-range': 'bytes 0-1/2',
					'x-kody-secret-resolution': 'headers-only',
				},
				body: body as BodyInit,
			},
		)
		expect(response.status).toBe(200)
		expect(shim.jsonHops).toHaveLength(0)
		expect(shim.nativeCalls).toHaveLength(0)
		expect(shim.streamHops).toHaveLength(1)
		const hop = shim.streamHops[0]!.request
		// The same object: nothing was cloned, buffered, or base64-encoded.
		expect(hop.body).toBe(body)
		expect(hop.headers[credentialClientHeaderName]).toBe(handle)
		expect(hop.headers['x-kody-secret-resolution']).toBe('headers-only')
		expect(hop.headers['content-range']).toBe('bytes 0-1/2')
		expect(hop.redirect).toBe('manual')
		if (body instanceof Blob) {
			expect(hop.headers['content-type']).toBe('video/mp4')
		}
	}
})

test('a credential stream body never takes native fetch (no handle to the target host)', async () => {
	for (const resolution of ['headers-only', 'off', null]) {
		const shim = loadShim()
		const client = await shim.credential('sink')
		const body = new Blob([patterned(1024)]).stream()
		await client.fetch('https://upload.example.test/u', {
			method: 'PUT',
			headers: resolution ? { 'x-kody-secret-resolution': resolution } : {},
			body,
			duplex: 'half',
		} as RequestInit)
		expect(shim.nativeCalls).toHaveLength(0)
		expect(shim.streamHops).toHaveLength(1)
		const hop = shim.streamHops[0]!.request
		expect(hop.headers[credentialClientHeaderName]).toBe(handle)
		expect((await bodyBytes(hop.body)).byteLength).toBe(1024)
	}
	// Plain fetches without a handle or placeholder still go native.
	const shim = loadShim()
	await shim.__kodyGatewayFetch('https://public.example.test/u', {
		method: 'PUT',
		headers: { 'x-kody-secret-resolution': 'headers-only' },
		body: new Blob(['x']).stream(),
		duplex: 'half',
	} as RequestInit)
	expect(shim.nativeCalls).toHaveLength(1)
	expect(shim.streamHops).toHaveLength(0)
})

test('a Request input with a credential handle streams its own body without a clone', async () => {
	const shim = loadShim()
	const client = await shim.credential('sink')
	await client.fetch(
		new Request('https://upload.example.test/u', {
			method: 'PUT',
			headers: { 'x-kody-secret-resolution': 'headers-only' },
			body: patterned(3 * mib),
		}),
	)
	expect(shim.jsonHops).toHaveLength(0)
	expect(shim.nativeCalls).toHaveLength(0)
	expect(shim.streamHops).toHaveLength(1)
	expect((await bodyBytes(shim.streamHops[0]!.request.body)).byteLength).toBe(
		3 * mib,
	)
})

test('a tracked Blob body stays attached on a credential hop (was sent empty)', async () => {
	const shim = loadShim()
	const blob = new Blob([patterned(4096)])
	const request = new Request('https://upload.example.test/u', {
		method: 'PUT',
		headers: {
			'x-kody-secret-resolution': 'headers-only',
			[credentialClientHeaderName]: handle,
		},
		body: blob,
	})
	await shim.__kodyGatewayFetch(request)
	expect(shim.jsonHops).toHaveLength(0)
	expect(shim.streamHops).toHaveLength(1)
	expect(shim.streamHops[0]!.request.body).toBe(blob)
})

test('without gatewayFetchStream, credential bytes use the JSON hop up to the threshold, then fail typed', async () => {
	const shim = loadShim({ stream: false })
	const client = await shim.credential('sink')
	await client.fetch('https://upload.example.test/u', {
		method: 'PUT',
		headers: { 'x-kody-secret-resolution': 'headers-only' },
		body: patterned(threshold),
	})
	expect(shim.jsonHops).toHaveLength(1)
	expect(shim.nativeCalls).toHaveLength(0)
	const error = await client
		.fetch('https://upload.example.test/u', {
			method: 'PUT',
			headers: { 'x-kody-secret-resolution': 'headers-only' },
			body: patterned(threshold + 1),
		})
		.catch((caught: unknown) => caught)
	expect(error).toMatchObject({
		name: 'KodyGatewayError',
		code: 'stream_host_missing',
		mayHaveReachedOrigin: false,
	})
	expect(shim.nativeCalls).toHaveLength(0)
})

test('manual 308 comes back unchanged, with or without Location, body left to the caller', async () => {
	for (const location of [null, 'https://upload.example.test/elsewhere']) {
		const shim = loadShim({
			respond: () =>
				new Response('resume incomplete', {
					status: 308,
					headers: {
						range: 'bytes=0-262143',
						'x-guploader-uploadid': 'synthetic',
						...(location ? { location } : {}),
					},
				}),
		})
		const client = await shim.credential('sink')
		const response = await client.fetch('https://upload.example.test/u', {
			method: 'PUT',
			redirect: 'manual',
			headers: {
				'content-range': 'bytes 0-262143/1000000',
				'x-kody-secret-resolution': 'headers-only',
			},
			body: patterned(256 * 1024),
		})
		expect(response.status).toBe(308)
		expect(response.headers.get('range')).toBe('bytes=0-262143')
		expect(response.headers.get('x-guploader-uploadid')).toBe('synthetic')
		expect(response.headers.get('location')).toBe(location)
		expect(shim.streamHops).toHaveLength(1)
		expect(shim.nativeCalls).toHaveLength(0)
		expect(response.bodyUsed).toBe(false)
		await response.body?.cancel()
	}
})

test('without redirect manual, a 308 without Location (Resume Incomplete) still returns as is', async () => {
	const shim = loadShim({
		respond: () =>
			new Response(null, { status: 308, headers: { range: 'bytes=0-9' } }),
	})
	const client = await shim.credential('sink')
	const response = await client.fetch('https://upload.example.test/u', {
		method: 'PUT',
		headers: { 'x-kody-secret-resolution': 'headers-only' },
		body: patterned(10),
	})
	expect(response.status).toBe(308)
	expect(response.headers.get('range')).toBe('bytes=0-9')
	expect(shim.streamHops).toHaveLength(1)
})

test('OAuth 401 on the stream path replays in-memory bodies and returns 401 for streams', async () => {
	let sends = 0
	const shim = loadShim({
		kind: 'oauth',
		respond: async (hop) => {
			sends += 1
			await bodyBytes(hop.request.body)
			return new Response(sends % 2 === 1 ? 'expired' : 'ok', {
				status: sends % 2 === 1 ? 401 : 200,
			})
		},
	})
	const client = await shim.credential('sink')
	const bytes = patterned(threshold + 1)
	const replayed = await client.fetch('https://upload.example.test/u', {
		method: 'PUT',
		headers: { 'x-kody-secret-resolution': 'headers-only' },
		body: bytes,
	})
	expect(replayed.status).toBe(200)
	expect(shim.streamHops).toHaveLength(2)
	expect(shim.streamHops[0]!.request.body).toBe(bytes)
	expect(shim.streamHops[1]!.request.body).toBe(bytes)
	sends = 0
	shim.streamHops.length = 0
	const streamed = await client.fetch('https://upload.example.test/u', {
		method: 'PUT',
		headers: { 'x-kody-secret-resolution': 'headers-only' },
		body: new Blob([bytes]).stream(),
		duplex: 'half',
	} as RequestInit)
	expect(streamed.status).toBe(401)
	expect(shim.streamHops).toHaveLength(1)
	await streamed.body?.cancel()
})

test('an AbortSignal reaches the stream hop', async () => {
	const shim = loadShim()
	const client = await shim.credential('sink')
	const controller = new AbortController()
	await client.fetch('https://upload.example.test/u', {
		method: 'PUT',
		signal: controller.signal,
		headers: { 'x-kody-secret-resolution': 'headers-only' },
		body: patterned(10),
	})
	expect(shim.streamHops[0]!.request.signal).toBe(controller.signal)
})

test('a failed JSON hop throws KodyGatewayError that may have reached the origin', async () => {
	const shim = loadShim({
		jsonError: new Error('[gateway_fetch_failed] upstream reset'),
	})
	const client = await shim.credential('sink')
	const error = await client
		.fetch('https://upload.example.test/u?upload_id=cap', {
			method: 'POST',
			headers: { 'x-kody-secret-resolution': 'headers-only' },
			body: JSON.stringify({ name: 'synthetic' }),
		})
		.catch((caught: unknown) => caught)
	expect(shim.jsonHops).toHaveLength(1)
	expect(error).toMatchObject({
		name: 'KodyGatewayError',
		code: 'gateway_fetch_failed',
		mayHaveReachedOrigin: true,
	})
	expect(String((error as Error).message)).not.toContain('upload_id')
})
