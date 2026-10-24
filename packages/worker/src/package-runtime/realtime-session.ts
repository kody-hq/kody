import { DurableObject } from 'cloudflare:workers'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { buildFacetName } from '#mcp/app-runner-facet-names.ts'
import { resolveBackgroundMcpUser } from '#worker/identity/background-mcp-user.ts'
import {
	accountSuspendedErrorCode,
	isAccountSuspendedError,
} from '#worker/account/account-suspension.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import { packageRealtimeSessionDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import {
	computeOverageLimitErrorCode,
	isComputeOverageLimitError,
} from '#worker/entitlements/errors.ts'
import { buildPackageAppWorker } from './package-app.ts'
import { endPackageAppVisit } from './package-app-visit-ticket.ts'
import { isWebSocketUpgradeRequest } from '#worker/package-runtime/websocket-upgrade.ts'

const includeUsedUpCloseReason = 'include-used-up'

const sessionStateStorageKey = 'package-realtime-state'
const sessionTagPrefix = 'session:'
const facetTagPrefix = 'facet:'
// Refresh source-version lookups periodically so long-lived sessions can pick up
// publishes without paying a D1 round trip on every websocket event.
const packageAppWorkerCacheKeyRefreshMs = 5_000

type PersistedPackageRealtimeSession = {
	id: string
	facet: string
	connectedAt: string
	lastSeenAt: string
	topics: Array<string>
}

type PackageRealtimeBindingState = {
	userId: OwnerId
	packageId: string
	kodyId: string
	sourceId: string
	baseUrl: string
}

type PackageRealtimeState = {
	binding: PackageRealtimeBindingState | null
	sessions: Record<string, PersistedPackageRealtimeSession>
}

type PackageRealtimeSessionRecord = {
	id: string
	facet: string
	topics: Array<string>
	connectedAt: string
	lastSeenAt: string
}

type PackageRealtimeSessionOutput = {
	session_id: string
	facet: string
	topics: Array<string>
	connected_at: string
	last_seen_at: string
}

export type PackageRealtimeEmitResult = {
	delivered: boolean
	reason?: string
}

export type PackageRealtimeBroadcastResult = {
	deliveredCount: number
	sessionIds: Array<string>
}

export type PackageRealtimeListResult = {
	sessions: Array<PackageRealtimeSessionOutput>
}

type PackageRealtimeEventRequestInfo = {
	url: string
	method: string
	headers: Record<string, string>
}

type PackageRealtimeIncomingMessage =
	| {
			kind: 'text'
			text: string
			json: unknown | null
	  }
	| {
			kind: 'binary'
			text: string | null
			json: unknown | null
	  }

type PackageRealtimeAction =
	| {
			type: 'send'
			data: unknown
	  }
	| {
			type: 'subscribe'
			topic: string
	  }
	| {
			type: 'unsubscribe'
			topic: string
	  }
	| {
			type: 'emit'
			sessionId: string
			data: unknown
	  }
	| {
			type: 'broadcast'
			data: unknown
			topic?: string | null
			facet?: string | null
	  }
	| {
			type: 'close'
			code?: number | null
			reason?: string | null
	  }

type PackageRealtimeHookResult =
	| {
			actions?: Array<PackageRealtimeAction> | null
	  }
	| Array<PackageRealtimeAction>
	| null
	| undefined

type PackageRealtimeHookInput = {
	event: 'connect' | 'message' | 'disconnect'
	facet: string
	session: PackageRealtimeSessionRecord
	request?: PackageRealtimeEventRequestInfo | null
	message?: PackageRealtimeIncomingMessage | null
	close?: {
		code: number
		reason: string
		wasClean: boolean
	} | null
}

type PackageRealtimeHookContext = {
	userId: OwnerId
	packageId: string
	kodyId: string
	baseUrl: string
	__kodyVisitTicket?: string | null
}

