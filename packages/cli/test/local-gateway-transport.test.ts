import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { gatewayFetchErrorHeaderName } from '../src/capability-proxy.js'
import {
	localBridgeGatewayFetchPath,
	startLocalRuntimeBridge,
} from '../src/local-runtime-bridge.js'
import {
	localGatewayFetchStreamRuntimeSource,
	runSecretHeader,
} from '../src/local-runtime-source.js'

type GatewayFetchStream = (input: unknown) => Promise<Response>

/** Loads the workerd-side gatewayFetchStream with a fake bridge. */
function loadRuntime(gatewayFetch: (init: RequestInit) => Promise<Response>) {
	const source = localGatewayFetchStreamRuntimeSource({
		callUnavailableMessage: 'no bridge',
	}).replaceAll(/^export /gm, '')
	const runtime = new Function(
		`${source}; return { __kodyInstallLocalBridge, gatewayFetchStream };`,
	)() as {
		__kodyInstallLocalBridge: (bridge: unknown) => void
		gatewayFetchStream: GatewayFetchStream
	}
	const seen: Array<RequestInit> = []
	runtime.__kodyInstallLocalBridge({
		call: async () => null,
		gatewayFetch: async (init: RequestInit) => {
			seen.push(init)
			return await gatewayFetch(init)
		},
	})
	return { gatewayFetchStream: runtime.gatewayFetchStream, seen }
}

const capabilityUrl =
	'https://upload.example.test/session?upload_id=synthetic-capability'

function call(overrides: Record<string, unknown> = {}) {
	return {
		request: {
			url: capabilityUrl,
			method: 'PUT',
			headers: { 'content-range': 'bytes 0-9/10' },
			body: new Uint8Array(10),
			...overrides,
		},
	}
}

async function rejection(promise: Promise<unknown>) {
	try {
		await promise
	} catch (error) {
		return error as Error & Record<string, unknown>
	}
	assert.fail('expected a rejection')
}

test('upstream statuses come back as Responses, including a manual 308 with Location', async () => {
	const responses = [
		new Response('resume', {
			status: 308,
			headers: {
				range: 'bytes=0-9',
				location: 'https://upload.example.test/elsewhere',
			},
		}),
		new Response(null, { status: 308, headers: { range: 'bytes=0-4' } }),
		new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }),
		new Response('boom', { status: 503 }),
		new Response('expired', { status: 401 }),
		// An upstream JSON error that is not Kody's (large, unmarked) stays a Response.
		Response.json(
			{ error: { code: 'upstream', message: 'x'.repeat(70_000) } },
			{ status: 400, headers: { 'cache-control': 'no-store' } },
		),
	]
	const { gatewayFetchStream, seen } = loadRuntime(async () =>
		responses.shift()!,
	)
	const first = await gatewayFetchStream(call({ redirect: 'manual' }))
	assert.equal(first.status, 308)
	assert.equal(first.headers.get('range'), 'bytes=0-9')
	assert.equal(
		first.headers.get('location'),
		'https://upload.example.test/elsewhere',
	)
	assert.equal(first.bodyUsed, false)
	await first.body?.cancel()
	assert.equal(seen[0]?.redirect, 'manual')
	// Even a caller asking to follow gets the held redirect back as is.
	const second = await gatewayFetchStream(call({ redirect: 'follow' }))
	assert.equal(seen[1]?.redirect, 'manual')
	assert.equal(second.status, 308)
	assert.equal(second.headers.get('range'), 'bytes=0-4')
	for (const status of [429, 503, 401, 400]) {
		const response = await gatewayFetchStream(call())
		assert.equal(response.status, status)
		await response.body?.cancel()
	}
})

