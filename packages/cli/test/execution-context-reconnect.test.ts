import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	decodeEnvelopePayload,
	ecpPingFrame,
	parseEnvelope,
	signFrame,
	type EcpFramePayload,
} from '@kody-internal/shared/execution-context-protocol/index.ts'
import {
	generateContextKey,
	importContextKey,
} from '../src/execution-context/client.js'
import {
	runDaemon,
	type ContextRunExecutor,
} from '../src/execution-context/daemon.js'
import {
	daemonInput,
	ServerSocket,
	SilentSocket,
} from './execution-context-harness.js'

type Frame = Pick<EcpFramePayload, 't' | 'body'>

/**
 * Plays Kody's side of every connection: a signed welcome on open, an ack
 * for each run.result, and whatever frames a test pushes. Each connection
 * starts a fresh sequence, like a real session.
 */
async function fakeKody() {
	const { privateKeyJwk } = await generateContextKey()
	const privateKey = await importContextKey(privateKeyJwk)
	const sockets: Array<KodySocket> = []
	let onConnect: (socket: KodySocket) => void = () => {}
	class KodySocket extends ServerSocket {
		seq = 0
		frames: Array<EcpFramePayload> = []
		failSends = false
		constructor(url: string) {
			super(url)
			sockets.push(this)
			setTimeout(() => {
				void this.push({
					t: 'welcome',
					body: { sid: `sid_${sockets.length}`, grantVersion: 1 },
				}).then(() => onConnect(this))
			}, 0)
		}
		pushed: Promise<void> = Promise.resolve()
		/** Signing is async; chain it so frames arrive in sequence order. */
		push(frame: Frame) {
			this.pushed = this.pushed.then(() => this.sign(frame))
			return this.pushed
		}
		async sign(frame: Frame) {
			if (this.readyState !== this.OPEN) return
			this.seq += 1
			const data = await signFrame({
				privateKey,
				kid: 'srv_test',
				payload: {
					v: 1,
					t: frame.t,
					ec: 'ec_test',
					sid: `sid_${sockets.indexOf(this) + 1}`,
					seq: this.seq,
					ts: Date.now(),
					body: frame.body,
				},
			})
			this.dispatchEvent(Object.assign(new Event('message'), { data }))
		}
		override send(data = '') {
			if (data === ecpPingFrame) return
			if (this.failSends) throw new Error('socket write failed')
			super.send(data)
			const frame = decodeEnvelopePayload(
				parseEnvelope(JSON.parse(data))!.p,
			) as EcpFramePayload
			this.frames.push(frame)
			if (frame.t === 'run.result') {
				void this.push({
					t: 'run.result.ack',
					body: { runId: frame.body.runId },
				})
			}
		}
		/** The network dropped: no close handshake, code 1006. */
		drop() {
			SilentSocket.prototype.close.call(this, 1006, '')
		}
		sentTypes() {
			return this.frames.map((frame) => frame.t)
		}
	}
	return {
		Socket: KodySocket as unknown as typeof WebSocket,
		sockets,
		serverKeys: [{ kid: 'srv_test', x: privateKeyJwk.x, notAfter: 4e12 }],
		onConnect: (listener: (socket: KodySocket) => void) => {
			onConnect = listener
		},
	}
}

function runFrames(runId: string, deadlineMs = 60_000): Array<Frame> {
	const now = Date.now()
	return [
		{
			t: 'run.request',
			body: {
				runId,
				deadline: now + deadlineMs,
				acceptBy: now + 5_000,
				requestedBy: { userId: 'user_requester', handle: 'requester' },
				source: { kind: 'code', code: 'export default () => 1', sha256: 'x' },
				params: {},
				credentialPicks: {},
				limits: {
					timeoutMs: deadlineMs,
					maxResultBytes: 102_400,
					memoryMb: 512,
				},
				grantVersion: 1,
				apiUrl: 'https://api.kody.test',
			},
		},
		{ t: 'run.commit', body: { runId } },
	]
}

/** Reconnect backoff doubles from 1-2s, so the 4th connection takes up to 15s. */
let daemonLog: Array<string> = []