type PackageRealtimeConnectPayload = {
	binding: PackageRealtimeBindingState
	facet?: string | null
	request: PackageRealtimeEventRequestInfo
}

type PackageRealtimeEmitPayload = {
	binding: PackageRealtimeBindingState
	sessionId: string
	data: unknown
}

type PackageRealtimeBroadcastPayload = {
	binding: PackageRealtimeBindingState
	data: unknown
	topic?: string | null
	facet?: string | null
}

type PackageRealtimeListPayload = {
	binding: PackageRealtimeBindingState
	facet?: string | null
	topic?: string | null
}

function createInitialState(): PackageRealtimeState {
	return {
		binding: null,
		sessions: {},
	}
}

function sessionTag(sessionId: string) {
	return `${sessionTagPrefix}${sessionId}`
}

function facetTag(facet: string) {
	return `${facetTagPrefix}${facet}`
}

function pickString(...values: Array<unknown>) {
	for (const value of values) {
		if (typeof value === 'string' && value.trim().length > 0) {
			return value.trim()
		}
	}
	return null
}

function toPlainHeaders(headers: Headers) {
	return Object.fromEntries(headers.entries())
}

// workerd sends a `fetch` carrying `Upgrade: websocket` as a WebSocket
// handshake and drops the request body, so the connect payload travels in a
// header instead.
const packageRealtimeConnectHeaderName = 'X-Kody-Realtime-Connect'

function serializeOutboundMessage(value: unknown) {
	if (typeof value === 'string') {
		return value
	}
	return JSON.stringify(value)
}

function decodeInboundMessage(
	message: string | ArrayBuffer,
): PackageRealtimeIncomingMessage {
	if (typeof message === 'string') {
		try {
			return {
				kind: 'text',
				text: message,
				json: JSON.parse(message),
			}
		} catch {
			return {
				kind: 'text',
				text: message,
				json: null,
			}
		}
	}
	const text = (() => {
		try {
			return new TextDecoder().decode(message)
		} catch {
			return null
		}
	})()
	if (text == null) {
		return {
			kind: 'binary',
			text: null,
			json: null,
		}
	}
	try {
		return {
			kind: 'binary',
			text,
			json: JSON.parse(text),
		}
	} catch {
		return {
			kind: 'binary',
			text,
			json: null,
		}
	}
}

function normalizeHookActions(result: PackageRealtimeHookResult) {
	if (Array.isArray(result)) {
		return result
	}
	if (!result || typeof result !== 'object') {
		return []
	}
	return Array.isArray(result.actions) ? result.actions : []
}

function createSessionRecord(
	session: PersistedPackageRealtimeSession,
): PackageRealtimeSessionRecord {
	return {
		id: session.id,
		facet: session.facet,
		topics: [...session.topics],
		connectedAt: session.connectedAt,
		lastSeenAt: session.lastSeenAt,
	}
}

function createSessionOutput(
	session: PersistedPackageRealtimeSession,
): PackageRealtimeSessionOutput {
	return {
		session_id: session.id,
		facet: session.facet,
		topics: [...session.topics],
		connected_at: session.connectedAt,
		last_seen_at: session.lastSeenAt,
	}
}

function createPackageAppWorkerBindingIdentity(
	binding: PackageRealtimeBindingState,
) {
	return JSON.stringify([
		binding.userId,
		binding.packageId,
		binding.sourceId,
		binding.baseUrl,
	])
}

