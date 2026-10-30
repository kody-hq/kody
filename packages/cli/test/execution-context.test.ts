import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	ecpPingFrame,
	ecpPongFrame,
	ecpRunHeader,
	decodeEnvelopePayload,
	ecpSignatureHeader,
	ed25519JwkThumbprint,
	importEd25519PublicKey,
	parseEcpSignatureHeader,
	parseEnvelope,
	signFrame,
	verifyEcpHttpSignature,
	type EcpFramePayload,
} from '@kody-internal/shared/execution-context-protocol/index.ts'
import {
	generateContextKey,
	importContextKey,
	registerContext,
} from '../src/execution-context/client.js'
import { runExecutionContextCommand } from '../src/execution-context/commands.js'
import {
	abortableDelay,
	frameRejectedCloseCode,
	heartbeatTimeoutCloseCode,
	runDaemon,
	runDaemonConnection,
	runRequestRefusal,
	runScopedFetch,
	welcomeTimeoutCloseCode,
} from '../src/execution-context/daemon.js'
import {
	decryptPrivateKey,
	encryptPrivateKey,
	resolveWrappingKey,
} from '../src/execution-context/keystore.js'

test('context key round trips through passphrase and keyring wrapping', async () => {
	const { privateKeyJwk } = await generateContextKey()
	const passphrase = resolveWrappingKey({
		ecid: 'ec_test',
		create: true,
		env: { KODY_CONTEXT_KEY_PASSPHRASE: 'correct horse battery staple' },
	})
	const file = encryptPrivateKey(privateKeyJwk, passphrase)
	assert.ok(!JSON.stringify(file).includes(privateKeyJwk.d))
	assert.deepEqual(decryptPrivateKey(file, passphrase), privateKeyJwk)
	const wrong = resolveWrappingKey({
		ecid: 'ec_test',
		create: true,
		env: { KODY_CONTEXT_KEY_PASSPHRASE: 'wrong' },
	})
	assert.throws(() => decryptPrivateKey(file, wrong), /Could not decrypt/)

	let stored: string | null = null
	const keyring = resolveWrappingKey({
		ecid: 'ec_test',
		create: true,
		env: {},
		keyringFactory: () => ({
			getPassword: () => stored,
			setPassword: (value) => {
				stored = value
			},
		}),
	})
	const keyringFile = encryptPrivateKey(privateKeyJwk, keyring)
	assert.deepEqual(decryptPrivateKey(keyringFile, keyring), privateKeyJwk)
})

test('registering with a pre-PR 2 login prints the exact kody login command', async () => {
	const { publicKeyJwk, privateKeyJwk } = await generateContextKey()
	const fetchFn = (async () =>
		Response.json(
			{
				error: {
					code: 'insufficient_scope',
					message:
						'Your Kody login predates execution context permissions, so it cannot register a machine.',
				},
			},
			{ status: 403 },
		)) as typeof fetch
	await assert.rejects(
		registerContext({
			apiUrl: 'https://api.kody.test',
			token: 'kody_at_test',
			name: 'my-machine',
			publicKeyJwk,
			privateKey: await importContextKey(privateKeyJwk),
			thumbprint: await ed25519JwkThumbprint(publicKeyJwk),
			capabilities: {},
			client: { name: 'kody-cli', version: '0.0.0' },
			fetchFn,
		}),
		(error: Error) => {
			assert.match(error.message, /predates execution context permissions/)
			assert.match(error.message, /Run `kody login` again/)
			assert.match(error.message, /kody context register/)
			return true
		},
	)
})

test('registering with a scoped credential keeps the server message', async () => {
	const { publicKeyJwk, privateKeyJwk } = await generateContextKey()
	const message =
		'This credential lacks org:execution_context:register. Mint one with --scope org:execution_context:register.'
	const fetchFn = (async () =>
		Response.json(
			{ error: { code: 'credential_scope', message } },
			{ status: 403 },
		)) as typeof fetch
	await assert.rejects(
		registerContext({
			apiUrl: 'https://api.kody.test',
			token: 'kody_at_test',
			name: 'my-machine',
			publicKeyJwk,
			privateKey: await importContextKey(privateKeyJwk),
			thumbprint: await ed25519JwkThumbprint(publicKeyJwk),
			capabilities: {},
			client: { name: 'kody-cli', version: '0.0.0' },
			fetchFn,
		}),
		(error: Error) => {
			assert.ok(error.message.startsWith(message))
			assert.match(error.message, /Run `kody login` again/)
			return true
		},
	)
})

