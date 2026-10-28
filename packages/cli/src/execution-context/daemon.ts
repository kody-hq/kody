import {
	classifyFrameText,
	decodeEnvelopePayload,
	ecpContextKeyId,
	ecpPingFrame,
	ecpProtocolVersion,
	importEd25519PublicKey,
	publishedKeyJwk,
	signFrame,
	verifyFrame,
	type EcpFramePayload,
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
}

export const welcomeTimeoutMs = 15_000
export const welcomeTimeoutCloseCode = 4000
/** How long a client-initiated close may wait for the close event. */
export const closeSettleMs = 5_000

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
				await send('hello', {
					protocol: { min: ecpProtocolVersion, max: ecpProtocolVersion },
					client: input.client,
					capabilities: input.capabilities,
					grantVersion: body.grantVersion,
					status: status(),
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
				if (Date.now() > request.acceptBy || request.apiUrl !== input.apiUrl) {
					await send(
						'run.reject',
						{
							runId,
							code:
								request.apiUrl !== input.apiUrl
									? 'grant_mismatch'
									: 'deadline_passed',
						},
						frame.seq,
					)
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
		const ping = setInterval(() => {
			if (ws.readyState === ws.OPEN) ws.send(ecpPingFrame)
		}, 30_000)
		let settled = false
		let settleTimer: ReturnType<typeof setTimeout> | undefined
		const finish = (code: number, reason: string) => {
			if (settled) return
			settled = true
			clearInterval(ping)
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
		ws.addEventListener('message', (event) => {
			const text = typeof event.data === 'string' ? event.data : ''
			void (async () => {
				const classified = classifyFrameText(text)
				if (classified.kind !== 'frame') return
				const key = serverKeys.get(classified.envelope.k)
				if (!key) {
					ws.close(1008, 'unknown server key')
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
					ws.close(1008, verified.code)
					return
				}
				inSeq = verified.frame.seq
				await handle(verified.frame)
			})().catch((error) => input.log(`Frame error: ${String(error)}`))
		})
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
