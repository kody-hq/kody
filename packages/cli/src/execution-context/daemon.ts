import {
	classifyFrameText,
	decodeEnvelopePayload,
	ecpContextKeyId,
	ecpPingFrame,
	ecpProtocolVersion,
	importEd25519PublicKey,
	ecpDefaultGrant,
	publishedKeyJwk,
	signFrame,
	verifyFrame,
	type EcpFramePayload,
	type EcpGrant,
	type EcpPublishedKey,
	type EcpRunRequestBody,
	type EcpCryptoKey,
} from '@kody-internal/shared/execution-context-protocol/index.ts'
import {
	executionContextsPath,
	requestConnectTicket,
	signedFetch,
} from './client.js'

export type ContextRunExecutor = (input: {
	request: EcpRunRequestBody
	fetchFn: typeof fetch
	signal: AbortSignal
	/** Current grant egress (welcome / grant.update); the run enforces it. */
	egress: EcpGrant['egress']
}) => Promise<{
	content?: Array<unknown>
	structuredContent?: Record<string, unknown>
	isError: boolean
}>

/**
 * Fetch for one run: calls to Kody's API carry the context signature and
 * run id instead of a bearer token, so the API checks the requester's
 * access on every hop. Other hosts go out from this machine unchanged.
 */
export function runScopedFetch(input: {
	apiUrl: string
	ecid: string
	runId: string
	privateKey: EcpCryptoKey
	fetchFn?: typeof fetch
}): typeof fetch {
	const apiOrigin = new URL(input.apiUrl).origin
	const base = input.fetchFn ?? fetch
	return async (resource, init) => {
		const request = new Request(resource, init)
		const url = new URL(request.url)
		if (url.origin !== apiOrigin) return base(request)
		const body = new Uint8Array(await request.arrayBuffer())
		const headers: Record<string, string> = {}
		request.headers.forEach((value, name) => {
			if (name !== 'authorization') headers[name] = value
		})
		return signedFetch({
			apiUrl: input.apiUrl,
			ecid: input.ecid,
			privateKey: input.privateKey,
			method: request.method,
			pathAndQuery: `${url.pathname}${url.search}`,
			body,
			runId: input.runId,
			headers,
			fetchFn: base,
		})
	}
}

function originOf(url: string) {
	try {
		return new URL(url).origin
	} catch {
		return null
	}
}

/** Why the daemon refuses a run request, or null when it can accept it. */
export function runRequestRefusal(
	request: Pick<EcpRunRequestBody, 'acceptBy' | 'apiUrl'>,
	apiUrl: string,
	now = Date.now(),
) {
	const origin = originOf(request.apiUrl)
	if (!origin || origin !== originOf(apiUrl)) return 'grant_mismatch' as const
	if (now > request.acceptBy) return 'deadline_passed' as const
	return null
}

type DaemonInput = {
	apiUrl: string
	ecid: string
	privateKey: EcpCryptoKey
	serverKeys: Array<EcpPublishedKey>
	maxConcurrent: number
	client: { name: string; version: string }
	capabilities: Record<string, unknown>
	execute: ContextRunExecutor
	log: (line: string) => void
	fetchFn?: typeof fetch
	WebSocketImpl?: typeof WebSocket
	signal?: AbortSignal
	welcomeTimeoutMs?: number
	closeSettleMs?: number
	pingMs?: number
	pongTimeoutMs?: number
}

export const welcomeTimeoutMs = 15_000
export const welcomeTimeoutCloseCode = 4000
/** How long a client-initiated close may wait for the close event. */
export const closeSettleMs = 5_000
export const defaultPingMs = 30_000
export const defaultPongTimeoutMs = 10_000
/** Kody stopped answering pings: the socket is half-dead. */
export const heartbeatTimeoutCloseCode = 4001
/**
 * A server frame failed verification. Browser-style WebSockets (Node's
 * included) only accept 1000 or 3000-4999 from the client; 1008 throws
 * `InvalidAccessError: invalid code` and leaves the socket open.
 */