/** Opens, answers nothing: the production failure where welcome never came. */
class SilentSocket extends EventTarget {
	static instances: Array<SilentSocket> = []
	readonly OPEN = 1
	readyState = 1
	closed: { code: number; reason: string } | null = null
	constructor(readonly url: string) {
		super()
		SilentSocket.instances.push(this)
	}
	send(_data?: string) {}
	close(code = 1000, reason = '') {
		if (this.closed) return
		this.closed = { code, reason }
		this.readyState = 3
		const event = Object.assign(new Event('close'), { code, reason })
		queueMicrotask(() => this.dispatchEvent(event))
	}
}

async function daemonInput(overrides: Record<string, unknown> = {}) {
	const { privateKeyJwk } = await generateContextKey()
	const lines: Array<string> = []
	return {
		lines,
		input: {
			apiUrl: 'https://api.kody.test',
			ecid: 'ec_test',
			privateKey: await importContextKey(privateKeyJwk),
			serverKeys: [],
			maxConcurrent: 1,
			client: { name: 'kody-cli', version: '0.0.0' },
			capabilities: {},
			execute: async () => ({ isError: false }),
			log: (line: string) => lines.push(line),
			fetchFn: (async () =>
				Response.json({
					ticket: 'ticket_1',
					expiresAt: '2099-01-01T00:00:00.000Z',
				})) as typeof fetch,
			WebSocketImpl: SilentSocket as unknown as typeof WebSocket,
			...overrides,
		},
	}
}

test('a connection with no welcome frame times out with a clear error', async () => {
	SilentSocket.instances = []
	const { input, lines } = await daemonInput({ welcomeTimeoutMs: 20 })
	const closed = await runDaemonConnection(input)
	assert.deepEqual(closed, {
		code: welcomeTimeoutCloseCode,
		reason: 'welcome timeout',
	})
	assert.match(lines.join('\n'), /did not send a welcome frame/)
	assert.match(SilentSocket.instances[0]!.url, /ticket=ticket_1/)
})

test('runDaemon retries after a welcome timeout and SIGTERM ends the backoff promptly', async () => {
	SilentSocket.instances = []
	const abort = new AbortController()
	let abortedAt = 0
	const { input, lines } = await daemonInput({
		welcomeTimeoutMs: 20,
		signal: abort.signal,
		log: (line: string) => {
			lines.push(line)
			if (
				line.startsWith('Disconnected') &&
				SilentSocket.instances.length === 2
			) {
				abortedAt = Date.now()
				abort.abort()
			}
		},
	})
	await runDaemon(input)
	// The second backoff is 2-4s; abort must cut it short.
	const exitMs = Date.now() - abortedAt
	assert.ok(exitMs < 500, `exited ${exitMs}ms after abort`)
	assert.equal(SilentSocket.instances.length, 2)
	assert.equal(
		lines.filter(
			(line) =>
				line ===
				`Disconnected (${welcomeTimeoutCloseCode} welcome timeout). Reconnecting.`,
		).length,
		2,
	)
})

/** Never emits `close`, like Node's WebSocket closed mid-handshake. */
class HungSocket extends SilentSocket {
	override close(code = 1000, reason = '') {
		this.closed = { code, reason }
	}
}

test('a welcome timeout settles even when the socket never emits close', async () => {
	SilentSocket.instances = []
	const { input } = await daemonInput({
		welcomeTimeoutMs: 20,
		closeSettleMs: 20,
		WebSocketImpl: HungSocket as unknown as typeof WebSocket,
	})
	const closed = await runDaemonConnection(input)
	assert.deepEqual(closed, {
		code: welcomeTimeoutCloseCode,
		reason: 'welcome timeout',
	})
	assert.deepEqual(SilentSocket.instances[0]!.closed, closed)
})

test('SIGTERM cancels a pending connect-ticket request', async () => {
	SilentSocket.instances = []
	const abort = new AbortController()
	const { input } = await daemonInput({
		signal: abort.signal,
		fetchFn: ((_url: URL | string, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () =>
					reject(init.signal?.reason),
				)
			})) as typeof fetch,
	})
	setTimeout(() => abort.abort(), 20)
	const startedAt = Date.now()
	await runDaemon(input)
	const exitMs = Date.now() - startedAt
	assert.ok(exitMs < 500, `exited ${exitMs}ms after start`)
	assert.equal(SilentSocket.instances.length, 0)
})