test('Kody gateway errors throw KodyGatewayError with code and mayHaveReachedOrigin', async () => {
	const marked = (status: number, code: string, reached?: boolean) =>
		Response.json(
			{
				error: {
					code,
					message: 'rejected',
					...(reached === undefined ? {} : { mayHaveReachedOrigin: reached }),
				},
			},
			{
				status,
				headers: {
					'cache-control': 'no-store',
					[gatewayFetchErrorHeaderName]: code,
				},
			},
		)
	const cases = [
		{
			response: marked(403, 'host_not_allowed'),
			code: 'host_not_allowed',
			reached: false,
			status: 403,
		},
		{
			response: marked(502, 'gateway_fetch_failed', true),
			code: 'gateway_fetch_failed',
			reached: true,
			status: 502,
		},
		{
			response: marked(502, 'gateway_fetch_failed', false),
			code: 'gateway_fetch_failed',
			reached: false,
			status: 502,
		},
		{
			response: marked(500, 'internal_error'),
			code: 'internal_error',
			reached: true,
			status: 500,
		},
		{
			response: new Response('too big', { status: 413 }),
			code: 'payload_too_large',
			reached: false,
			status: 413,
		},
		// Older origins: a small unmarked no-store envelope still throws.
		{
			response: Response.json(
				{ error: { code: 'invalid_request', message: 'bad' } },
				{
					status: 400,
					headers: { 'cache-control': 'no-store', 'content-length': '58' },
				},
			),
			code: 'invalid_request',
			reached: false,
			status: 400,
		},
	]
	for (const entry of cases) {
		const { gatewayFetchStream } = loadRuntime(async () => entry.response)
		const error = await rejection(gatewayFetchStream(call()))
		assert.equal(error.name, 'KodyGatewayError', entry.code)
		assert.equal(error.code, entry.code)
		assert.equal(error.mayHaveReachedOrigin, entry.reached, entry.code)
		assert.equal(error.status, entry.status)
		assert.doesNotMatch(String(error.message), /synthetic-capability|upload_id/)
	}
})

test('aborts and bridge failures are typed and never echo the capability URL', async () => {
	const pre = new AbortController()
	pre.abort()
	const idle = loadRuntime(async () => new Response('never'))
	const preAborted = await rejection(
		idle.gatewayFetchStream(call({ signal: pre.signal })),
	)
	assert.equal(preAborted.name, 'AbortError')
	assert.equal(preAborted.mayHaveReachedOrigin, false)
	assert.equal(idle.seen.length, 0)

	const mid = new AbortController()
	const aborting = loadRuntime(async (init) => {
		mid.abort()
		throw init.signal?.reason ?? new DOMException('aborted', 'AbortError')
	})
	const midAbort = await rejection(
		aborting.gatewayFetchStream(call({ signal: mid.signal })),
	)
	assert.equal(midAbort.name, 'AbortError')
	assert.equal(midAbort.mayHaveReachedOrigin, true)

	const broken = loadRuntime(async () => {
		throw new TypeError(`fetch failed for ${capabilityUrl}`)
	})
	const failed = await rejection(broken.gatewayFetchStream(call()))
	assert.equal(failed.name, 'KodyGatewayError')
	assert.equal(failed.code, 'gateway_failed')
	assert.equal(failed.mayHaveReachedOrigin, true)
	assert.doesNotMatch(String(failed.message), /synthetic-capability|upload_id/)
})

async function withBridge(
	forward: Parameters<
		typeof startLocalRuntimeBridge
	>[0]['forwardGatewayFetchStream'],
	run: (url: string) => Promise<void>,
) {
	const bridge = await startLocalRuntimeBridge({
		runSecret: 'secret',
		forwardCall: async () => null,
		forwardGatewayFetchStream: forward,
	})
	try {
		await run(`http://127.0.0.1:${bridge.port}${localBridgeGatewayFetchPath}`)
	} finally {
		await bridge.close()
	}
}

function countingStream(
	total: number,
	chunk: number,
	onPull: (sent: number) => void,
	pause = 0,
) {
	let sent = 0
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (pause) await delay(pause)
			if (sent >= total) return controller.close()
			const size = Math.min(chunk, total - sent)
			controller.enqueue(new Uint8Array(size).fill(sent & 0xff))
			sent += size
			onPull(sent)
		},
	})
}

