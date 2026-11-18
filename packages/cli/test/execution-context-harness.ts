import {
	ecpPingFrame,
	ecpPongFrame,
	signFrame,
	type EcpFramePayload,
} from '@kody-internal/shared/execution-context-protocol/index.ts'
import {
	generateContextKey,
	importContextKey,
} from '../src/execution-context/client.js'

/** Opens, answers nothing: the production failure where welcome never came. */
export class SilentSocket extends EventTarget {
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

export async function daemonInput(overrides: Record<string, unknown> = {}) {
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

/**
 * A Kody-side socket that opens with a signed welcome. Like Node's
 * WebSocket, close() only accepts 1000 or 3000-4999.
 */
export class ServerSocket extends SilentSocket {
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

export async function serverFrames(
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

export const welcome = {
	t: 'welcome',
	body: { sid: 'sid_test', grantVersion: 1 },
}
