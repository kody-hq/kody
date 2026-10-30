import { type EffectiveFs, emptyEffectiveFs, fsFeatures } from './fs-access.js'
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
	type EcpRunTiming,
	type EcpCryptoKey,
} from '@kody-internal/shared/execution-context-protocol/index.ts'
import {
	executionContextsPath,
	requestConnectTicket,
	signedFetch,
	experimentOffError,
	isExperimentOffError,
} from './client.js'

export type ContextRunExecutor = (input: {
	request: EcpRunRequestBody
	fetchFn: typeof fetch
	signal: AbortSignal
	/** Current grant egress (welcome / grant.update); the run enforces it. */
	egress: EcpGrant['egress']
	/** Host folders this run may use right now (server grant ∩ local policy). */
	hostFs?: () => EffectiveFs
}) => Promise<{
	content?: Array<unknown>
	structuredContent?: Record<string, unknown>
	isError: boolean
	timing?: Omit<EcpRunTiming, 'queueMs' | 'daemonMs'>
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
	/** Host-folder access: the server grant.fs intersected with local policy. */
	fs?: DaemonFsAccess
	closeSettleMs?: number
	pingMs?: number
	pongTimeoutMs?: number
}

export type DaemonFsAccess = {
	effective: (
		grantFs: Array<{ path: string; mode: string }>,
	) => Promise<EffectiveFs>
	/** Subscribes to local policy edits; returns an unsubscribe. */
	onChange?: (listener: () => void) => () => void
}

function grantFsOf(grant: unknown) {
	const fs = (grant as { fs?: unknown } | null)?.fs
	if (!Array.isArray(fs)) return []
	return fs.filter(
		(entry): entry is { path: string; mode: string } =>
			typeof entry?.path === 'string' && typeof entry?.mode === 'string',
	)
}