test('abortableDelay resolves on abort instead of waiting out the delay', async () => {
	const abort = new AbortController()
	const started = Date.now()
	const waiting = abortableDelay(60_000, abort.signal)
	setTimeout(() => abort.abort(), 10)
	await waiting
	assert.ok(Date.now() - started < 1_000)
	const preAborted = Date.now()
	await abortableDelay(60_000, AbortSignal.abort())
	assert.ok(Date.now() - preAborted < 100)
})

test('run-scoped fetch signs Kody API calls and never sends the bearer token', async () => {
	const { publicKeyJwk, privateKeyJwk } = await generateContextKey()
	const seen: Array<Request> = []
	const scoped = runScopedFetch({
		apiUrl: 'https://api.kody.test',
		ecid: 'ec_test',
		runId: 'run_1',
		privateKey: await importContextKey(privateKeyJwk),
		fetchFn: (async (
			resource: Parameters<typeof fetch>[0],
			init?: RequestInit,
		) => {
			seen.push(new Request(resource, init))
			return new Response('ok')
		}) as typeof fetch,
	})
	await scoped('https://api.kody.test/v1/capability-proxy/call?x=1', {
		method: 'POST',
		headers: {
			authorization: 'Bearer secret',
			'content-type': 'application/json',
		},
		body: '{"a":1}',
	})
	await scoped('https://example.test/data', {
		headers: { authorization: 'Bearer other' },
	})
	const [api, other] = seen
	assert.equal(api!.headers.get('authorization'), null)
	assert.equal(api!.headers.get(ecpRunHeader), 'run_1')
	const signature = parseEcpSignatureHeader(
		api!.headers.get(ecpSignatureHeader),
	)
	assert.ok(signature)
	assert.equal(
		await verifyEcpHttpSignature({
			signature: signature!,
			method: 'POST',
			pathAndQuery: '/v1/capability-proxy/call?x=1',
			body: '{"a":1}',
			publicKey: await importEd25519PublicKey(publicKeyJwk),
		}),
		'ok',
	)
	assert.equal(other!.headers.get('authorization'), 'Bearer other')
	assert.equal(other!.headers.get(ecpSignatureHeader), null)
})

test('kody chain show and add read the chain out of the API response', async () => {
	const chain = {
		entries: [{ kind: 'cloud' }],
		strict: false,
		updatedAt: '2026-01-01T00:00:00.000Z',
		updatedBy: null,
	}
	const puts: Array<unknown> = []
	const fetchFn = (async (url: URL | string, init?: RequestInit) => {
		const path = new URL(url).pathname
		if (path === '/v1/execution-contexts') {
			return Response.json({
				contexts: [
					{ id: 'ec_box', name: 'box', status: 'online', usable: true },
				],
			})
		}
		if (init?.method === 'PUT') {
			const body = JSON.parse(String(init.body)) as {
				entries: Array<{ kind: string; id?: string }>
			}
			puts.push(body)
			return Response.json({
				chain: { ...chain, entries: [...body.entries], strict: false },
			})
		}
		return Response.json({ chain })
	}) as typeof fetch
	const run = async (positionals: Array<string>) => {
		let text = ''
		await runExecutionContextCommand({
			command: 'chain',
			positionals,
			values: {},
			apiUrl: 'https://api.kody.test',
			token: async () => 'kody_at_test',
			clientVersion: '0.0.0',
			write: (chunk) => {
				text += chunk
			},
			fetchFn,
		})
		return text
	}
	assert.equal(await run(['show']), '1. Kody cloud (always last)\n')
	assert.equal(
		await run(['add', 'box']),
		'1. box (ec_box)\n2. Kody cloud (always last)\n',
	)
	assert.deepEqual(puts, [
		{
			entries: [{ kind: 'context', id: 'ec_box' }, { kind: 'cloud' }],
			strict: false,
			ifMatch: '2026-01-01T00:00:00.000Z',
		},
	])
})