test('the bridge applies backpressure to a fast producer when the hop reads slowly', async () => {
	const total = 64 * 1024 * 1024
	let produced = 0
	let consumed = 0
	let maxAhead = 0
	await withBridge(
		async ({ request, response }) => {
			for await (const chunk of request) {
				consumed += (chunk as Buffer).length
				maxAhead = Math.max(maxAhead, produced - consumed)
				await delay(1)
			}
			response.writeHead(200)
			response.end(String(consumed))
		},
		async (url) => {
			const response = await fetch(url, {
				method: 'POST',
				headers: { [runSecretHeader]: 'secret' },
				body: countingStream(total, 64 * 1024, (sent) => {
					produced = sent
				}),
				duplex: 'half',
			} as RequestInit)
			assert.equal(await response.text(), String(total))
		},
	)
	assert.equal(consumed, total)
	// Bounded by socket and stream buffers, not by the 64 MiB body.
	assert.ok(maxAhead < 16 * 1024 * 1024, `producer ran ${maxAhead} bytes ahead`)
})

test('a slow producer still delivers every byte and a slow consumer reads the streamed response', async () => {
	const total = 2 * 1024 * 1024
	await withBridge(
		async ({ request, response }) => {
			let count = 0
			for await (const chunk of request) count += (chunk as Buffer).length
			response.writeHead(200, { 'content-type': 'application/octet-stream' })
			// Stream the response back in pieces; the caller reads slowly.
			for (let index = 0; index < 32; index += 1) {
				if (!response.write(Buffer.alloc(64 * 1024, index))) {
					await new Promise((resolve) => response.once('drain', resolve))
				}
			}
			response.end(Buffer.from(`:${count}`))
		},
		async (url) => {
			const response = await fetch(url, {
				method: 'POST',
				headers: { [runSecretHeader]: 'secret' },
				body: countingStream(total, 16 * 1024, () => {}, 1),
				duplex: 'half',
			} as RequestInit)
			let received = 0
			let tail = ''
			const reader = response.body!.getReader()
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				received += value.byteLength
				tail = (tail + Buffer.from(value).toString('latin1')).slice(-16)
				await delay(1)
			}
			assert.equal(received, 32 * 64 * 1024 + `:${total}`.length)
			assert.ok(tail.endsWith(`:${total}`))
		},
	)
})

test('a caller abort or mid-body disconnect aborts the upstream hop and leaks no stream', async () => {
	let hopSignal: AbortSignal | null = null
	let forwardSettled = false
	await withBridge(
		async ({ request, signal }) => {
			hopSignal = signal
			try {
				for await (const _chunk of request) {
					// Read until the client goes away.
				}
			} catch {
				// The disconnect surfaces as a stream error.
			} finally {
				forwardSettled = true
			}
		},
		async (url) => {
			const controller = new AbortController()
			let sent = 0
			const pending = fetch(url, {
				method: 'POST',
				headers: { [runSecretHeader]: 'secret' },
				body: countingStream(256 * 1024 * 1024, 64 * 1024, (total) => {
					sent = total
					if (total >= 4 * 1024 * 1024) controller.abort()
				}),
				duplex: 'half',
				signal: controller.signal,
			} as RequestInit)
			await assert.rejects(pending, { name: 'AbortError' })
			assert.ok(sent < 256 * 1024 * 1024)
			for (let attempt = 0; attempt < 100 && !forwardSettled; attempt += 1) {
				await delay(20)
			}
		},
	)
	assert.equal(forwardSettled, true)
	assert.equal((hopSignal as AbortSignal | null)?.aborted, true)
})

test('bridge failures are marked and say whether bytes may have reached the origin', async () => {
	const { CapabilityProxyError } = await import('../src/capability-proxy.js')
	for (const [sent, reached] of [
		[false, false],
		['unknown', true],
	] as const) {
		await withBridge(
			async () => {
				throw new CapabilityProxyError(`could not reach ${capabilityUrl}`, {
					sent,
				})
			},
			async (url) => {
				const response = await fetch(url, {
					method: 'POST',
					headers: { [runSecretHeader]: 'secret' },
					body: 'x',
				})
				assert.equal(response.status, 502)
				assert.equal(
					response.headers.get(gatewayFetchErrorHeaderName),
					'gateway_fetch_failed',
				)
				const body = (await response.json()) as {
					error: { mayHaveReachedOrigin: boolean; message: string }
				}
				assert.equal(body.error.mayHaveReachedOrigin, reached)
			},
		)
	}
})