export const frameRejectedCloseCode = 4008

function heartbeatSetting(value: unknown, fallback: number) {
	return typeof value === 'number' &&
		Number.isFinite(value) &&
		value >= 1_000 &&
		value <= 300_000
		? value
		: fallback
}

/** One connection: resolves when the socket closes. */
export async function runDaemonConnection(input: DaemonInput) {
	const Socket = input.WebSocketImpl ?? globalThis.WebSocket
	if (!Socket) {
		throw new Error(
			'This Node.js has no global WebSocket. Use Node 22 or newer.',
		)
	}
	const { ticket } = await requestConnectTicket(input)
	if (input.signal?.aborted) return { code: 1000, reason: 'shutdown' }
	const url = new URL(`${executionContextsPath}/connect`, input.apiUrl)
	url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
	url.searchParams.set('ticket', ticket)
	const ws = new Socket(url.toString())
	const serverKeys = new Map(input.serverKeys.map((key) => [key.kid, key]))
	let sid = ''
	let inSeq = 0
	let outSeq = 0
	const runs = new Map<
		string,
		{ request: EcpRunRequestBody; abort: AbortController; committed: boolean }
	>()

	const send = async (
		t: string,
		body: Record<string, unknown>,
		re?: number,
	) => {
		outSeq += 1
		const payload: EcpFramePayload = {
			v: 1,
			t,
			ec: input.ecid,
			sid,
			seq: outSeq,
			ts: Date.now(),
			...(re === undefined ? {} : { re }),
			body,
		}
		ws.send(
			await signFrame({
				privateKey: input.privateKey,
				kid: ecpContextKeyId,
				payload,
			}),
		)
	}
	let grantEgress: EcpGrant['egress'] = ecpDefaultGrant.egress
	const applyGrant = (grant: unknown) => {
		const egress = (grant as { egress?: unknown } | null)?.egress as
			| EcpGrant['egress']
			| undefined
		if (egress && typeof egress.mode === 'string') grantEgress = egress
	}
	let rearmHeartbeat: ((pingMs: number, pongTimeoutMs: number) => void) | null =
		null
	const status = () => ({
		running: runs.size,
		maxConcurrent: input.maxConcurrent,
		acceptingRuns: runs.size < input.maxConcurrent,
	})

	const startRun = async (run: {
		request: EcpRunRequestBody
		abort: AbortController
	}) => {
		const startedAt = Date.now()
		const timer = setTimeout(
			() => run.abort.abort(),
			Math.max(0, run.request.deadline - Date.now()),
		)
		let result: Awaited<ReturnType<ContextRunExecutor>>
		try {
			result = await input.execute({
				request: run.request,
				signal: run.abort.signal,
				egress: grantEgress,
				fetchFn: runScopedFetch({
					apiUrl: input.apiUrl,
					ecid: input.ecid,
					runId: run.request.runId,
					privateKey: input.privateKey,
					...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
				}),
			})
		} catch (error) {
			result = {
				isError: true,
				content: [
					{
						type: 'text',
						text: error instanceof Error ? error.message : String(error),
					},
				],
			}
		} finally {
			clearTimeout(timer)
		}
		const endedAt = Date.now()
		const resultBytes = new TextEncoder().encode(
			JSON.stringify(result),
		).byteLength
		runs.delete(run.request.runId)
		await send('run.result', {
			runId: run.request.runId,
			...result,
			startedAt,
			endedAt,
			resultBytes,
		})
		await send('status', status())
	}

	const handle = async (frame: EcpFramePayload) => {
		const body = frame.body
		const runId = typeof body.runId === 'string' ? body.runId : ''
		switch (frame.t) {
			case 'welcome':
				clearTimeout(welcomeTimer)
				applyGrant(body.grant)
				if (input.pingMs === undefined && input.pongTimeoutMs === undefined) {
					rearmHeartbeat?.(
						heartbeatSetting(body.pingMs, defaultPingMs),
						heartbeatSetting(body.pongTimeoutMs, defaultPongTimeoutMs),
					)
				}
				await send('hello', {
					protocol: { min: ecpProtocolVersion, max: ecpProtocolVersion },
					client: input.client,
					capabilities: input.capabilities,
					grantVersion: body.grantVersion,
					status: status(),
					// Kody ends committed runs this daemon no longer holds right away.
					heldRuns: [...runs.values()]
						.filter((run) => run.committed)
						.map((run) => run.request.runId),
					pendingResults: [],
				})
				input.log('Connected. Waiting for runs.')
				return
			case 'run.request': {
				const request = body as unknown as EcpRunRequestBody
				if (runs.size >= input.maxConcurrent) {
					await send('run.reject', { runId, code: 'busy' }, frame.seq)
					return
				}
				const refusal = runRequestRefusal(request, input.apiUrl)
				if (refusal) {
					await send('run.reject', { runId, code: refusal }, frame.seq)
					return
				}
				runs.set(runId, {
					request,
					abort: new AbortController(),
					committed: false,
				})
				await send('run.accept', { runId }, frame.seq)
				return
			}
			case 'run.commit': {
				const run = runs.get(runId)
				if (!run || run.committed) return
				run.committed = true
				input.log(
					`Running ${runId} for ${run.request.requestedBy.handle ?? run.request.requestedBy.userId}.`,
				)
				void startRun(run)
				return
			}
			case 'run.abort':
			case 'run.cancel': {
				const run = runs.get(runId)
				run?.abort.abort()
				if (!run?.committed) runs.delete(runId)
				if (frame.t === 'run.cancel')
					await send('run.cancel.ack', { runId }, frame.seq)
				return
			}
			case 'grant.update':
				applyGrant(body.grant)
				await send('grant.ack', { grantVersion: body.grantVersion }, frame.seq)
				return
			case 'revoke':
				input.log(
					`This context was revoked (${String(body.reason ?? 'revoked')}).`,
				)
				ws.close(1000, 'revoked')
				return
			case 'error':
				input.log(`Kody: ${String(body.code)} ${String(body.message ?? '')}`)
				return
			default:
				return
		}
	}

	const timeoutMs = input.welcomeTimeoutMs ?? welcomeTimeoutMs
	let welcomeTimer: ReturnType<typeof setTimeout> | undefined
	return await new Promise<{ code: number; reason: string }>((resolve) => {
		let lastInboundAt = Date.now()
		let ping: ReturnType<typeof setInterval> | undefined
		let pongTimer: ReturnType<typeof setTimeout> | undefined
		// Client pings get an auto-response pong. A socket whose TCP path died
		// stays ESTABLISHED and never emits close, so a missing pong is the
		// only signal: close it and let runDaemon reconnect with backoff.
		const armHeartbeat = (pingMs: number, pongTimeoutMs: number) => {
			clearInterval(ping)
			ping = setInterval(() => {
				if (ws.readyState !== ws.OPEN || pongTimer) return
				const sentAt = Date.now()
				ws.send(ecpPingFrame)
				pongTimer = setTimeout(() => {
					pongTimer = undefined
					if (lastInboundAt >= sentAt) return
					input.log(
						`Kody did not answer a ping within ${Math.round(pongTimeoutMs / 1000)}s, so the connection is dead. Closing and reconnecting.`,
					)
					closeAndSettle(heartbeatTimeoutCloseCode, 'heartbeat timeout')
				}, pongTimeoutMs)
			}, pingMs)
		}
		rearmHeartbeat = armHeartbeat
		armHeartbeat(
			input.pingMs ?? defaultPingMs,
			input.pongTimeoutMs ?? defaultPongTimeoutMs,
		)
		let settled = false
		let settleTimer: ReturnType<typeof setTimeout> | undefined
		const finish = (code: number, reason: string) => {
			if (settled) return
			settled = true
			clearInterval(ping)
			clearTimeout(pongTimer)
			clearTimeout(welcomeTimer)
			clearTimeout(settleTimer)
			input.signal?.removeEventListener('abort', shutdown)
			for (const run of runs.values()) run.abort.abort()
			resolve({ code, reason })
		}
		// Some runtimes never emit `close` for a socket closed mid-handshake.
		const closeAndSettle = (code: number, reason: string) => {
			try {
				ws.close(code, reason)
			} catch {
				// Already closing.
			}
			settleTimer ??= setTimeout(
				() => finish(code, reason),
				input.closeSettleMs ?? closeSettleMs,
			)
		}
		welcomeTimer = setTimeout(() => {
			input.log(
				`Kody did not send a welcome frame within ${Math.round(timeoutMs / 1000)}s, so this context cannot come online. Closing and retrying.`,
			)
			closeAndSettle(welcomeTimeoutCloseCode, 'welcome timeout')
		}, timeoutMs)
		const shutdown = () => closeAndSettle(1000, 'shutdown')
		if (input.signal?.aborted) shutdown()
		input.signal?.addEventListener('abort', shutdown, { once: true })
		const rejectFrame = (code: string) => {
			input.log(
				`Kody sent a frame that failed verification (${code}). Closing and reconnecting.`,
			)
			closeAndSettle(frameRejectedCloseCode, code)
		}
		// Frames are verified against the previous sequence number, so they
		// must be handled one at a time in arrival order.
		let inbound = Promise.resolve()
		ws.addEventListener('message', (event) => {
			lastInboundAt = Date.now()
			const text = typeof event.data === 'string' ? event.data : ''
			inbound = inbound
				.then(() => onMessage(text))
				.catch((error) => input.log(`Frame error: ${String(error)}`))
		})
		const onMessage = async (text: string) => {
			if (settled || settleTimer) return
			const classified = classifyFrameText(text)
			if (classified.kind !== 'frame') return
			const key = serverKeys.get(classified.envelope.k)
			if (!key) {
				rejectFrame('unknown_server_key')
				return
			}
			if (!sid) {
				sid = peekSid(classified.envelope.p)
			}
			const verified = await verifyFrame({
				envelope: classified.envelope,
				publicKey: await importEd25519PublicKey(publishedKeyJwk(key)),
				expect: { ec: input.ecid, sid, lastSeq: inSeq },
				now: Date.now(),
			})
			if (!verified.ok) {
				rejectFrame(verified.code)
				return
			}
			inSeq = verified.frame.seq
			await handle(verified.frame)
		}
		ws.addEventListener('close', (event) => finish(event.code, event.reason))
	})
}