export async function resolvePackageAppWorkerBuildInput(input: {
	env: Env
	binding: PackageRealtimeBindingState
}) {
	// Realtime connects only through hosted serving, which serves a person's
	// own personal-org apps, so the org id is that person and they are its
	// Owner. A team org has no such person and is refused.
	const orgBinding = await loadOrgBindingForOrg(
		input.env.APP_DB,
		input.binding.userId,
		input.binding.userId,
	)
	if (!orgBinding) {
		throw new Error(
			"Package realtime serves only a person's own personal-org apps.",
		)
	}
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.binding.userId,
		packageId: input.binding.packageId,
	})
	if (!savedPackage || !savedPackage.hasApp) {
		throw new Error('Saved package app was not found.')
	}
	const packageSource = await loadPackageSourceBySourceId({
		env: input.env,
		baseUrl: input.binding.baseUrl,
		userId: input.binding.userId,
		sourceId: input.binding.sourceId,
	})
	const callerContext = createMcpCallerContext({
		baseUrl: input.binding.baseUrl,
		executionOrigin: 'background',
		user: await resolveBackgroundMcpUser(
			input.env.APP_DB,
			input.binding.userId,
		),
		orgBinding,
		storageContext: {
			sessionId: null,
			appId: input.binding.packageId,
			packageId: input.binding.packageId,
			storageId: input.binding.packageId,
		},
		repoContext: null,
		source: { kind: 'package-app' },
	})
	return {
		baseUrl: input.binding.baseUrl,
		userId: input.binding.userId,
		savedPackage: {
			id: savedPackage.id,
			kodyId: savedPackage.kodyId,
			name: savedPackage.name,
			sourceId: savedPackage.sourceId,
			publishedCommit: packageSource.source.published_commit,
			manifestPath: packageSource.source.manifest_path,
			sourceRoot: packageSource.source.source_root,
		},
		sourceFiles: packageSource.files,
		runtime: {
			callerContext,
		},
	}
}

export async function resolvePackageAppWorkerCacheKey(input: {
	env: Pick<Env, 'APP_DB'>
	binding: PackageRealtimeBindingState
}) {
	const source = await getEntitySourceById(
		input.env.APP_DB,
		input.binding.sourceId,
	)
	if (!source || source.user_id !== input.binding.userId) {
		throw new Error('Saved package source was not found.')
	}
	return JSON.stringify([
		input.binding.userId,
		input.binding.packageId,
		input.binding.sourceId,
		input.binding.baseUrl,
		source.published_commit ?? null,
	])
}