test('kody chain show prints names and an offline marker, and add on an empty chain keeps cloud last', async () => {
	let chain: Record<string, unknown> = {
		entries: [],
		strict: true,
		updatedAt: null,
		updatedBy: null,
	}
	const puts: Array<unknown> = []
	const fetchFn = (async (url: URL | string, init?: RequestInit) => {
		const path = new URL(url).pathname
		if (path === '/v1/execution-contexts') {
			return Response.json({
				contexts: [
					{ id: 'ec_box', name: 'box', status: 'offline', usable: true },
					{ id: 'ec_ci', name: 'ci', status: 'online', usable: true },
				],
			})
		}
		if (init?.method === 'PUT') {
			const body = JSON.parse(String(init.body)) as {
				entries: Array<{ kind: string; id?: string }>
				strict: boolean
			}
			puts.push(body)
			chain = {
				...chain,
				entries: body.entries.map((entry) =>
					entry.kind === 'cloud'
						? entry
						: {
								...entry,
								name: entry.id === 'ec_box' ? 'box' : 'ci',
								usable: true,
							},
				),
				strict: body.strict,
			}
			return Response.json({ chain })
		}
		return Response.json({ chain })
	}) as typeof fetch
	const run = async (positionals: Array<string>) => {
		let text = ''
		await runExecutionContextCommand({
			command: 'chain',
			positionals,
			values: {},
			apiUrl: 'https://api.kody.test',
			token: async () => 'kody_at_test',
			clientVersion: '0.0.0',
			write: (chunk) => {
				text += chunk
			},
			fetchFn,
		})
		return text
	}
	assert.equal(
		await run(['add', 'ec_box']),
		'1. box (ec_box) [offline]\n2. Kody cloud (always last)\n',
	)
	assert.deepEqual(puts[0], {
		entries: [{ kind: 'context', id: 'ec_box' }, { kind: 'cloud' }],
		strict: false,
		ifMatch: null,
	})
	await run(['add', 'ec_ci'])
	assert.equal(
		await run(['show']),
		'1. box (ec_box) [offline]\n2. ci (ec_ci)\n3. Kody cloud (always last)\n',
	)
})

test('the daemon accepts runs naming its API origin and refuses any other origin', () => {
	const apiUrl = 'https://api.kody.codes'
	const acceptBy = 2_000
	assert.equal(runRequestRefusal({ apiUrl, acceptBy }, apiUrl, 1_000), null)
	assert.equal(
		runRequestRefusal({ apiUrl: `${apiUrl}/`, acceptBy }, apiUrl, 1_000),
		null,
	)
	assert.equal(
		runRequestRefusal(
			{ apiUrl: 'https://kody.codes', acceptBy },
			apiUrl,
			1_000,
		),
		'grant_mismatch',
	)
	assert.equal(
		runRequestRefusal({ apiUrl: 'not a url', acceptBy }, apiUrl, 1_000),
		'grant_mismatch',
	)
	assert.equal(
		runRequestRefusal({ apiUrl, acceptBy }, apiUrl, 3_000),
		'deadline_passed',
	)
})

/**
 * A Kody-side socket that opens with a signed welcome. Like Node's
 * WebSocket, close() only accepts 1000 or 3000-4999.
 */
class ServerSocket extends SilentSocket {
	static frames: Array<string> = []
	static answerPings = false
	sent: Array<string> = []
	constructor(url: string) {
		super(url)
		const frames = ServerSocket.frames
		setTimeout(() => {
			for (const data of frames) {
				this.dispatchEvent(Object.assign(new Event('message'), { data }))
			}
		}, 0)
	}
	override send(data = '') {
		this.sent.push(data)
		if (data === ecpPingFrame && ServerSocket.answerPings) {
			queueMicrotask(() =>
				this.dispatchEvent(
					Object.assign(new Event('message'), { data: ecpPongFrame }),
				),
			)
		}
	}
	override close(code = 1000, reason = '') {
		if (code !== 1000 && (code < 3000 || code > 4999)) {
			throw new DOMException('invalid code', 'InvalidAccessError')
		}
		super.close(code, reason)
	}
}

async function serverFrames(
	frames: Array<Pick<EcpFramePayload, 't' | 'body'> & { kid?: string }>,
) {
	const { privateKeyJwk } = await generateContextKey()
	const privateKey = await importContextKey(privateKeyJwk)
	const signed = await Promise.all(
		frames.map((frame, index) =>
			signFrame({
				privateKey,
				kid: frame.kid ?? 'srv_test',
				payload: {
					v: 1,
					t: frame.t,
					ec: 'ec_test',
					sid: 'sid_test',
					seq: index + 1,
					ts: Date.now(),
					body: frame.body,
				},
			}),
		),
	)
	return {
		signed,
		serverKeys: [{ kid: 'srv_test', x: privateKeyJwk.x, notAfter: 4e12 }],
	}
}

const welcome = { t: 'welcome', body: { sid: 'sid_test', grantVersion: 1 } }