const layerLabel = {
	server_grant: 'server grant',
	local_policy: 'local policy',
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
	let welcomed = false
	let grantFs: Array<{ path: string; mode: string }> = []
	let hostFs: EffectiveFs = emptyEffectiveFs
	const effectiveFsNow = async () => {
		if (!input.fs) return emptyEffectiveFs
		try {
			return await input.fs.effective(grantFs)
		} catch (error) {
			input.log(
				`Host folders are off: ${error instanceof Error ? error.message : String(error)}`,
			)
			return emptyEffectiveFs
		}
	}
	const capabilities = () => {
		const base = Array.isArray(input.capabilities.features)
			? (input.capabilities.features as Array<string>)
			: []
		return {
			...input.capabilities,
			maxConcurrent,
			features: [
				...base.filter((feature) => feature !== 'fs'),
				...fsFeatures(hostFs),
			],
		}
	}
	const applyFs = async () => {
		if (!input.fs) return
		hostFs = await effectiveFsNow()
		for (const mount of hostFs.mounts) {
			input.log(
				`Host folder ${mount.path} is available to runs (${mount.mode}).`,
			)
		}
		for (const refusal of hostFs.refused) {
			input.log(
				`Host folder ${refusal.path} is not available: ${refusal.reason} (${layerLabel[refusal.layer]}).`,
			)
		}
	}
	const refreshFs = async (before = JSON.stringify(capabilities())) => {
		await applyFs()
		const next = capabilities()
		if (welcomed && JSON.stringify(next) !== before) {
			await send('capabilities.update', { capabilities: next })
		}
	}
	const unsubscribeFs = input.fs?.onChange?.(() => {
		if (welcomed) void refreshFs().catch(() => {})
	})
	const serverKeys = new Map(input.serverKeys.map((key) => [key.kid, key]))
	let sid = ''
	let inSeq = 0
	let outSeq = 0
	const runs = new Map<
		string,
		{
			request: EcpRunRequestBody
			abort: AbortController
			committed: boolean
			committedAt?: number
		}
	>()
	// The grant's limit can only lower what this machine offers.
	let maxConcurrent = input.maxConcurrent
	const applyLimits = (grant: unknown) => {
		const limit = (grant as { limits?: { maxConcurrent?: unknown } } | null)
			?.limits?.maxConcurrent
		const previous = maxConcurrent
		maxConcurrent =
			typeof limit === 'number' && limit >= 1
				? Math.min(input.maxConcurrent, Math.floor(limit))
				: input.maxConcurrent
		return maxConcurrent !== previous
	}

	let outbound: Promise<void> = Promise.resolve()
	let outboundFailed = false
	const send = (t: string, body: Record<string, unknown>, re?: number) => {
		// Signing is async; chain it so concurrent runs' frames reach the
		// socket in sequence order (the server rejects an out-of-order seq).
		const sent = outbound.then(async () => {
			if (outboundFailed) throw new Error('This connection already failed.')
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
		})
		// A failed send would leave a sequence gap the server rejects, so it
		// ends this connection; the reconnect starts a fresh sequence.
		outbound = sent.catch(() => {
			if (outboundFailed) return
			outboundFailed = true
			try {
				ws.close(4000, 'send failed')
			} catch {
				// Already closing.
			}
		})
		return sent
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
		maxConcurrent,
		acceptingRuns: runs.size < maxConcurrent,
	})

	const startRun = async (run: {
		request: EcpRunRequestBody
		abort: AbortController
		committedAt?: number
	}) => {
		const startedAt = Date.now()
		const committedAt = run.committedAt ?? startedAt
		let deadlineHit = false
		const timer = setTimeout(
			() => {
				deadlineHit = true
				run.abort.abort()
			},
			Math.max(0, run.request.deadline - Date.now()),
		)
		let result: Awaited<ReturnType<ContextRunExecutor>>
		try {
			if (input.fs) hostFs = await effectiveFsNow()
			result = await input.execute({
				request: run.request,
				// A getter, so a grant.update or policy change narrows runs already in flight.
				...(input.fs ? { hostFs: () => hostFs } : {}),
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
		const { timing: executorTiming, ...outcome } = result
		const resultBytes = new TextEncoder().encode(
			JSON.stringify(outcome),
		).byteLength
		const timing: EcpRunTiming = {
			queueMs: startedAt - committedAt,
			setupMs: executorTiming?.setupMs ?? 0,
			...(executorTiming?.packageGraphMs !== undefined
				? {
						packageGraphMs: executorTiming.packageGraphMs,
						packageGraphCached: executorTiming.packageGraphCached === true,
					}
				: {}),
			executeMs: executorTiming?.executeMs ?? endedAt - startedAt,
			daemonMs: endedAt - committedAt,
		}
		runs.delete(run.request.runId)
		await send('run.result', {
			runId: run.request.runId,
			...outcome,
			// The local deadline stopped it: a cancel, not a code error.
			...(deadlineHit && result.isError ? { cancelReason: 'deadline' } : {}),
			startedAt,
			endedAt,
			resultBytes,
			timing,
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
				applyLimits(body.grant)
				if (input.pingMs === undefined && input.pongTimeoutMs === undefined) {
					rearmHeartbeat?.(
						heartbeatSetting(body.pingMs, defaultPingMs),
						heartbeatSetting(body.pongTimeoutMs, defaultPongTimeoutMs),
					)
				}
				grantFs = grantFsOf(body.grant)
				await applyFs()
				welcomed = true
				await send('hello', {
					protocol: { min: ecpProtocolVersion, max: ecpProtocolVersion },
					client: input.client,
					capabilities: capabilities(),
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
				if (runs.size >= maxConcurrent) {
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
				run.committedAt = Date.now()
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
			case 'grant.update': {
				applyGrant(body.grant)
				grantFs = grantFsOf(body.grant)
				const before = JSON.stringify(capabilities())
				const limitsChanged = applyLimits(body.grant)
				await refreshFs(before)
				await send('grant.ack', { grantVersion: body.grantVersion }, frame.seq)
				if (limitsChanged) await send('status', status())
				return
			}
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
			unsubscribeFs?.()
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
			// Retrying cannot help until the person turns the experiment on.
			if (isExperimentOffError(error)) throw experimentOffError(input.apiUrl)
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