export class PackageRealtimeSession extends DurableObject<Env> {
	private stateSnapshot: PackageRealtimeState = createInitialState()
	private sessionIds = new WeakMap<WebSocket, string | null>()
	private cachedAppWorkerKey: string | null = null
	private cachedAppWorkerKeyLookup: {
		bindingIdentity: string
		cacheKey: string
		expiresAt: number
	} | null = null
	// Caches only the build *input* (D1 rows + source files + caller context).
	// The worker stub itself is request-bound and must be re-acquired per
	// event via buildPackageAppWorker, which reuses cached worker options and
	// warm loader isolates internally.
	private cachedAppWorkerBuildInputPromise: Promise<
		Awaited<ReturnType<typeof resolvePackageAppWorkerBuildInput>>
	> | null = null

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.ctx.blockConcurrencyWhile(async () => {
			await this.restoreState()
		})
	}

	private async restoreState() {
		const stored = await this.ctx.storage.get<PackageRealtimeState>(
			sessionStateStorageKey,
		)
		if (!stored) return
		this.stateSnapshot = {
			binding: stored.binding ?? null,
			sessions: stored.sessions ?? {},
		}
	}

	private async persistState() {
		await this.ctx.storage.put(sessionStateStorageKey, this.stateSnapshot)
	}

	private async purgeSessionState() {
		this.closeAllSockets(1000, 'account-deleted')
		this.stateSnapshot = createInitialState()
		this.cachedAppWorkerKey = null
		this.cachedAppWorkerKeyLookup = null
		this.cachedAppWorkerBuildInputPromise = null
		await this.ctx.storage.deleteAll()
	}

	private async initializeBinding(binding: PackageRealtimeBindingState) {
		if (!this.stateSnapshot.binding) {
			this.stateSnapshot.binding = binding
			await this.persistState()
			return
		}
		const existing = this.stateSnapshot.binding
		if (
			existing.userId !== binding.userId ||
			existing.packageId !== binding.packageId ||
			existing.sourceId !== binding.sourceId
		) {
			throw new Error('Realtime session binding mismatch.')
		}
		if (
			existing.baseUrl !== binding.baseUrl ||
			existing.kodyId !== binding.kodyId
		) {
			this.stateSnapshot.binding = {
				...existing,
				baseUrl: binding.baseUrl,
				kodyId: binding.kodyId,
			}
			await this.persistState()
		}
	}

	private async getPackageAppWorker(binding: PackageRealtimeBindingState) {
		const cacheKey = await this.getResolvedPackageAppWorkerCacheKey(binding)
		if (
			this.cachedAppWorkerKey !== cacheKey ||
			!this.cachedAppWorkerBuildInputPromise
		) {
			this.cachedAppWorkerKey = cacheKey
			this.cachedAppWorkerBuildInputPromise = resolvePackageAppWorkerBuildInput(
				{
					env: this.env,
					binding,
				},
			).catch((error) => {
				if (this.cachedAppWorkerKey === cacheKey) {
					this.cachedAppWorkerKey = null
					this.cachedAppWorkerBuildInputPromise = null
				}
				throw error
			})
		}
		const buildInput = await this.cachedAppWorkerBuildInputPromise
		return await buildPackageAppWorker({
			env: this.env,
			...buildInput,
			surface: 'app_realtime',
			waitUntil: (promise) => {
				this.ctx.waitUntil(promise)
			},
		})
	}

	private async getResolvedPackageAppWorkerCacheKey(
		binding: PackageRealtimeBindingState,
	) {
		const bindingIdentity = createPackageAppWorkerBindingIdentity(binding)
		const cachedLookup = this.cachedAppWorkerKeyLookup
		const now = Date.now()
		if (
			cachedLookup &&
			cachedLookup.bindingIdentity === bindingIdentity &&
			cachedLookup.expiresAt > now
		) {
			return cachedLookup.cacheKey
		}
		const cacheKey = await resolvePackageAppWorkerCacheKey({
			env: this.env,
			binding,
		})
		this.cachedAppWorkerKeyLookup = {
			bindingIdentity,
			cacheKey,
			expiresAt: now + packageAppWorkerCacheKeyRefreshMs,
		}
		return cacheKey
	}

	private stashSessionId(ws: WebSocket, sessionId: string) {
		this.sessionIds.set(ws, sessionId)
		try {
			ws.serializeAttachment(sessionId)
		} catch {
			// Best effort; keep in-memory map for local runtimes without attachments.
		}
	}

	private loadSessionId(ws: WebSocket) {
		if (this.sessionIds.has(ws)) {
			return this.sessionIds.get(ws) ?? null
		}
		let sessionId: string | null = null
		try {
			const attachment = ws.deserializeAttachment()
			if (typeof attachment === 'string' && attachment.trim().length > 0) {
				sessionId = attachment.trim()
			}
		} catch {
			// Ignore missing attachment support.
		}
		this.sessionIds.set(ws, sessionId)
		return sessionId
	}

	private getSocketBySessionId(sessionId: string) {
		return this.ctx.getWebSockets(sessionTag(sessionId))[0] ?? null
	}

	private listSessions(input?: {
		facet?: string | null
		topic?: string | null
	}): Array<PackageRealtimeSessionOutput> {
		const facet = buildFacetName(input?.facet)
		const topic = pickString(input?.topic)
		return Object.values(this.stateSnapshot.sessions)
			.filter((session) => {
				if (input?.facet != null && session.facet !== facet) return false
				if (topic && !session.topics.includes(topic)) return false
				return this.getSocketBySessionId(session.id) != null
			})
			.map(createSessionOutput)
	}

	private async emitToSession(sessionId: string, data: unknown) {
		const socket = this.getSocketBySessionId(sessionId)
		if (!socket) {
			if (this.stateSnapshot.sessions[sessionId]) {
				delete this.stateSnapshot.sessions[sessionId]
				await this.persistState()
			}
			return { delivered: false, reason: 'session_not_connected' as const }
		}
		try {
			socket.send(serializeOutboundMessage(data))
		} catch {
			if (this.stateSnapshot.sessions[sessionId]) {
				delete this.stateSnapshot.sessions[sessionId]
				await this.persistState()
			}
			return { delivered: false, reason: 'session_not_connected' as const }
		}
		return { delivered: true as const }
	}

	private async broadcast(input: {
		facet?: string | null
		topic?: string | null
		data: unknown
	}) {
		const sessions = this.listSessions({
			facet: input.facet,
			topic: input.topic,
		})
		let deliveredCount = 0
		const sessionIds: Array<string> = []
		for (const session of sessions) {
			const delivered = await this.emitToSession(session.session_id, input.data)
			if (delivered.delivered) {
				deliveredCount += 1
				sessionIds.push(session.session_id)
			}
		}
		return {
			deliveredCount,
			sessionIds,
		}
	}

	private async resolveRealtimeHookResult(input: {
		binding: PackageRealtimeBindingState
		payload: PackageRealtimeHookInput
	}) {
		// The build input (including its caller identity) outlives a single
		// event, so re-check suspension per hook; the resolver's short cache
		// keeps this off the D1 hot path.
		await resolveBackgroundMcpUser(this.env.APP_DB, input.binding.userId)
		let visitNonce: string | null = null
		try {
			const appWorker = await this.getPackageAppWorker(input.binding)
			visitNonce = appWorker.visit.nonce
			const entrypoint = appWorker.stub.getEntrypoint(
				appWorker.entrypointName,
			) as {
				handleRealtimeEvent?: (
					payload: PackageRealtimeHookInput & PackageRealtimeHookContext,
				) => Promise<PackageRealtimeHookResult>
			}
			if (typeof entrypoint.handleRealtimeEvent !== 'function') {
				return []
			}
			const result = await entrypoint.handleRealtimeEvent({
				...input.payload,
				userId: input.binding.userId,
				packageId: input.binding.packageId,
				kodyId: input.binding.kodyId,
				baseUrl: input.binding.baseUrl,
				__kodyVisitTicket: appWorker.visit.ticket,
			})
			return normalizeHookActions(result)
		} finally {
			endPackageAppVisit(visitNonce)
		}
	}

	private async applyHookActions(
		sessionId: string,
		actions: Array<PackageRealtimeAction>,
		sessionOverride?: PersistedPackageRealtimeSession | null,
	) {
		const session = sessionOverride ?? this.stateSnapshot.sessions[sessionId]
		if (!session) return
		let shouldPersist = false
		for (const action of actions) {
			if (!action || typeof action !== 'object' || !('type' in action)) continue
			switch (action.type) {
				case 'send':
					await this.emitToSession(sessionId, action.data)
					break
				case 'subscribe': {
					const topic = pickString(action.topic)
					if (!topic || session.topics.includes(topic)) break
					session.topics.push(topic)
					shouldPersist = true
					break
				}
				case 'unsubscribe': {
					const topic = pickString(action.topic)
					if (!topic) break
					const nextTopics = session.topics.filter((value) => value !== topic)
					if (nextTopics.length === session.topics.length) break
					session.topics = nextTopics
					shouldPersist = true
					break
				}
				case 'emit':
					await this.emitToSession(action.sessionId, action.data)
					break
				case 'broadcast':
					await this.broadcast({
						facet: action.facet,
						topic: action.topic,
						data: action.data,
					})
					break
				case 'close': {
					const socket = this.getSocketBySessionId(sessionId)
					if (socket) {
						try {
							socket.close(action.code ?? 1000, action.reason ?? 'closed')
						} catch {
							// Ignore duplicate close attempts on sockets that are already closing.
						}
					}
					break
				}
			}
		}
		if (shouldPersist && this.stateSnapshot.sessions[sessionId]) {
			this.stateSnapshot.sessions[sessionId] = session
			await this.persistState()
		}
	}

	private async handleConnectRequest(payload: PackageRealtimeConnectPayload) {
		await this.initializeBinding(payload.binding)
		const facet = buildFacetName(payload.facet)
		const pair = new WebSocketPair()
		const sockets = Object.values(pair)
		const client = sockets[0]
		const server = sockets[1]
		if (!client || !server) {
			throw new Error('Failed to create WebSocket pair.')
		}
		const sessionId = crypto.randomUUID()
		const now = new Date().toISOString()
		this.ctx.acceptWebSocket(server, [sessionTag(sessionId), facetTag(facet)])
		this.stashSessionId(server, sessionId)
		this.stateSnapshot.sessions[sessionId] = {
			id: sessionId,
			facet,
			connectedAt: now,
			lastSeenAt: now,
			topics: [],
		}
		await this.persistState()
		try {
			const actions = await this.resolveRealtimeHookResult({
				binding: payload.binding,
				payload: {
					event: 'connect',
					facet,
					session: createSessionRecord(this.stateSnapshot.sessions[sessionId]),
					request: payload.request,
				},
			})
			await this.applyHookActions(sessionId, actions)
		} catch (error) {
			delete this.stateSnapshot.sessions[sessionId]
			await this.persistState()
			if (isAccountSuspendedError(error)) {
				this.closeAllSockets(1008, 'account-suspended')
				return Response.json(
					{ ok: false, error: { code: error.code, message: error.message } },
					{ status: 403 },
				)
			}
			if (isComputeOverageLimitError(error)) {
				this.closeAllSockets(1008, includeUsedUpCloseReason)
				return Response.json(
					{
						ok: false,
						error: {
							code: computeOverageLimitErrorCode,
							message: error.message,
							details: error.details,
						},
					},
					{ status: 429 },
				)
			}
			try {
				server.close(1011, 'connect hook failed')
			} catch {
				// Best effort cleanup for failed upgrade setup.
			}
			throw error
		}
		return new Response(null, {
			status: 101,
			webSocket: client,
		})
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (isWebSocketUpgradeRequest(request)) {
			const payload = request.headers.get(packageRealtimeConnectHeaderName)
			if (!payload) {
				return new Response('Missing realtime connect payload.', {
					status: 400,
				})
			}
			return await this.handleConnectRequest(
				JSON.parse(
					decodeURIComponent(payload),
				) as PackageRealtimeConnectPayload,
			)
		}

		if (request.method === 'POST' && url.pathname.endsWith('/sessions')) {
			const body = (await request.json()) as PackageRealtimeListPayload
			await this.initializeBinding(body.binding)
			return Response.json({
				sessions: this.listSessions({
					facet: body.facet,
					topic: body.topic,
				}),
			})
		}

		if (request.method === 'POST' && url.pathname.endsWith('/emit')) {
			const body = (await request.json()) as PackageRealtimeEmitPayload
			await this.initializeBinding(body.binding)
			if (await this.closeSocketsIfOwnerSuspended(body.binding)) {
				return Response.json({
					delivered: false,
					reason: accountSuspendedErrorCode,
				} satisfies PackageRealtimeEmitResult)
			}
			return Response.json(await this.emitToSession(body.sessionId, body.data))
		}

		if (request.method === 'POST' && url.pathname.endsWith('/broadcast')) {
			const body = (await request.json()) as PackageRealtimeBroadcastPayload
			await this.initializeBinding(body.binding)
			if (await this.closeSocketsIfOwnerSuspended(body.binding)) {
				return Response.json({
					deliveredCount: 0,
					sessionIds: [],
				} satisfies PackageRealtimeBroadcastResult)
			}
			return Response.json(
				await this.broadcast({
					facet: body.facet,
					topic: body.topic,
					data: body.data,
				}),
			)
		}

		if (request.method === 'POST' && url.pathname.endsWith('/disconnect')) {
			const body = (await request.json()) as {
				binding: PackageRealtimeBindingState
				sessionId: string
				code?: number | null
				reason?: string | null
			}
			await this.initializeBinding(body.binding)
			const socket = this.getSocketBySessionId(body.sessionId)
			if (socket) {
				try {
					socket.close(body.code ?? 1000, body.reason ?? 'closed')
				} catch {
					// Ignore duplicate close attempts on sockets that are already closing.
				}
			}
			return Response.json({ ok: true })
		}

		if (request.method === 'POST' && url.pathname.endsWith('/purge')) {
			const body = (await request.json()) as {
				binding: PackageRealtimeBindingState
			}
			await this.initializeBinding(body.binding)
			await this.purgeSessionState()
			return Response.json({ ok: true })
		}

		return new Response('Not found', { status: 404 })
	}

	webSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
	): void | Promise<void> {
		return this.handleWebSocketMessage(ws, message)
	}

	webSocketClose(
		ws: WebSocket,
		_code: number,
		reason: string,
		wasClean: boolean,
	): void | Promise<void> {
		return this.handleDisconnect(ws, {
			code: _code,
			reason,
			wasClean,
		})
	}

	webSocketError(ws: WebSocket, error: unknown): void | Promise<void> {
		return this.handleDisconnect(ws, {
			code: 1011,
			reason: error instanceof Error ? error.message : String(error ?? 'error'),
			wasClean: false,
		})
	}

	private async handleWebSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
	) {
		const sessionId = this.loadSessionId(ws)
		if (!sessionId) return
		const session = this.stateSnapshot.sessions[sessionId]
		const binding = this.stateSnapshot.binding
		if (!session || !binding) return
		session.lastSeenAt = new Date().toISOString()
		await this.persistState()
		let actions: Array<PackageRealtimeAction>
		try {
			actions = await this.resolveRealtimeHookResult({
				binding,
				payload: {
					event: 'message',
					facet: session.facet,
					session: createSessionRecord(session),
					message: decodeInboundMessage(message),
				},
			})
		} catch (error) {
			if (isComputeOverageLimitError(error)) {
				this.closeAllSockets(1008, includeUsedUpCloseReason)
				return
			}
			if (!isAccountSuspendedError(error)) throw error
			this.closeAllSockets(1008, 'account-suspended')
			return
		}
		await this.applyHookActions(sessionId, actions)
	}

	private async closeSocketsIfOwnerSuspended(
		binding: PackageRealtimeBindingState,
	) {
		const suspended = await resolveBackgroundMcpUser(
			this.env.APP_DB,
			binding.userId,
		).then(
			() => false,
			(error: unknown) => isAccountSuspendedError(error),
		)
		if (suspended) this.closeAllSockets(1008, 'account-suspended')
		return suspended
	}

	private closeAllSockets(code: number, reason: string) {
		for (const socket of this.ctx.getWebSockets()) {
			try {
				socket.close(code, reason)
			} catch {
				// Ignore sockets that are already closing.
			}
		}
	}

	private async handleDisconnect(
		ws: WebSocket,
		close: {
			code: number
			reason: string
			wasClean: boolean
		},
	) {
		const sessionId = this.loadSessionId(ws)
		if (!sessionId) return
		const session = this.stateSnapshot.sessions[sessionId]
		const binding = this.stateSnapshot.binding
		delete this.stateSnapshot.sessions[sessionId]
		await this.persistState()
		if (!session || !binding) return
		let actions: Array<PackageRealtimeAction>
		try {
			actions = await this.resolveRealtimeHookResult({
				binding,
				payload: {
					event: 'disconnect',
					facet: session.facet,
					session: createSessionRecord(session),
					close,
				},
			})
		} catch (error) {
			if (isAccountSuspendedError(error) || isComputeOverageLimitError(error)) {
				return
			}
			throw error
		}
		await this.applyHookActions(sessionId, actions, session)
	}
}