function peekSid(p: string) {
	try {
		const decoded = decodeEnvelopePayload(p) as {
			t?: string
			body?: { sid?: unknown }
		} | null
		return decoded?.t === 'welcome' && typeof decoded.body?.sid === 'string'
			? decoded.body.sid
			: ''
	} catch {
		return ''
	}
}

/** Reconnects with capped exponential backoff and jitter until aborted. */
export async function runDaemon(input: DaemonInput) {
	let attempt = 0
	while (!input.signal?.aborted) {
		const startedAt = Date.now()
		try {
			const closed = await runDaemonConnection(input)
			if (closed.reason === 'revoked') return
			input.log(
				`Disconnected (${closed.code}${closed.reason ? ` ${closed.reason}` : ''}). Reconnecting.`,
			)
		} catch (error) {
			if (input.signal?.aborted) return
			input.log(
				`Connect failed: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		if (Date.now() - startedAt > 60_000) attempt = 0
		attempt += 1
		const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6))
		await abortableDelay(delay * (0.5 + Math.random() / 2), input.signal)
	}
}

/** Resolves after `ms`, or as soon as `signal` aborts (SIGINT/SIGTERM). */
export function abortableDelay(ms: number, signal?: AbortSignal) {
	return new Promise<void>((resolve) => {
		if (signal?.aborted) return resolve()
		const done = () => {
			clearTimeout(timer)
			signal?.removeEventListener('abort', done)
			resolve()
		}
		const timer = setTimeout(done, ms)
		signal?.addEventListener('abort', done, { once: true })
	})
}
