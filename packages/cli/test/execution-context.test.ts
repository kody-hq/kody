import assert from 'node:assert/strict'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { effectiveFs } from '../src/execution-context/fs-access.js'
import { HostCommands } from '../src/execution-context/host-commands.js'
import { runContextRun } from '../src/execution-context/run-executor.js'
import {
	abortableDelay,
	frameRejectedCloseCode,
	heartbeatTimeoutCloseCode,
	runDaemon,
	runDaemonConnection,
	type ContextRunExecutor,
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

test('a run the local deadline stops reports cancelReason deadline, not a code error', async () => {
	SilentSocket.instances = []
	const runId = 'run_deadline'
	const { signed, serverKeys } = await serverFrames([
		welcome,
		{
			t: 'run.request',
			body: {
				runId,
				deadline: Date.now() + 50,
				acceptBy: Date.now() + 5_000,
				requestedBy: { userId: 'user_requester', handle: 'requester' },
				source: { kind: 'code', code: 'export default () => 1', sha256: 'x' },
				params: {},
				credentialPicks: {},
				limits: { timeoutMs: 50, maxResultBytes: 102_400, memoryMb: 512 },
				grantVersion: 1,
				apiUrl: 'https://api.kody.test',
			},
		},
		{ t: 'run.commit', body: { runId } },
	])
	ServerSocket.frames = signed
	const abort = new AbortController()
	const { input } = await daemonInput({
		serverKeys,
		signal: abort.signal,
		WebSocketImpl: ServerSocket as unknown as typeof WebSocket,
		execute: ({ signal }: { signal: AbortSignal }) =>
			new Promise((resolve) =>
				signal.addEventListener('abort', () =>
					resolve({
						isError: true,
						content: [{ type: 'text', text: 'Local execute was cancelled.' }],
					}),
				),
			),
	})
	const sentResult = () =>
		(SilentSocket.instances[0] as unknown as ServerSocket | undefined)?.sent
			.filter((data) => data !== ecpPingFrame)
			.some(
				(data) =>
					(
						decodeEnvelopePayload(
							parseEnvelope(JSON.parse(data))!.p,
						) as EcpFramePayload
					).t === 'run.result',
			)
	const poll = setInterval(() => {
		if (sentResult()) abort.abort()
	}, 10)
	const giveUp = setTimeout(() => abort.abort(), 10_000)
	await runDaemonConnection(input)
	clearInterval(poll)
	clearTimeout(giveUp)
	const result = (SilentSocket.instances[0] as unknown as ServerSocket).sent
		.filter((data) => data !== ecpPingFrame)
		.map((data) => {
			const envelope = parseEnvelope(JSON.parse(data))
			return decodeEnvelopePayload(envelope!.p) as EcpFramePayload
		})
		.find((frame) => frame.t === 'run.result')
	assert.equal(result?.body.runId, runId)
	assert.equal(result?.body.isError, true)
	assert.equal(result?.body.cancelReason, 'deadline')
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

test('a failed send ends the connection instead of leaving a sequence gap', async () => {
	SilentSocket.instances = []
	const { signed, serverKeys } = await serverFrames([welcome])
	ServerSocket.frames = signed
	class FailingSocket extends ServerSocket {
		override send(data = '') {
			if (data !== ecpPingFrame) throw new Error('socket write failed')
			super.send(data)
		}
	}
	const abort = new AbortController()
	const { input } = await daemonInput({
		serverKeys,
		signal: abort.signal,
		WebSocketImpl: FailingSocket as unknown as typeof WebSocket,
	})
	const timeout = setTimeout(() => abort.abort(), 5_000)
	const closed = await runDaemonConnection(input)
	clearTimeout(timeout)
	assert.equal(closed.code, 4000)
	assert.deepEqual(SilentSocket.instances[0]?.closed, {
		code: 4000,
		reason: 'send failed',
	})
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

test('runs get the grant egress from welcome, re-applied on grant.update', async () => {
	SilentSocket.instances = []
	const now = Date.now()
	const runRequest = (runId: string) => ({
		t: 'run.request',
		body: {
			runId,
			deadline: now + 60_000,
			acceptBy: now + 60_000,
			requestedBy: { userId: 'u', handle: null, orgId: 'o', orgSlug: null },
			source: { kind: 'code', code: 'export default () => 1', sha256: '' },
			params: {},
			credentialPicks: {},
			limits: { timeoutMs: 60_000, maxResultBytes: 1_000_000, memoryMb: 128 },
			grantVersion: 1,
			apiUrl: 'https://api.kody.test',
		},
	})
	const { signed, serverKeys } = await serverFrames([
		{
			t: 'welcome',
			body: {
				sid: 'sid_test',
				grantVersion: 1,
				grant: { egress: { mode: 'public' } },
			},
		},
		runRequest('run_1'),
		{ t: 'run.commit', body: { runId: 'run_1' } },
		{
			t: 'grant.update',
			body: {
				grantVersion: 2,
				grant: { egress: { mode: 'allowlist', hosts: ['api.example.com'] } },
			},
		},
		runRequest('run_2'),
		{ t: 'run.commit', body: { runId: 'run_2' } },
	])
	ServerSocket.frames = signed
	const abort = new AbortController()
	const seen: Array<unknown> = []
	const { input } = await daemonInput({
		serverKeys,
		signal: abort.signal,
		WebSocketImpl: ServerSocket as unknown as typeof WebSocket,
		maxConcurrent: 2,
		execute: async (run: Parameters<ContextRunExecutor>[0]) => {
			seen.push(run.egress)
			if (seen.length === 2) setTimeout(() => abort.abort(), 20)
			return { isError: false }
		},
	})
	const timeout = setTimeout(() => abort.abort(), 5_000)
	await runDaemonConnection(input)
	clearTimeout(timeout)
	assert.deepEqual(seen, [
		{ mode: 'public' },
		{ mode: 'allowlist', hosts: ['api.example.com'] },
	])
})

test('grant.update re-applies host folders: capabilities follow the effective mounts and a run writes inside them only', async () => {
	SilentSocket.instances = []
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'kody-daemon-fs-')))
	const granted = join(root, 'granted')
	const outside = join(root, 'outside')
	mkdirSync(granted)
	mkdirSync(outside)
	const code = `import { writeFile } from 'node:fs/promises'
export default async function main(p) {
	await writeFile(p.granted + '/hello.txt', 'from the daemon')
	try { await writeFile(p.outside + '/nope.txt', 'x'); return 'escaped' } catch (error) { return error.code }
}`
	const now = Date.now()
	const { signed, serverKeys } = await serverFrames([
		{
			t: 'welcome',
			body: { sid: 'sid_test', grantVersion: 1, grant: { fs: [] } },
		},
		{
			t: 'grant.update',
			body: { grantVersion: 2, grant: { fs: [{ path: granted, mode: 'rw' }] } },
		},
		{
			t: 'run.request',
			body: {
				runId: 'run_fs',
				deadline: now + 120_000,
				acceptBy: now + 120_000,
				requestedBy: { userId: 'u', handle: null, orgId: 'o', orgSlug: null },
				source: { kind: 'code', code, sha256: '' },
				params: { granted, outside },
				credentialPicks: {},
				limits: { timeoutMs: 60_000, maxResultBytes: 1_000_000, memoryMb: 128 },
				grantVersion: 2,
				apiUrl: 'https://api.kody.test',
			},
		},
		{ t: 'run.commit', body: { runId: 'run_fs' } },
	])
	ServerSocket.frames = signed
	const abort = new AbortController()
	const { input } = await daemonInput({
		serverKeys,
		signal: abort.signal,
		WebSocketImpl: ServerSocket as unknown as typeof WebSocket,
		fs: {
			effective: async (grantFs: Array<{ path: string; mode: string }>) =>
				await effectiveFs(grantFs, [
					{ path: granted, mode: 'rw' },
					{ path: outside, mode: 'rw' },
				]),
		},
		fetchFn: (async (url: string | URL | Request) =>
			String(url).includes('package-graph')
				? Response.json({ modules: [] })
				: Response.json({
						ticket: 'ticket_1',
						expiresAt: '2099-01-01T00:00:00.000Z',
					})) as typeof fetch,
		execute: (run: Parameters<ContextRunExecutor>[0]) =>
			runContextRun({ ...run, apiUrl: 'https://api.kody.test' }),
	})
	const decoded = () =>
		(SilentSocket.instances[0] as unknown as ServerSocket | undefined)?.sent
			.filter((data) => data !== ecpPingFrame)
			.map((data) => {
				const envelope = parseEnvelope(JSON.parse(data))
				return decodeEnvelopePayload(envelope!.p) as EcpFramePayload
			}) ?? []
	const watcher = setInterval(() => {
		if (decoded().some((frame) => frame.t === 'run.result')) abort.abort()
	}, 50)
	const timeout = setTimeout(() => abort.abort(), 120_000)
	await runDaemonConnection(input)
	clearInterval(watcher)
	clearTimeout(timeout)
	const frames = decoded()
	const hello = frames.find((frame) => frame.t === 'hello')
	assert.deepEqual(
		(hello?.body.capabilities as { features?: unknown }).features,
		[],
	)
	const update = frames.find((frame) => frame.t === 'capabilities.update')
	assert.deepEqual(
		(update?.body.capabilities as { features?: unknown }).features,
		['fs'],
	)
	const result = frames.find((frame) => frame.t === 'run.result')
	assert.equal(result?.body.isError, false, JSON.stringify(result?.body))
	// Outside the mounts the host is unreachable: EACCES from the bridge, or
	// ENOENT when the path falls in workerd's own virtual /tmp (Linux tmpdir).
	assert.match(
		String((result?.body.structuredContent as { result?: unknown }).result),
		/^(EACCES|ENOENT)$/,
	)
	assert.equal(
		readFileSync(join(granted, 'hello.txt'), 'utf8'),
		'from the daemon',
	)
	assert.equal(existsSync(join(outside, 'nope.txt')), false)
})

test('runs up to the grant-capped concurrency at once and report a timing breakdown', async () => {
	SilentSocket.instances = []
	const now = Date.now()
	const runRequest = (runId: string) => ({
		t: 'run.request',
		body: {
			runId,
			deadline: now + 60_000,
			acceptBy: now + 60_000,
			requestedBy: { userId: 'u', handle: null, orgId: 'o', orgSlug: null },
			source: { kind: 'code', code: 'export default () => 1', sha256: '' },
			params: {},
			credentialPicks: {},
			limits: { timeoutMs: 60_000, maxResultBytes: 1_000_000, memoryMb: 128 },
			grantVersion: 1,
			apiUrl: 'https://api.kody.test',
		},
	})
	const { signed, serverKeys } = await serverFrames([
		{
			t: 'welcome',
			body: {
				sid: 'sid_test',
				grantVersion: 1,
				grant: { limits: { maxConcurrent: 2 } },
			},
		},
		runRequest('run_1'),
		{ t: 'run.commit', body: { runId: 'run_1' } },
		runRequest('run_2'),
		{ t: 'run.commit', body: { runId: 'run_2' } },
		runRequest('run_3'),
	])
	ServerSocket.frames = signed
	const abort = new AbortController()
	let inFlight = 0
	let peak = 0
	let releaseBoth = () => {}
	const bothRunning = new Promise<void>((resolve) => {
		releaseBoth = resolve
	})
	const { input } = await daemonInput({
		serverKeys,
		signal: abort.signal,
		WebSocketImpl: ServerSocket as unknown as typeof WebSocket,
		maxConcurrent: 4,
		execute: async (_run: Parameters<ContextRunExecutor>[0]) => {
			inFlight += 1
			peak = Math.max(peak, inFlight)
			if (inFlight === 2) releaseBoth()
			await bothRunning
			// Still holding both slots while run_3 arrives.
			await new Promise((resolve) => setTimeout(resolve, 50))
			inFlight -= 1
			if (inFlight === 0) setTimeout(() => abort.abort(), 20)
			return {
				isError: false,
				timing: {
					setupMs: 12,
					packageGraphMs: 0,
					packageGraphCached: true,
					executeMs: 3,
				},
			}
		},
	})
	const timeout = setTimeout(() => abort.abort(), 5_000)
	await runDaemonConnection(input)
	clearTimeout(timeout)
	const frames = (SilentSocket.instances[0] as unknown as ServerSocket).sent
		.filter((data) => data !== ecpPingFrame)
		.map((data) => {
			const envelope = parseEnvelope(JSON.parse(data))
			return decodeEnvelopePayload(envelope!.p) as EcpFramePayload
		})
	assert.equal(peak, 2)
	assert.deepEqual(
		frames.map((frame) => frame.seq),
		frames.map((_frame, index) => index + 1),
	)
	assert.equal(
		(
			frames.find((frame) => frame.t === 'hello')?.body.capabilities as {
				maxConcurrent?: unknown
			}
		).maxConcurrent,
		2,
	)
	assert.deepEqual(frames.find((frame) => frame.t === 'hello')?.body.status, {
		running: 0,
		maxConcurrent: 2,
		acceptingRuns: true,
	})
	assert.deepEqual(
		frames
			.filter((frame) => frame.t === 'run.reject')
			.map((frame) => frame.body),
		[{ runId: 'run_3', code: 'busy' }],
	)
	const results = frames.filter((frame) => frame.t === 'run.result')
	assert.equal(results.length, 2)
	for (const result of results) {
		const timing = result.body.timing as Record<string, unknown>
		assert.equal(timing.setupMs, 12)
		assert.equal(timing.executeMs, 3)
		assert.equal(timing.packageGraphCached, true)
		assert.equal(typeof timing.queueMs, 'number')
		assert.ok((timing.daemonMs as number) >= (timing.queueMs as number))
		assert.equal(
			(result.body.structuredContent as Record<string, unknown> | undefined)
				?.timing,
			undefined,
		)
	}
})

test('a flag-off account gets the opt-in link instead of a bare 403', async () => {
	const fetchFn = (async () =>
		Response.json(
			{
				error: {
					code: 'feature_disabled',
					message: 'Execution contexts are an experiment that is off.',
				},
			},
			{ status: 403 },
		)) as typeof fetch
	await assert.rejects(
		runExecutionContextCommand({
			command: 'chain',
			positionals: ['show'],
			values: {},
			apiUrl: 'https://kody.test/',
			token: async () => 'kody_at_test',
			clientVersion: '0.0.0',
			write: () => {},
			fetchFn,
		}),
		(error: Error) => {
			assert.match(error.message, /experiment that is off for this account/)
			assert.match(error.message, /https:\/\/kody\.test\/account\/experiments/)
			assert.match(error.message, /experimentSet/)
			assert.match(
				error.message,
				/https:\/\/kody\.test\/docs\/execution-contexts/,
			)
			return true
		},
	)
})

test('kody context revoke and delete call the revoke and delete routes', async () => {
	const calls: Array<string> = []
	const fetchFn = (async (url: URL | string, init?: RequestInit) => {
		calls.push(`${init?.method} ${new URL(url).pathname}`)
		return Response.json({ ok: true })
	}) as typeof fetch
	const run = async (positionals: Array<string>) => {
		let text = ''
		await runExecutionContextCommand({
			command: 'context',
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
		await run(['revoke', 'box']),
		'Revoked box. Delete it for good with: kody context delete box\n',
	)
	assert.equal(await run(['delete', 'box']), 'Deleted box.\n')
	assert.deepEqual(calls, [
		'DELETE /v1/execution-contexts/box',
		'POST /v1/execution-contexts/box/delete',
	])
	await assert.rejects(run(['delete']), /Usage: kody context delete/)
})

test('kody context cancel-run posts to the run cancel route', async () => {
	const calls: Array<string> = []
	const replies = [
		{ cancelled: true, runId: 'run_1', state: 'cancelled' },
		{ cancelled: false, runId: 'run_1', state: 'succeeded' },
	]
	const fetchFn = (async (url: URL | string, init?: RequestInit) => {
		calls.push(`${init?.method} ${new URL(url).pathname}`)
		return Response.json(replies.shift())
	}) as typeof fetch
	const run = async (positionals: Array<string>) => {
		let text = ''
		await runExecutionContextCommand({
			command: 'context',
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
		await run(['cancel-run', 'build box', 'run_1']),
		'Cancelled run run_1 on build box.\n',
	)
	assert.equal(
		await run(['cancel-run', 'build box', 'run_1']),
		'Run run_1 already ended (succeeded).\n',
	)
	assert.deepEqual(calls, [
		'POST /v1/execution-contexts/build%20box/runs/run_1/cancel',
		'POST /v1/execution-contexts/build%20box/runs/run_1/cancel',
	])
	await assert.rejects(
		run(['cancel-run', 'build box']),
		/Usage: kody context cancel-run/,
	)
})

test('a context run with commands on runs a real command and a background job, authorized and reported to Kody', async () => {
	SilentSocket.instances = []
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'kody-daemon-cmd-')))
	const code = `import { kody } from 'kody:runtime'
export default async function main(p) {
	const fg = await kody.command.run({ command: 'echo hello-from-host; pwd; echo warn >&2; exit 2', cwd: p.cwd, env: { KODY_E2E_SECRET: 'do-not-log' } })
	const bg = await kody.command.start({ command: 'echo bg-start; sleep 30' })
	let out
	for (let i = 0; i < 200; i++) {
		out = await kody.command.output({ commandId: bg.commandId })
		if (out.stdout.includes('bg-start')) break
		await new Promise((resolve) => setTimeout(resolve, 25))
	}
	const status = await kody.command.status({ commandId: bg.commandId })
	await kody.command.kill({ commandId: bg.commandId })
	return { fg, bgOut: out.stdout, bgState: status.state }
}`
	const now = Date.now()
	const { signed, serverKeys } = await serverFrames([
		{
			t: 'welcome',
			body: {
				sid: 'sid_test',
				grantVersion: 1,
				grant: { fs: [], commands: { enabled: true } },
			},
		},
		{
			t: 'run.request',
			body: {
				runId: 'run_cmd',
				deadline: now + 120_000,
				acceptBy: now + 120_000,
				requestedBy: { userId: 'u', handle: null, orgId: 'o', orgSlug: null },
				source: { kind: 'code', code, sha256: '' },
				params: { cwd },
				credentialPicks: {},
				limits: { timeoutMs: 60_000, maxResultBytes: 1_000_000, memoryMb: 128 },
				grantVersion: 1,
				apiUrl: 'https://api.kody.test',
			},
		},
		{ t: 'run.commit', body: { runId: 'run_cmd' } },
	])
	ServerSocket.frames = signed
	const abort = new AbortController()
	const authorized: Array<{ path: unknown; args: unknown }> = []
	const hostCommands = new HostCommands({ localEnabled: true })
	const { input } = await daemonInput({
		serverKeys,
		signal: abort.signal,
		hostCommands,
		WebSocketImpl: ServerSocket as unknown as typeof WebSocket,
		fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
			if (String(url).includes('package-graph')) {
				return Response.json({ modules: [] })
			}
			if (String(url).includes('capability-proxy/call')) {
				const body = JSON.parse(String(init?.body)) as {
					path: unknown
					args: Array<unknown>
				}
				authorized.push({ path: body.path, args: body.args[0] })
				return Response.json({ result: { ok: true } })
			}
			return Response.json({
				ticket: 'ticket_1',
				expiresAt: '2099-01-01T00:00:00.000Z',
			})
		}) as typeof fetch,
		execute: (run: Parameters<ContextRunExecutor>[0]) =>
			runContextRun({ ...run, apiUrl: 'https://api.kody.test' }),
	})
	const decoded = () =>
		(SilentSocket.instances[0] as unknown as ServerSocket | undefined)?.sent
			.filter((data) => data !== ecpPingFrame)
			.map((data) => {
				const envelope = parseEnvelope(JSON.parse(data))
				return decodeEnvelopePayload(envelope!.p) as EcpFramePayload
			}) ?? []
	const watcher = setInterval(() => {
		const frames = decoded()
		if (
			frames.some((frame) => frame.t === 'run.result') &&
			frames.filter((frame) => frame.t === 'command.finished').length >= 2
		) {
			abort.abort()
		}
	}, 50)
	const timeout = setTimeout(() => abort.abort(), 120_000)
	await runDaemonConnection(input)
	clearInterval(watcher)
	clearTimeout(timeout)
	hostCommands.killAll('shutdown')
	const frames = decoded()
	const result = frames.find((frame) => frame.t === 'run.result')
	assert.equal(result?.body.isError, false, JSON.stringify(result?.body))
	const value = (result?.body.structuredContent as { result: any }).result
	assert.equal(value.fg.exitCode, 2)
	assert.equal(value.fg.stdout, `hello-from-host\n${cwd}\n`)
	assert.equal(value.fg.stderr, 'warn\n')
	assert.match(value.bgOut, /^bg-start/)
	assert.equal(value.bgState, 'running')
	assert.ok(
		authorized.some(
			(call) => (call.args as { lifecycle?: string }).lifecycle === 'output',
		),
	)
	const starts = authorized.filter(
		(call) => !(call.args as { lifecycle?: string }).lifecycle,
	)
	assert.deepEqual(
		starts.map((call) => [
			call.path,
			(call.args as { background: boolean }).background,
		]),
		[
			[['kody', 'command', 'authorize'], false],
			[['kody', 'command', 'authorize'], true],
		],
	)
	assert.deepEqual((starts[0]?.args as { envKeys: unknown }).envKeys, [
		'KODY_E2E_SECRET',
	])
	const finished = frames.filter((frame) => frame.t === 'command.finished')
	assert.deepEqual(
		finished.map((frame) => [
			frame.body.exitCode ?? null,
			frame.body.background,
			frame.body.reason,
		]),
		[
			[2, false, 'exited'],
			[null, true, 'killed'],
		],
	)
	assert.equal(finished[0]?.body.runId, 'run_cmd')
	assert.equal(JSON.stringify(frames).includes('do-not-log'), false)
	assert.equal(JSON.stringify(authorized).includes('do-not-log'), false)
})

test('a daemon another daemon replaced stands down instead of flapping', async () => {
	SilentSocket.instances = []
	const { signed, serverKeys } = await serverFrames([welcome])
	class ReplacedSocket extends ServerSocket {
		constructor(url: string) {
			super(url)
			setTimeout(
				() => SilentSocket.prototype.close.call(this, 1012, 'replaced'),
				20,
			)
		}
	}
	ServerSocket.frames = signed
	let tickets = 0
	const { input } = await daemonInput({
		serverKeys,
		closeSettleMs: 20,
		WebSocketImpl: ReplacedSocket as unknown as typeof WebSocket,
		fetchFn: (async () => {
			tickets += 1
			return Response.json({
				ticket: 'ticket_1',
				expiresAt: '2099-01-01T00:00:00.000Z',
			})
		}) as typeof fetch,
	})
	assert.equal(await runDaemon(input), 'replaced')
	assert.equal(tickets, 1, 'no reconnect loop')
})

test('an update drain holds the connection while background commands run', async () => {
	SilentSocket.instances = []
	const { signed, serverKeys } = await serverFrames([welcome])
	ServerSocket.frames = signed
	const drain = new AbortController()
	let holding = true
	setTimeout(() => drain.abort(), 30)
	setTimeout(() => {
		holding = false
	}, 250)
	const { input } = await daemonInput({
		serverKeys,
		closeSettleMs: 20,
		drainSignal: drain.signal,
		drainHold: () => holding,
		drainHoldPollMs: 20,
		WebSocketImpl: ServerSocket as unknown as typeof WebSocket,
	})
	const started = Date.now()
	const closed = await runDaemonConnection(input)
	assert.deepEqual(closed, { code: 1000, reason: 'shutdown' })
	assert.ok(Date.now() - started >= 240, 'waited for the hold to clear')
})
