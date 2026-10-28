import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import {
	classifyFrameText,
	ecpCommitGraceMs,
	ecpContextKeyId,
	ecpFramesPerSecond,
	ecpHttpNonceWindowMs,
	ecpHttpSignaturePrefix,
	ecpLivenessFreshMs,
	ecpLostAfterDeadlineMs,
	ecpMaxConcurrentRunsCap,
	ecpMaxRunLogLines,
	ecpPingFrame,
	ecpPongFrame,
	ecpProtocolVersion,
	importEd25519PrivateKey,
	importEd25519PublicKey,
	negotiateProtocol,
	parseFrameSigningKeys,
	selectFrameSigningKey,
	signFrame,
	unknownFrameTypeDisposition,
	verifyDetached,
	verifyFrame,
	type EcpCancelReason,
	type EcpFramePayload,
	type EcpGrant,
	type EcpHttpSignature,
	type EcpRunRequestBody,
	type Ed25519PublicJwk,
} from '@kody-internal/shared/execution-context-protocol/index.ts'
import { finishRunRecord } from '#worker/run-records/service.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import { type RunRecordHandle } from '#worker/run-records/types.ts'

export const executionContextsUnavailableCode = 'execution_contexts_unavailable'

const ticketLifetimeMs = 30_000
const historyRetentionMs = 30 * 24 * 60 * 60 * 1000
const historyMaxRows = 1_000
const maxRunResultBytes = 1024 * 1024

/** What origin hands the session about the registered context. */
export type ExecutionContextSnapshot = {
	ecid: string
	name: string
	orgId: string
	operatorUserId: string
	publicKeyJwk: Ed25519PublicJwk
	grant: EcpGrant
	grantVersion: number
}

export type ExecutionContextLease = {
	runId: string
	ecid: string
	requester: { userId: string; handle: string | null }
	orgId: string
	/** The requester's caller credential scopes (null does not narrow). */
	callerScopes: Array<string> | null
	credentialIds: Array<string>
	runtime: EcpGrant['runtime']
	deadline: number
	sharedRun: boolean
}

export type DispatchOutcome =
	| 'committed'
	| 'offline'
	| 'busy'
	| 'rejected'
	| 'aborted'
	| 'timeout'

export type ExecutionContextRunResult = {
	isError: boolean
	content: Array<unknown>
	structuredContent: Record<string, unknown>
}

export type RunHistoryOutcome =
	| 'succeeded'
	| 'failed'
	| 'cancelled'
	| 'lost'
	| 'rejected'
	| 'aborted'
	| 'offline'
	| 'busy'
	| 'timeout'

export type ExecutionContextAuditInput = {
	event: string
	actor?: { userId: string; handle: string | null } | null
	orgId?: string | null
	detail?: Record<string, unknown>
}

export type ExecutionContextAuditRow = {
	id: number
	at: string
	event: string
	actor: { userId: string; handle: string | null } | null
	orgId: string | null
	/** JSON text; kept as a string so the row stays RPC-serializable. */
	detailJson: string | null
}

export type RunHistoryRow = {
	runId: string
	requester: { userId: string; handle: string | null }
	runOrgId: string
	dispatchedAt: string
	startedAt: string | null
	endedAt: string | null
	durationMs: number | null
	outcome: RunHistoryOutcome | null
	cancelReason: string | null
	fallback: { position: number; ranOn?: string }
}

type SocketAttachment = {
	sid: string
	inSeq: number
	outSeq: number
	connectedAt: number
	accepting: boolean
	running: number
	maxConcurrent: number
	helloed: boolean
	welcomed?: boolean
}

type RunRow = {
	run_id: string
	state: string
	lease_json: string
	deadline: number
	accept_by: number
	run_record_json: string | null
	result_json: string | null
	cancel_reason: string | null
	started_at: number | null
}

type Waiter<T> = { resolve: (value: T) => void }