type PackageRealtimeSessionRpc = {
	fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

function getPackageRealtimeNamespace(env: Env) {
	return env.PACKAGE_REALTIME_SESSION
}

function getPackageRealtimeStub(input: {
	env: Env
	userId: OwnerId
	packageId: string
}): PackageRealtimeSessionRpc {
	const namespace = getPackageRealtimeNamespace(input.env)
	if (!namespace) {
		throw new Error('Missing PACKAGE_REALTIME_SESSION binding.')
	}
	const id = namespace.idFromName(
		packageRealtimeSessionDurableObjectName({
			userId: input.userId,
			packageId: input.packageId,
		}),
	)
	return namespace.get(id) as unknown as PackageRealtimeSessionRpc
}

export function packageRealtimeSessionRpc(input: {
	env: Env
	userId: OwnerId
	packageId: string
	kodyId: string
	sourceId: string
	baseUrl: string
}) {
	const binding: PackageRealtimeBindingState = {
		userId: input.userId,
		packageId: input.packageId,
		kodyId: input.kodyId,
		sourceId: input.sourceId,
		baseUrl: input.baseUrl,
	}
	const stub = getPackageRealtimeStub(input)
	return {
		async connect(request: Request, facet?: string | null) {
			const payload: PackageRealtimeConnectPayload = {
				binding,
				facet,
				request: {
					url: request.url,
					method: request.method,
					headers: toPlainHeaders(request.headers),
				},
			}
			// Plain-object headers survive Sentry's Fetcher instrumentation merge.
			return await stub.fetch(request.url, {
				headers: {
					Upgrade: 'websocket',
					[packageRealtimeConnectHeaderName]: encodeURIComponent(
						JSON.stringify(payload),
					),
				},
			})
		},
		async emit(
			sessionId: string,
			data: unknown,
		): Promise<PackageRealtimeEmitResult> {
			const response = await stub.fetch(
				new Request('https://package-realtime.invalid/session/emit', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						binding,
						sessionId,
						data,
					} satisfies PackageRealtimeEmitPayload),
				}),
			)
			return (await response.json()) as PackageRealtimeEmitResult
		},
		async broadcast(input2: {
			data: unknown
			topic?: string | null
			facet?: string | null
		}): Promise<PackageRealtimeBroadcastResult> {
			const response = await stub.fetch(
				new Request('https://package-realtime.invalid/session/broadcast', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						binding,
						data: input2.data,
						topic: input2.topic,
						facet: input2.facet,
					} satisfies PackageRealtimeBroadcastPayload),
				}),
			)
			return (await response.json()) as PackageRealtimeBroadcastResult
		},
		async listSessions(input2?: {
			topic?: string | null
			facet?: string | null
		}): Promise<PackageRealtimeListResult> {
			const response = await stub.fetch(
				new Request('https://package-realtime.invalid/session/sessions', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						binding,
						topic: input2?.topic,
						facet: input2?.facet,
					} satisfies PackageRealtimeListPayload),
				}),
			)
			return (await response.json()) as PackageRealtimeListResult
		},
		async disconnect(
			sessionId: string,
			input2?: { code?: number; reason?: string },
		) {
			const response = await stub.fetch(
				new Request('https://package-realtime.invalid/session/disconnect', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						binding,
						sessionId,
						code: input2?.code,
						reason: input2?.reason,
					}),
				}),
			)
			return await response.json()
		},
		async purge() {
			const response = await stub.fetch(
				new Request('https://package-realtime.invalid/session/purge', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						binding,
					}),
				}),
			)
			return (await response.json()) as { ok: true }
		},
	}
}