async function until(check: () => boolean, what: string, ms = 20_000) {
	const started = Date.now()
	while (!check()) {
		if (Date.now() - started > ms)
			throw new Error(`Timed out: ${what}\n${daemonLog.join('\n')}`)
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}

/** A run that ends when the test says so, or when it is aborted. */
function controlledRuns() {
	const started: Array<string> = []
	const aborted: Array<string> = []
	const finishers = new Map<string, (text: string) => void>()
	const execute: ContextRunExecutor = ({ request, signal }) =>
		new Promise((resolve) => {
			started.push(request.runId)
			finishers.set(request.runId, (text) =>
				resolve({ isError: false, content: [{ type: 'text', text }] }),
			)
			signal.addEventListener('abort', () => {
				aborted.push(request.runId)
				resolve({
					isError: true,
					content: [{ type: 'text', text: 'Local execute was cancelled.' }],
				})
			})
		})
	return {
		execute,
		started,
		aborted,
		finish: (runId: string, text = 'done') => finishers.get(runId)?.(text),
	}
}

function resultOf(
	socket: { frames: Array<EcpFramePayload> } | undefined,
	runId: string,
) {
	return socket?.frames.find(
		(frame) => frame.t === 'run.result' && frame.body.runId === runId,
	)
}

async function startDaemon(maxConcurrent = 1) {
	SilentSocket.instances = []
	const kody = await fakeKody()
	const runs = controlledRuns()
	const abort = new AbortController()
	const { input, lines } = await daemonInput({
		serverKeys: kody.serverKeys,
		maxConcurrent,
		closeSettleMs: 20,
		signal: abort.signal,
		WebSocketImpl: kody.Socket,
		execute: runs.execute,
	})
	daemonLog = lines
	const stopped = runDaemon(input)
	const stop = async () => {
		abort.abort()
		return await stopped
	}
	return { kody, runs, lines, stop }
}

test('a socket drop mid-run keeps the daemon up and reports the result over the next connection', async () => {
	const { kody, runs, lines, stop } = await startDaemon()
	kody.onConnect((socket) => {
		if (kody.sockets.length === 1) {
			for (const frame of runFrames('run_mid')) void socket.push(frame)
		}
	})
	await until(() => runs.started.includes('run_mid'), 'run started')
	kody.sockets[0]!.drop()
	await until(
		() => kody.sockets[1]?.sentTypes().includes('hello') === true,
		'reconnected',
	)
	const hello = kody.sockets[1]!.frames.find((frame) => frame.t === 'hello')
	assert.deepEqual(hello?.body.heldRuns, ['run_mid'])
	assert.deepEqual(runs.aborted, [], 'the drop did not abort the run')
	runs.finish('run_mid', 'survived')
	await until(
		() => resultOf(kody.sockets[1], 'run_mid') !== undefined,
		'result',
	)
	assert.deepEqual(resultOf(kody.sockets[1], 'run_mid')?.body.content, [
		{ type: 'text', text: 'survived' },
	])
	assert.equal(await stop(), 'shutdown')
	assert.match(lines.join('\n'), /Disconnected \(1006\)\. Reconnecting\./)
})

test('a drop while the run.result is being sent queues it for the next connection', async () => {
	const { kody, runs, stop } = await startDaemon()
	kody.onConnect((socket) => {
		if (kody.sockets.length === 1) {
			for (const frame of runFrames('run_send')) void socket.push(frame)
		}
	})
	await until(() => runs.started.includes('run_send'), 'run started')
	// The write fails and the socket is gone by the time the result is ready.
	kody.sockets[0]!.failSends = true
	runs.finish('run_send', 'finished while offline')
	kody.sockets[0]!.drop()
	await until(
		() => resultOf(kody.sockets[1], 'run_send') !== undefined,
		'result',
	)
	const hello = kody.sockets[1]!.frames.find((frame) => frame.t === 'hello')
	assert.deepEqual(hello?.body.heldRuns, ['run_send'])
	assert.deepEqual(resultOf(kody.sockets[1], 'run_send')?.body.content, [
		{ type: 'text', text: 'finished while offline' },
	])
	assert.equal(await stop(), 'shutdown')
})

test('a socket that closes while the result write is in flight never kills the daemon', async () => {
	const { kody, runs, stop } = await startDaemon()
	kody.onConnect((socket) => {
		if (kody.sockets.length === 1) {
			for (const frame of runFrames('run_race')) void socket.push(frame)
		}
	})
	await until(() => runs.started.includes('run_race'), 'run started')
	// Finish and drop in the same tick: the send sees a closed socket.
	runs.finish('run_race', 'raced')
	kody.sockets[0]!.drop()
	await until(
		() => resultOf(kody.sockets[1], 'run_race') !== undefined,
		'result',
	)
	assert.equal(await stop(), 'shutdown')
})

test('repeated drops keep reconnecting, and every new connection still accepts runs', async () => {
	const { kody, runs, stop } = await startDaemon(4)
	kody.onConnect((socket) => {
		const index = kody.sockets.length
		for (const frame of runFrames(`run_${index}`)) void socket.push(frame)
	})
	for (let index = 1; index <= 3; index += 1) {
		await until(() => runs.started.includes(`run_${index}`), `run_${index}`)
		kody.sockets[index - 1]!.drop()
	}
	await until(
		() => runs.started.includes('run_4'),
		'run_4 on the 4th connection',
	)
	const hello = kody.sockets[3]!.frames.find((frame) => frame.t === 'hello')
	assert.deepEqual(runs.started, ['run_1', 'run_2', 'run_3', 'run_4'])
	assert.deepEqual(hello?.body.heldRuns, ['run_1', 'run_2', 'run_3'])
	for (const runId of ['run_1', 'run_2', 'run_3', 'run_4']) runs.finish(runId)
	for (const runId of ['run_1', 'run_2', 'run_3', 'run_4']) {
		await until(
			() => resultOf(kody.sockets[3], runId) !== undefined,
			`${runId} result`,
		)
	}
	assert.equal(await stop(), 'shutdown')
})