function randomId(prefix: string) {
	const bytes = new Uint8Array(16)
	crypto.getRandomValues(bytes)
	return `${prefix}${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

async function sha256Hex(text: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(text),
	)
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, '0'),
	).join('')
}

function terminalOutcome(state: string): RunHistoryOutcome | null {
	switch (state) {
		case 'succeeded':
		case 'failed':
		case 'cancelled':
		case 'lost':
		case 'rejected':
		case 'aborted':
			return state
		default:
			return null
	}
}

/**
 * Platform-owned session for one execution context (`idFromName(ecid)`).
 * Holds the hibernating WebSocket, verifies every signed frame, runs the
 * two-phase dispatch state machine in SQLite (so a reset mid-run still
 * answers `runGet` with the persisted result or `execution_context_lost`),
 * authorizes each CapabilityProxy hop against the run's lease, and keeps a
 * bounded per-context run history (30 days, 1,000 rows, metadata only).
 */
export class ExecutionContextSessionV1Base extends DurableObject<Env> {
	#acceptWaiters = new Map<
		string,
		Waiter<{ accepted: boolean; code?: string }>
	>()
	#resultWaiters = new Map<string, Array<Waiter<boolean>>>()
	#frameBudget = new Map<string, { windowStart: number; count: number }>()
	#signer: Promise<{ kid: string; key: CryptoKey } | null> | null = null
	#contextKey: Promise<CryptoKey> | null = null

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		ctx.blockConcurrencyWhile(async () => {
			this.#migrate()
		})
		ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair(ecpPingFrame, ecpPongFrame),
		)
	}

	#migrate() {
		const sql = this.ctx.storage.sql
		sql.exec(
			`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
		)
		sql.exec(
			`CREATE TABLE IF NOT EXISTS tickets (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`,
		)
		sql.exec(
			`CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`,
		)
		sql.exec(`CREATE TABLE IF NOT EXISTS runs (
			run_id TEXT PRIMARY KEY,
			state TEXT NOT NULL,
			lease_json TEXT NOT NULL,
			deadline INTEGER NOT NULL,
			accept_by INTEGER NOT NULL,
			run_record_json TEXT,
			result_json TEXT,
			cancel_reason TEXT,
			started_at INTEGER,
			ended_at INTEGER,
			created_at INTEGER NOT NULL
		)`)
		sql.exec(`CREATE TABLE IF NOT EXISTS history (
			run_id TEXT NOT NULL,
			attempt INTEGER NOT NULL,
			requester_user_id TEXT NOT NULL,
			requester_handle TEXT,
			run_org_id TEXT NOT NULL,
			dispatched_at INTEGER NOT NULL,
			started_at INTEGER,
			ended_at INTEGER,
			outcome TEXT,
			cancel_reason TEXT,
			position INTEGER NOT NULL,
			ran_on TEXT,
			PRIMARY KEY (run_id, attempt)
		)`)
		sql.exec(
			`CREATE INDEX IF NOT EXISTS history_dispatched ON history (dispatched_at)`,
		)
		sql.exec(`CREATE TABLE IF NOT EXISTS audit (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			at INTEGER NOT NULL,
			event TEXT NOT NULL,
			actor_user_id TEXT,
			actor_handle TEXT,
			org_id TEXT,
			detail_json TEXT
		)`)
	}

	// ---------- snapshot and keys ----------

	#snapshot(): ExecutionContextSnapshot | null {
		const row = this.ctx.storage.sql
			.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'snapshot'`)
			.toArray()[0]
		return row ? (JSON.parse(row.value) as ExecutionContextSnapshot) : null
	}

	#saveSnapshot(snapshot: ExecutionContextSnapshot) {
		this.ctx.storage.sql.exec(
			`INSERT INTO meta (key, value) VALUES ('snapshot', ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			JSON.stringify(snapshot),
		)
		this.#contextKey = null
	}

	#revokedReason(): string | null {
		const row = this.ctx.storage.sql
			.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'revoked'`)
			.toArray()[0]
		return row?.value ?? null
	}

	async #contextPublicKey() {
		const snapshot = this.#snapshot()
		if (!snapshot) throw new Error('Execution context is not registered here.')
		this.#contextKey ??= importEd25519PublicKey(snapshot.publicKeyJwk)
		return await this.#contextKey
	}

	async #frameSigner() {
		this.#signer ??= (async () => {
			const raw = this.env.ECP_FRAME_SIGNING_KEYS
			if (!raw) return null
			const key = selectFrameSigningKey(parseFrameSigningKeys(raw), Date.now())
			if (!key) return null
			return {
				kid: key.kid,
				key: await importEd25519PrivateKey(key.privateKeyJwk),
			}
		})().catch((error: unknown) => {
			// Retry on the next frame so a fixed secret heals without a restart.
			this.#signer = null
			throw error
		})
		return await this.#signer
	}

	// ---------- connect ----------

	/**
	 * Origin has verified the signed connect-ticket request against the
	 * registered key. Consume its nonce here (unique per context for 120 s),
	 * refresh the snapshot, and mint a single-use 30 s ticket.
	 */
	async issueConnectTicket(input: {
		snapshot: ExecutionContextSnapshot
		nonce: string
	}): Promise<
		| { ok: true; ticket: string; expiresAt: number }
		| { ok: false; code: 'replay' | 'revoked' | 'rate_limited' }
	> {
		if (this.#revokedReason()) return { ok: false, code: 'revoked' }
		const now = Date.now()
		if (!this.#consumeNonce(input.nonce, now)) {
			return { ok: false, code: 'replay' }
		}
		const recent = this.ctx.storage.sql
			.exec<{ n: number }>(
				`SELECT COUNT(*) AS n FROM tickets WHERE expires_at > ?`,
				now + ticketLifetimeMs - 60_000,
			)
			.one().n
		if (recent >= 10) return { ok: false, code: 'rate_limited' }
		this.#saveSnapshot(input.snapshot)
		const ticket = `${input.snapshot.ecid}.${randomId('')}`
		const expiresAt = now + ticketLifetimeMs
		this.ctx.storage.sql.exec(
			`INSERT INTO tickets (hash, expires_at) VALUES (?, ?)`,
			await sha256Hex(ticket),
			expiresAt,
		)
		await this.#ensureAlarm(now + 60_000)
		return { ok: true, ticket, expiresAt }
	}

	#consumeNonce(nonce: string, now: number) {
		this.ctx.storage.sql.exec(`DELETE FROM nonces WHERE expires_at <= ?`, now)
		const existing = this.ctx.storage.sql
			.exec(`SELECT nonce FROM nonces WHERE nonce = ?`, nonce)
			.toArray()
		if (existing.length) return false
		this.ctx.storage.sql.exec(
			`INSERT INTO nonces (nonce, expires_at) VALUES (?, ?)`,
			nonce,
			now + ecpHttpNonceWindowMs,
		)
		return true
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return Response.json(
				{
					ok: false,
					error: {
						code: executionContextsUnavailableCode,
						message: 'Connect with a WebSocket upgrade.',
					},
				},
				{ status: 426 },
			)
		}
		const ticket = url.searchParams.get('ticket') ?? ''
		const now = Date.now()
		const hash = await sha256Hex(ticket)
		const consumed = this.ctx.storage.sql
			.exec(
				`DELETE FROM tickets WHERE hash = ? AND expires_at > ? RETURNING hash`,
				hash,
				now,
			)
			.toArray()
		const snapshot = this.#snapshot()
		if (!consumed.length || !snapshot || this.#revokedReason()) {
			return Response.json(
				{
					ok: false,
					error: {
						code: 'unauthorized',
						message: 'The connect ticket is invalid or expired.',
					},
				},
				{ status: 401 },
			)
		}
		const pair = new WebSocketPair()
		const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
		for (const existing of this.ctx.getWebSockets()) {
			existing.close(1012, 'replaced')
		}
		this.ctx.acceptWebSocket(server)
		const attachment: SocketAttachment = {
			sid: randomId('ses_'),
			inSeq: 0,
			outSeq: 0,
			connectedAt: now,
			accepting: false,
			running: 0,
			maxConcurrent: 1,
			helloed: false,
		}
		server.serializeAttachment(attachment)
		this.ctx.waitUntil(this.#onConnected(server, snapshot))
		return new Response(null, { status: 101, webSocket: client })
	}

	async #onConnected(ws: WebSocket, snapshot: ExecutionContextSnapshot) {
		const sent = await this.#send(ws, 'welcome', {
			sid: (ws.deserializeAttachment() as SocketAttachment).sid,
			protocol: ecpProtocolVersion,
			serverTime: Date.now(),
			pingMs: 30_000,
			pongTimeoutMs: 10_000,
			grant: snapshot.grant,
			grantVersion: snapshot.grantVersion,
			limits: { maxFrameBytes: 6 * 1024 * 1024, maxConcurrentRuns: 4 },
		})
		if (!sent) return
		try {
			const attachment = ws.deserializeAttachment() as SocketAttachment
			attachment.welcomed = true
			ws.serializeAttachment(attachment)
		} catch {
			// Closed before the welcome landed; webSocketClose skips last-seen.
		}
		await this.#touchLastSeen(snapshot.ecid)
	}

	async #touchLastSeen(ecid: string) {
		try {
			await this.env.APP_DB.prepare(
				`UPDATE execution_contexts SET last_seen_at = ? WHERE id = ?`,
			)
				.bind(new Date().toISOString(), ecid)
				.run()
		} catch {
			// Best effort: liveness lives in this session, last_seen_at is display only.
		}
	}

	#socket(): WebSocket | null {
		return this.ctx.getWebSockets()[0] ?? null
	}

	async #send(
		ws: WebSocket,
		type: string,
		body: Record<string, unknown>,
		re?: number,
	) {
		let signer: { kid: string; key: CryptoKey } | null
		try {
			signer = await this.#frameSigner()
		} catch (error) {
			return this.#failSend(ws, type, 'server keys invalid', error)
		}
		const snapshot = this.#snapshot()
		if (!signer || !snapshot) {
			return this.#failSend(
				ws,
				type,
				'server keys unavailable',
				new Error(
					signer
						? 'Execution context session has no snapshot.'
						: 'ECP_FRAME_SIGNING_KEYS is unset or has no unexpired key.',
				),
			)
		}
		const attachment = ws.deserializeAttachment() as SocketAttachment
		attachment.outSeq += 1
		ws.serializeAttachment(attachment)
		const payload: EcpFramePayload = {
			v: 1,
			t: type,
			ec: snapshot.ecid,
			sid: attachment.sid,
			seq: attachment.outSeq,
			ts: Date.now(),
			...(re === undefined ? {} : { re }),
			body,
		}
		try {
			ws.send(
				await signFrame({ privateKey: signer.key, kid: signer.kid, payload }),
			)
			return true
		} catch (error) {
			return this.#failSend(ws, type, 'frame send failed', error)
		}
	}

	/** A frame the server cannot send ends the session loudly: log, Sentry, 1011. */
	#failSend(ws: WebSocket, type: string, reason: string, error: unknown) {
		const ecid = this.#snapshot()?.ecid ?? null
		console.error('execution_context_frame_send_failed', {
			ecid,
			frameType: type,
			reason,
			error: error instanceof Error ? error.message : String(error),
		})
		Sentry.withScope((scope) => {
			scope.setTag('execution_context.operation', 'frame_send')
			scope.setTag('execution_context.frame_type', type)
			scope.setContext('execution_context', { ecid, frameType: type, reason })
			Sentry.captureException(error)
		})
		try {
			ws.close(1011, reason)
		} catch {
			// Already closed: the failure above is what matters.
		}
		return false
	}

	async #sendError(ws: WebSocket, code: string, message: string, close = true) {
		const sent = await this.#send(ws, 'error', {
			code,
			message,
			retryable: !close,
		})
		if (close && sent) ws.close(1008, code)
	}

	override async webSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
	) {
		if (typeof message !== 'string') {
			ws.close(1003, 'binary frames are not accepted')
			return
		}
		const attachment = ws.deserializeAttachment() as SocketAttachment
		if (!this.#withinFrameBudget(attachment.sid)) {
			await this.#sendError(ws, 'rate_limited', 'Too many frames.', false)
			return
		}
		const classified = classifyFrameText(message)
		if (classified.kind === 'ping') return
		if (classified.kind === 'invalid') {
			await this.#sendError(ws, classified.code, 'Frame rejected.')
			return
		}
		const snapshot = this.#snapshot()
		if (!snapshot) {
			ws.close(1011, 'not registered')
			return
		}
		const verified = await verifyFrame({
			envelope: classified.envelope,
			publicKey: await this.#contextPublicKey(),
			expect: {
				ec: snapshot.ecid,
				sid: attachment.sid,
				lastSeq: attachment.inSeq,
				kid: ecpContextKeyId,
			},
			now: Date.now(),
		})
		if (!verified.ok) {
			await this.#sendError(ws, verified.code, 'Frame rejected.')
			return
		}
		const current = ws.deserializeAttachment() as SocketAttachment
		current.inSeq = verified.frame.seq
		ws.serializeAttachment(current)
		await this.#handleFrame(ws, verified.frame)
	}

	#withinFrameBudget(sid: string) {
		const now = Date.now()
		const entry = this.#frameBudget.get(sid)
		if (!entry || now - entry.windowStart >= 1000) {
			this.#frameBudget.set(sid, { windowStart: now, count: 1 })
			return true
		}
		entry.count += 1
		return entry.count <= ecpFramesPerSecond
	}

	#updateStatus(ws: WebSocket, status: unknown) {
		if (!status || typeof status !== 'object') return
		const s = status as Record<string, unknown>
		const attachment = ws.deserializeAttachment() as SocketAttachment
		if (typeof s.acceptingRuns === 'boolean')
			attachment.accepting = s.acceptingRuns
		if (typeof s.running === 'number') attachment.running = s.running
		if (typeof s.maxConcurrent === 'number') {
			attachment.maxConcurrent = Math.max(
				0,
				Math.min(ecpMaxConcurrentRunsCap, Math.floor(s.maxConcurrent)),
			)
		}
		ws.serializeAttachment(attachment)
	}

	async #handleFrame(ws: WebSocket, frame: EcpFramePayload) {
		const body = frame.body
		const runId = typeof body.runId === 'string' ? body.runId : ''
		switch (frame.t) {
			case 'hello': {
				const protocol = negotiateProtocol(body.protocol)
				if (protocol === null) {
					await this.#send(ws, 'error', {
						code: 'protocol_unsupported',
						message: 'No common protocol version.',
						supported: [ecpProtocolVersion],
						retryable: false,
					})
					ws.close(1008, 'protocol_unsupported')
					return
				}
				const attachment = ws.deserializeAttachment() as SocketAttachment
				attachment.helloed = true
				ws.serializeAttachment(attachment)
				this.#updateStatus(ws, body.status)
				await this.#recordCapabilities(body)
				return
			}
			case 'status':
				this.#updateStatus(ws, body)
				return
			case 'capabilities.update':
				await this.#recordCapabilities(body)
				return
			case 'run.accept':
			case 'run.reject': {
				const waiter = this.#acceptWaiters.get(runId)
				if (waiter) {
					this.#acceptWaiters.delete(runId)
					waiter.resolve({
						accepted: frame.t === 'run.accept',
						...(typeof body.code === 'string' ? { code: body.code } : {}),
					})
					return
				}
				// A late accept (after acceptBy) gets run.abort; the context never
				// starts without run.commit, so nothing runs twice.
				if (frame.t === 'run.accept') {
					await this.#send(ws, 'run.abort', { runId }, frame.seq)
				}
				return
			}
			case 'run.log':
				return
			case 'run.result':
				await this.#onRunResult(ws, frame)
				return
			case 'run.cancel.ack':
			case 'grant.ack':
			case 'error':
				return
			default:
				if (unknownFrameTypeDisposition(frame.t) === 'unknown_type') {
					await this.#send(
						ws,
						'error',
						{
							code: 'unknown_type',
							message: `Unknown frame ${frame.t}.`,
							retryable: true,
						},
						frame.seq,
					)
				}
		}
	}

	async #recordCapabilities(body: Record<string, unknown>) {
		const capabilities =
			body.capabilities && typeof body.capabilities === 'object'
				? body.capabilities
				: null
		const client =
			body.client && typeof body.client === 'object'
				? (body.client as Record<string, unknown>)
				: null
		const snapshot = this.#snapshot()
		if (!snapshot || (!capabilities && !client)) return
		try {
			await this.env.APP_DB.prepare(
				`UPDATE execution_contexts
				 SET capabilities_json = COALESCE(?, capabilities_json),
				     client_name = COALESCE(?, client_name),
				     client_version = COALESCE(?, client_version)
				 WHERE id = ?`,
			)
				.bind(
					capabilities ? JSON.stringify(capabilities).slice(0, 8192) : null,
					typeof client?.name === 'string' ? client.name.slice(0, 100) : null,
					typeof client?.version === 'string'
						? client.version.slice(0, 50)
						: null,
					snapshot.ecid,
				)
				.run()
		} catch {
			// Best effort: capabilities are display metadata.
		}
	}

	override async webSocketClose(ws: WebSocket) {
		const snapshot = this.#snapshot()
		const welcomed = (ws.deserializeAttachment() as SocketAttachment | null)
			?.welcomed
		if (snapshot && welcomed) await this.#touchLastSeen(snapshot.ecid)
		try {
			ws.close(1000, 'closed')
		} catch {
			// already closed
		}
	}

	override async webSocketError(ws: WebSocket) {
		await this.webSocketClose(ws)
	}

	// ---------- status and dispatch ----------

	#liveSocket(): { ws: WebSocket; attachment: SocketAttachment } | null {
		const ws = this.#socket()
		if (!ws) return null
		const attachment = ws.deserializeAttachment() as SocketAttachment
		if (!attachment.helloed) return null
		const lastProbe = this.ctx.getWebSocketAutoResponseTimestamp(ws)
		const freshAt = lastProbe ? lastProbe.getTime() : attachment.connectedAt
		if (Date.now() - freshAt > ecpLivenessFreshMs) return null
		return { ws, attachment }
	}

	#committedCount() {
		return this.ctx.storage.sql
			.exec<{ n: number }>(
				`SELECT COUNT(*) AS n FROM runs WHERE state = 'committed'`,
			)
			.one().n
	}

	async getStatus(): Promise<{
		online: boolean
		acceptingRuns: boolean
		revoked: boolean
	}> {
		const live = this.#liveSocket()
		return {
			online: Boolean(live),
			acceptingRuns: Boolean(
				live &&
				live.attachment.accepting &&
				this.#committedCount() < live.attachment.maxConcurrent,
			),
			revoked: Boolean(this.#revokedReason()),
		}
	}

	#recordHistory(input: {
		lease: ExecutionContextLease
		attempt: number
		position: number
		outcome: RunHistoryOutcome | null
		dispatchedAt: number
	}) {
		this.ctx.storage.sql.exec(
			`INSERT OR REPLACE INTO history
			 (run_id, attempt, requester_user_id, requester_handle, run_org_id,
			  dispatched_at, outcome, position)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			input.lease.runId,
			input.attempt,
			input.lease.requester.userId,
			input.lease.requester.handle,
			input.lease.orgId,
			input.dispatchedAt,
			input.outcome,
			input.position,
		)
	}

	/**
	 * Dispatch is the liveness and load probe: offline or busy answer at once;
	 * otherwise send `run.request`, wait for accept until `acceptBy`, then
	 * commit. Every attempt writes one history row.
	 */
	async dispatch(input: {
		request: EcpRunRequestBody
		lease: ExecutionContextLease
		runRecord: RunRecordHandle | null
		position: number
	}): Promise<{ outcome: DispatchOutcome; code?: string }> {
		const now = Date.now()
		const { lease } = input
		const attempt =
			this.ctx.storage.sql
				.exec<{ n: number }>(
					`SELECT COUNT(*) AS n FROM history WHERE run_id = ?`,
					lease.runId,
				)
				.one().n + 1
		const record = (outcome: RunHistoryOutcome | null) =>
			this.#recordHistory({
				lease,
				attempt,
				position: input.position,
				outcome,
				dispatchedAt: now,
			})
		if (this.#revokedReason()) {
			record('offline')
			return { outcome: 'offline', code: 'revoked' }
		}
		const live = this.#liveSocket()
		if (!live) {
			record('offline')
			return { outcome: 'offline' }
		}
		if (
			!live.attachment.accepting ||
			this.#committedCount() >= live.attachment.maxConcurrent
		) {
			record('busy')
			return { outcome: 'busy' }
		}
		this.ctx.storage.sql.exec(
			`INSERT INTO runs (run_id, state, lease_json, deadline, accept_by,
			   run_record_json, created_at)
			 VALUES (?, 'dispatched', ?, ?, ?, ?, ?)
			 ON CONFLICT(run_id) DO NOTHING`,
			lease.runId,
			JSON.stringify(lease),
			input.request.deadline,
			input.request.acceptBy,
			input.runRecord ? JSON.stringify(input.runRecord) : null,
			now,
		)
		const accepted = new Promise<{ accepted: boolean; code?: string }>(
			(resolve) => {
				this.#acceptWaiters.set(lease.runId, { resolve })
				setTimeout(
					() => {
						if (this.#acceptWaiters.get(lease.runId)) {
							this.#acceptWaiters.delete(lease.runId)
							resolve({ accepted: false, code: 'timeout' })
						}
					},
					Math.max(0, input.request.acceptBy - now),
				)
			},
		)
		const sent = await this.#send(live.ws, 'run.request', {
			...input.request,
		})
		if (!sent) {
			this.#acceptWaiters.delete(lease.runId)
			this.#setRunState(lease.runId, 'aborted')
			record('offline')
			return { outcome: 'offline' }
		}
		const answer = await accepted
		if (!answer.accepted) {
			const timedOut = answer.code === 'timeout'
			this.#setRunState(lease.runId, timedOut ? 'aborted' : 'rejected')
			record(timedOut ? 'timeout' : 'rejected')
			if (timedOut) {
				await this.#send(live.ws, 'run.abort', { runId: lease.runId })
			}
			return {
				outcome: timedOut ? 'timeout' : 'rejected',
				...(answer.code ? { code: answer.code } : {}),
			}
		}
		if (Date.now() > input.request.acceptBy) {
			this.#setRunState(lease.runId, 'aborted')
			record('aborted')
			await this.#send(live.ws, 'run.abort', { runId: lease.runId })
			return { outcome: 'aborted' }
		}
		this.ctx.storage.sql.exec(
			`UPDATE runs SET state = 'committed', started_at = ? WHERE run_id = ? AND state = 'dispatched'`,
			Date.now(),
			lease.runId,
		)
		record(null)
		this.ctx.storage.sql.exec(
			`UPDATE history SET started_at = ? WHERE run_id = ? AND attempt = ?`,
			Date.now(),
			lease.runId,
			attempt,
		)
		await this.#send(live.ws, 'run.commit', { runId: lease.runId })
		await this.#ensureAlarm(input.request.deadline + ecpLostAfterDeadlineMs)
		return { outcome: 'committed' }
	}

	#setRunState(runId: string, state: string) {
		this.ctx.storage.sql.exec(
			`UPDATE runs SET state = ?, ended_at = ? WHERE run_id = ?`,
			state,
			Date.now(),
			runId,
		)
	}

	#run(runId: string): RunRow | null {
		return (
			this.ctx.storage.sql
				.exec<RunRow>(
					`SELECT run_id, state, lease_json, deadline, accept_by, run_record_json,
					   result_json, cancel_reason, started_at
					 FROM runs WHERE run_id = ?`,
					runId,
				)
				.toArray()[0] ?? null
		)
	}

	/** First terminal state wins; every later one is recorded, not returned. */
	#finishRun(
		runId: string,
		state: 'succeeded' | 'failed' | 'cancelled' | 'lost',
		extra: { resultJson?: string; cancelReason?: string } = {},
	) {
		const now = Date.now()
		const changed = this.ctx.storage.sql
			.exec(
				`UPDATE runs SET state = ?, ended_at = ?,
				   result_json = COALESCE(?, result_json),
				   cancel_reason = COALESCE(?, cancel_reason)
				 WHERE run_id = ? AND state = 'committed' RETURNING run_id`,
				state,
				now,
				extra.resultJson ?? null,
				extra.cancelReason ?? null,
				runId,
			)
			.toArray().length
		if (!changed) return false
		this.ctx.storage.sql.exec(
			`UPDATE history SET outcome = ?, ended_at = ?, cancel_reason = ?,
			   ran_on = 'here'
			 WHERE run_id = ? AND started_at IS NOT NULL AND outcome IS NULL`,
			state,
			now,
			extra.cancelReason ?? null,
			runId,
		)
		for (const waiter of this.#resultWaiters.get(runId) ?? []) {
			waiter.resolve(true)
		}
		this.#resultWaiters.delete(runId)
		return true
	}

	async #onRunResult(ws: WebSocket, frame: EcpFramePayload) {
		const body = frame.body
		const runId = typeof body.runId === 'string' ? body.runId : ''
		const run = this.#run(runId)
		await this.#send(ws, 'run.result.ack', { runId }, frame.seq)
		if (!run || run.state !== 'committed') return
		const lease = JSON.parse(run.lease_json) as ExecutionContextLease
		const result: ExecutionContextRunResult = {
			isError: body.isError === true,
			content: Array.isArray(body.content) ? body.content : [],
			structuredContent:
				body.structuredContent && typeof body.structuredContent === 'object'
					? (body.structuredContent as Record<string, unknown>)
					: {},
		}
		let resultJson = JSON.stringify(result)
		const resultBytes = new TextEncoder().encode(resultJson).byteLength
		const limit = Math.min(
			maxRunResultBytes,
			lease.runtime ? maxRunResultBytes : maxRunResultBytes,
		)
		if (resultBytes > limit) {
			resultJson = JSON.stringify({
				isError: true,
				content: [{ type: 'text', text: 'Error: payload_too_large' }],
				structuredContent: {
					error: `The run's result was ${resultBytes} bytes; the maximum is ${limit} bytes (payload_too_large).`,
					errorCode: 'payload_too_large',
				},
			} satisfies ExecutionContextRunResult)
		}
		const finalResult = JSON.parse(resultJson) as ExecutionContextRunResult
		const finished = this.#finishRun(
			runId,
			finalResult.isError ? 'failed' : 'succeeded',
			{ resultJson },
		)
		if (finished) await this.#finishRunRecord(run, finalResult)
	}

	async #finishRunRecord(
		run: RunRow,
		result: ExecutionContextRunResult | { lost: true } | { cancelled: string },
	) {
		if (!run.run_record_json) return
		const handle = JSON.parse(run.run_record_json) as RunRecordHandle
		if ('lost' in result) {
			await finishRunRecord({
				env: this.env,
				handle,
				status: 'error',
				error: Object.assign(
					new Error(
						'The execution context disconnected after the run started and did not report a result (execution_context_lost).',
					),
					{ name: 'ExecutionContextLost' },
				),
			})
			return
		}
		if ('cancelled' in result) {
			await finishRunRecord({
				env: this.env,
				handle,
				status: 'error',
				error: Object.assign(
					new Error(`The run was cancelled (${result.cancelled}).`),
					{ name: 'ExecutionContextRunCancelled' },
				),
			})
			return
		}
		const structured = result.structuredContent
		await finishRunRecord({
			env: this.env,
			handle,
			status: result.isError ? 'error' : 'success',
			...(result.isError
				? { error: new Error(String(structured.error ?? 'Run failed.')) }
				: { result: structured.result }),
		})
	}

	/** Wait up to `waitMs` for a committed run's terminal state. */
	async awaitResult(input: {
		runId: string
		waitMs: number
	}): Promise<
		| { state: 'pending' }
		| { state: 'succeeded' | 'failed'; result: ExecutionContextRunResult }
		| { state: 'cancelled'; reason: string | null }
		| { state: 'lost' }
		| { state: 'unknown' }
	> {
		const read = () => {
			const run = this.#run(input.runId)
			if (!run) return { state: 'unknown' as const }
			switch (run.state) {
				case 'succeeded':
				case 'failed':
					return {
						state: run.state,
						result: JSON.parse(
							run.result_json ?? '{}',
						) as ExecutionContextRunResult,
					}
				case 'cancelled':
					return { state: 'cancelled' as const, reason: run.cancel_reason }
				case 'lost':
					return { state: 'lost' as const }
				default:
					return null
			}
		}
		const first = read()
		if (first) return first
		const done = await new Promise<boolean>((resolve) => {
			const waiters = this.#resultWaiters.get(input.runId) ?? []
			waiters.push({ resolve })
			this.#resultWaiters.set(input.runId, waiters)
			setTimeout(() => resolve(false), Math.max(0, input.waitMs))
		})
		void done
		return read() ?? { state: 'pending' }
	}

	/** End the lease now, so the next hop fails even if the kill is slow. */
	async cancel(input: { runId: string; reason: EcpCancelReason }) {
		const run = this.#run(input.runId)
		if (!run) return { cancelled: false }
		const ended = this.#finishRun(input.runId, 'cancelled', {
			cancelReason: input.reason,
		})
		const ws = this.#socket()
		if (ws) await this.#send(ws, 'run.cancel', input)
		if (ended) await this.#finishRunRecord(run, { cancelled: input.reason })
		return { cancelled: ended }
	}

	/**
	 * End every committed lease whose requester is in `userIds` (or every
	 * lease bound to `orgId`, or all of them when neither is given).
	 */
	async endLeases(input: {
		userIds?: Array<string>
		orgId?: string
		reason: EcpCancelReason
	}) {
		const rows = this.ctx.storage.sql
			.exec<{ run_id: string; lease_json: string }>(
				`SELECT run_id, lease_json FROM runs WHERE state IN ('committed', 'dispatched')`,
			)
			.toArray()
		let ended = 0
		for (const row of rows) {
			const lease = JSON.parse(row.lease_json) as ExecutionContextLease
			if (input.userIds && !input.userIds.includes(lease.requester.userId)) {
				continue
			}
			if (input.orgId && lease.orgId !== input.orgId) continue
			const result = await this.cancel({
				runId: row.run_id,
				reason: input.reason,
			})
			if (result.cancelled) ended += 1
			else this.#setRunState(row.run_id, 'aborted')
		}
		return { ended }
	}

	async revoke(input: { reason: string }) {
		this.ctx.storage.sql.exec(
			`INSERT INTO meta (key, value) VALUES ('revoked', ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			input.reason,
		)
		await this.endLeases({ reason: 'revoked' })
		for (const ws of this.ctx.getWebSockets()) {
			await this.#send(ws, 'revoke', { reason: input.reason })
			ws.close(1008, 'revoked')
		}
		return { ok: true }
	}

	async updateGrant(input: {
		snapshot: ExecutionContextSnapshot
		/** Runs whose requesters are no longer admitted by the new grant. */
		cancelRunIds?: Array<string>
	}) {
		this.#saveSnapshot(input.snapshot)
		for (const runId of input.cancelRunIds ?? []) {
			await this.cancel({ runId, reason: 'grant_narrowed' })
		}
		const ws = this.#socket()
		if (ws) {
			await this.#send(ws, 'grant.update', {
				grant: input.snapshot.grant,
				grantVersion: input.snapshot.grantVersion,
			})
		}
		return { ok: true }
	}

	async activeLeases(): Promise<Array<ExecutionContextLease>> {
		return this.ctx.storage.sql
			.exec<{ lease_json: string }>(
				`SELECT lease_json FROM runs WHERE state = 'committed'`,
			)
			.toArray()
			.map((row) => JSON.parse(row.lease_json) as ExecutionContextLease)
	}

	// ---------- per-hop authorization ----------

	/**
	 * Verify the signed HTTP hop with the registered key, consume its nonce,
	 * and return the run's live lease. Origin then runs the access backstop.
	 */
	async authorizeRunCall(input: {
		runId: string
		signature: EcpHttpSignature
		method: string
		pathAndQuery: string
		bodySha256: string
	}): Promise<
		{ ok: true; lease: ExecutionContextLease } | { ok: false; code: string }
	> {
		const snapshot = this.#snapshot()
		if (!snapshot || this.#revokedReason())
			return { ok: false, code: 'revoked' }
		if (input.signature.ec !== snapshot.ecid) {
			return { ok: false, code: 'bad_signature' }
		}
		const now = Date.now()
		if (Math.abs(now - input.signature.ts) > 60_000) {
			return { ok: false, code: 'clock_skew' }
		}
		const message = [
			input.method.toUpperCase(),
			input.pathAndQuery,
			String(input.signature.ts),
			input.signature.n,
			input.bodySha256,
		].join('\n')
		const ok = await verifyDetached({
			prefix: ecpHttpSignaturePrefix,
			message,
			signature: input.signature.s,
			publicKey: await this.#contextPublicKey(),
		})
		if (!ok) return { ok: false, code: 'bad_signature' }
		if (!this.#consumeNonce(input.signature.n, now)) {
			return { ok: false, code: 'replay' }
		}
		const run = this.#run(input.runId)
		if (!run || run.state !== 'committed') {
			return { ok: false, code: 'lease_ended' }
		}
		if (now > run.deadline) return { ok: false, code: 'lease_ended' }
		return {
			ok: true,
			lease: JSON.parse(run.lease_json) as ExecutionContextLease,
		}
	}

	// ---------- history ----------

	/** Rows of this context. `viewerUserId` limits to that requester; `orgId` to runs bound to it. */
	async listHistory(input: {
		viewerUserId?: string
		orgId?: string
		requester?: string
		outcome?: string
		since?: number
		cursor?: number
		limit?: number
	}): Promise<{ rows: Array<RunHistoryRow>; nextCursor: number | null }> {
		this.#pruneHistory(Date.now())
		const limit = Math.min(100, Math.max(1, input.limit ?? 20))
		const clauses = ['1 = 1']
		const binds: Array<string | number> = []
		if (input.viewerUserId) {
			clauses.push('requester_user_id = ?')
			binds.push(input.viewerUserId)
		}
		if (input.requester) {
			clauses.push('requester_user_id = ?')
			binds.push(input.requester)
		}
		if (input.orgId) {
			clauses.push('run_org_id = ?')
			binds.push(input.orgId)
		}
		if (input.outcome) {
			clauses.push('outcome = ?')
			binds.push(input.outcome)
		}
		if (input.since) {
			clauses.push('dispatched_at >= ?')
			binds.push(input.since)
		}
		if (input.cursor) {
			clauses.push('dispatched_at < ?')
			binds.push(input.cursor)
		}
		const rows = this.ctx.storage.sql
			.exec<{
				run_id: string
				requester_user_id: string
				requester_handle: string | null
				run_org_id: string
				dispatched_at: number
				started_at: number | null
				ended_at: number | null
				outcome: string | null
				cancel_reason: string | null
				position: number
				ran_on: string | null
			}>(
				`SELECT * FROM history WHERE ${clauses.join(' AND ')}
				 ORDER BY dispatched_at DESC, attempt DESC LIMIT ?`,
				...binds,
				limit + 1,
			)
			.toArray()
		const snapshot = this.#snapshot()
		const page = rows.slice(0, limit).map((row) => {
			const ranOn =
				row.ran_on === 'here' ? (snapshot?.ecid ?? 'here') : row.ran_on
			return {
				runId: row.run_id,
				requester: {
					userId: row.requester_user_id,
					handle: row.requester_handle,
				},
				runOrgId: row.run_org_id,
				dispatchedAt: new Date(row.dispatched_at).toISOString(),
				startedAt: row.started_at
					? new Date(row.started_at).toISOString()
					: null,
				endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
				durationMs:
					row.started_at && row.ended_at ? row.ended_at - row.started_at : null,
				outcome: (row.outcome ??
					terminalOutcome('')) as RunHistoryOutcome | null,
				cancelReason: row.cancel_reason,
				fallback: { position: row.position, ...(ranOn ? { ranOn } : {}) },
			}
		})
		const last = rows[limit - 1]
		return {
			rows: page,
			nextCursor: rows.length > limit && last ? last.dispatched_at : null,
		}
	}

	/** Where a run that skipped this context ran instead (`ranOn`). */
	async noteRanOn(input: { runId: string; ranOn: string }) {
		this.ctx.storage.sql.exec(
			`UPDATE history SET ran_on = ? WHERE run_id = ? AND ran_on IS NULL AND started_at IS NULL`,
			input.ranOn,
			input.runId,
		)
		return { ok: true }
	}

	/** Management events (registration, grants, sharing, opt-ins, revoke). */
	async recordAudit(input: ExecutionContextAuditInput) {
		this.ctx.storage.sql.exec(
			`INSERT INTO audit (at, event, actor_user_id, actor_handle, org_id, detail_json)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			Date.now(),
			input.event,
			input.actor?.userId ?? null,
			input.actor?.handle ?? null,
			input.orgId ?? null,
			input.detail ? JSON.stringify(input.detail).slice(0, 2048) : null,
		)
		return { ok: true }
	}

	async listAudit(input: {
		orgId?: string
		cursor?: number
		limit?: number
	}): Promise<{
		rows: Array<ExecutionContextAuditRow>
		nextCursor: number | null
	}> {
		this.#pruneHistory(Date.now())
		const limit = Math.min(100, Math.max(1, input.limit ?? 20))
		const rows = this.ctx.storage.sql
			.exec<{
				id: number
				at: number
				event: string
				actor_user_id: string | null
				actor_handle: string | null
				org_id: string | null
				detail_json: string | null
			}>(
				`SELECT id, at, event, actor_user_id, actor_handle, org_id, detail_json FROM audit
				 WHERE (?1 IS NULL OR org_id IS NULL OR org_id = ?1)
				   AND (?2 IS NULL OR id < ?2)
				 ORDER BY id DESC LIMIT ?3`,
				input.orgId ?? null,
				input.cursor ?? null,
				limit + 1,
			)
			.toArray()
		const page = rows.slice(0, limit).map((row) => ({
			id: row.id,
			at: new Date(row.at).toISOString(),
			event: row.event,
			actor: row.actor_user_id
				? { userId: row.actor_user_id, handle: row.actor_handle }
				: null,
			orgId: row.org_id,
			detailJson: row.detail_json,
		}))
		return {
			rows: page,
			nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
		}
	}

	async purgeRequester(input: { userId: string }) {
		this.ctx.storage.sql.exec(
			`DELETE FROM history WHERE requester_user_id = ?`,
			input.userId,
		)
		this.ctx.storage.sql.exec(
			`UPDATE audit SET actor_user_id = NULL, actor_handle = NULL WHERE actor_user_id = ?`,
			input.userId,
		)
		return { ok: true }
	}

	#pruneHistory(now: number) {
		this.ctx.storage.sql.exec(
			`DELETE FROM history WHERE dispatched_at < ?`,
			now - historyRetentionMs,
		)
		this.ctx.storage.sql.exec(
			`DELETE FROM audit WHERE at < ?`,
			now - historyRetentionMs,
		)
		this.ctx.storage.sql.exec(
			`DELETE FROM history WHERE rowid NOT IN (
			   SELECT rowid FROM history ORDER BY dispatched_at DESC LIMIT ?)`,
			historyMaxRows,
		)
		this.ctx.storage.sql.exec(
			`DELETE FROM runs WHERE created_at < ? AND state NOT IN ('dispatched', 'committed')`,
			now - historyRetentionMs,
		)
	}

	async #ensureAlarm(at: number) {
		const current = await this.ctx.storage.getAlarm()
		if (current === null || current > at) await this.ctx.storage.setAlarm(at)
	}

	override async alarm() {
		const now = Date.now()
		this.ctx.storage.sql.exec(`DELETE FROM tickets WHERE expires_at <= ?`, now)
		this.ctx.storage.sql.exec(`DELETE FROM nonces WHERE expires_at <= ?`, now)
		const stale = this.ctx.storage.sql
			.exec<RunRow>(
				`SELECT run_id, state, lease_json, deadline, accept_by, run_record_json,
				   result_json, cancel_reason, started_at
				 FROM runs WHERE state = 'committed' AND deadline + ? <= ?`,
				ecpLostAfterDeadlineMs,
				now,
			)
			.toArray()
		for (const run of stale) {
			if (this.#finishRun(run.run_id, 'lost')) {
				await this.#finishRunRecord(run, { lost: true })
			}
		}
		this.ctx.storage.sql.exec(
			`UPDATE runs SET state = 'aborted', ended_at = ?
			 WHERE state = 'dispatched' AND accept_by + ? <= ?`,
			now,
			ecpCommitGraceMs,
			now,
		)
		this.#pruneHistory(now)
		const next = this.ctx.storage.sql
			.exec<{ deadline: number | null }>(
				`SELECT MIN(deadline) AS deadline FROM runs WHERE state = 'committed'`,
			)
			.one().deadline
		if (next !== null) {
			await this.ctx.storage.setAlarm(
				Math.max(now + 1000, next + ecpLostAfterDeadlineMs),
			)
		}
	}
}

export const executionContextRunLogLines = ecpMaxRunLogLines

export const ExecutionContextSessionV1 =
	Sentry.instrumentDurableObjectWithSentry(
		(env: Env) => buildSentryOptions(env),
		ExecutionContextSessionV1Base,
	)
export type ExecutionContextSessionV1 = InstanceType<
	typeof ExecutionContextSessionV1
>