test('a half-dead socket that stops answering pings is closed with a heartbeat code', async () => {
	SilentSocket.instances = []
	const { signed, serverKeys } = await serverFrames([welcome])
	ServerSocket.frames = signed
	ServerSocket.answerPings = false
	const { input, lines } = await daemonInput({
		serverKeys,
		pingMs: 30,
		pongTimeoutMs: 30,
		closeSettleMs: 20,
		WebSocketImpl: ServerSocket as unknown as typeof WebSocket,
	})
	const closed = await runDaemonConnection(input)
	assert.deepEqual(closed, {
		code: heartbeatTimeoutCloseCode,
		reason: 'heartbeat timeout',
	})
	assert.match(lines.join('\n'), /did not answer a ping/)
	assert.ok(
		(SilentSocket.instances[0] as unknown as ServerSocket).sent.includes(
			ecpPingFrame,
		),
	)
})

test('a socket that answers pings stays connected until shutdown', async () => {
	SilentSocket.instances = []
	const { signed, serverKeys } = await serverFrames([welcome])
	ServerSocket.frames = signed
	ServerSocket.answerPings = true
	const abort = new AbortController()
	setTimeout(() => abort.abort(), 200)
	const { input, lines } = await daemonInput({
		serverKeys,
		pingMs: 20,
		pongTimeoutMs: 20,
		signal: abort.signal,
		WebSocketImpl: ServerSocket as unknown as typeof WebSocket,
	})
	const closed = await runDaemonConnection(input)
	assert.deepEqual(closed, { code: 1000, reason: 'shutdown' })
	assert.ok(lines.includes('Connected. Waiting for runs.'))
	assert.ok(!lines.some((line) => /ping|Frame error/.test(line)))
	ServerSocket.answerPings = false
})

test('hello tells Kody which runs this daemon still holds after a reconnect', async () => {
	SilentSocket.instances = []
	const { signed, serverKeys } = await serverFrames([welcome])
	ServerSocket.frames = signed
	const abort = new AbortController()
	const { input } = await daemonInput({
		serverKeys,
		signal: abort.signal,
		WebSocketImpl: ServerSocket as unknown as typeof WebSocket,
	})
	setTimeout(() => abort.abort(), 100)
	await runDaemonConnection(input)
	const hello = (SilentSocket.instances[0] as unknown as ServerSocket).sent
		.filter((data) => data !== ecpPingFrame)
		.map((data) => {
			const envelope = parseEnvelope(JSON.parse(data))
			return decodeEnvelopePayload(envelope!.p) as EcpFramePayload
		})
		.find((frame) => frame.t === 'hello')
	assert.deepEqual(hello?.body.heldRuns, [])
	assert.deepEqual(hello?.body.pendingResults, [])
})

test('frames that arrive back to back are verified in order, not raced', async () => {
	SilentSocket.instances = []
	const { signed, serverKeys } = await serverFrames([
		welcome,
		{ t: 'grant.update', body: { grantVersion: 2 } },
		{ t: 'grant.update', body: { grantVersion: 3 } },
	])
	ServerSocket.frames = signed
	const abort = new AbortController()
	const { input, lines } = await daemonInput({
		serverKeys,
		signal: abort.signal,
		WebSocketImpl: ServerSocket as unknown as typeof WebSocket,
		log: (line: string) => {
			lines.push(line)
		},
	})
	setTimeout(() => abort.abort(), 150)
	const closed = await runDaemonConnection(input)
	assert.deepEqual(closed, { code: 1000, reason: 'shutdown' })
	assert.deepEqual(
		lines.filter((line) => /verification|Frame error/.test(line)),
		[],
	)
	const sent = (SilentSocket.instances[0] as unknown as ServerSocket).sent
	assert.equal(sent.filter((data) => data !== ecpPingFrame).length, 3)
})

test('a frame that fails verification closes with a valid code instead of throwing', async () => {
	SilentSocket.instances = []
	const { signed, serverKeys } = await serverFrames([
		{ ...welcome, kid: 'srv_unknown' },
	])
	ServerSocket.frames = signed
	const { input, lines } = await daemonInput({
		serverKeys,
		WebSocketImpl: ServerSocket as unknown as typeof WebSocket,
	})
	const closed = await runDaemonConnection(input)
	assert.deepEqual(closed, {
		code: frameRejectedCloseCode,
		reason: 'unknown_server_key',
	})
	assert.match(lines.join('\n'), /failed verification \(unknown_server_key\)/)
	assert.ok(!lines.some((line) => line.startsWith('Frame error')))
})
