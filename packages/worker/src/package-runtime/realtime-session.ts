import { DurableObject } from 'cloudflare:workers'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
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
import { resolveInternetVisibleApprovedCommit } from '#worker/app/package-app-internet-visible.ts'
import { recordUsage } from '#worker/usage/record-usage.ts'
import {
	computeOverageLimitErrorCode,
	isComputeOverageLimitError,
} from '#worker/entitlements/errors.ts'
import { buildPackageAppWorker } from './package-app.ts'
import { endPackageAppVisit } from './package-app-visit-ticket.ts'
import { isWebSocketUpgradeRequest } from '#worker/package-runtime/websocket-upgrade.ts'

const includeUsedUpCloseReason = 'include-used-up'

// Pre-per-socket layout: one record holding the binding and every session.
const legacySessionStateStorageKey = 'package-realtime-state'
const bindingStorageKey = 'package-realtime-binding'
const sessionStoragePrefix = 'session-state:'
const sessionTagPrefix = 'session:'
const facetTagPrefix = 'facet:'
const publicSocketTag = 'public'
const ipTagPrefix = 'ip:'
// Refresh source-version lookups periodically so long-lived sessions can pick up
// publishes without paying a D1 round trip on every websocket event.
const packageAppWorkerCacheKeyRefreshMs = 5_000

/**
 * Platform caps on public sockets: ones opened through the app's
 * `kody.app.realtime.anonymous` opt-in by visitors who are not signed in to
 * the owning org. Org members keep the uncapped behavior.
 */
export const anonymousRealtimeLimits = {
	socketsPerApp: 2_000,
	socketsPerIp: 20,
	connectsPerIpPerMinute: 30,
	maxSessionMs: 24 * 60 * 60 * 1000,
	/** Inbound frames and each emit / broadcast delivered to a public socket. */
	maxPayloadBytes: 64 * 1024,
	/** Soft cap: broadcasts over it skip public sockets, members still get them. */
	broadcastsPerSecond: 20,
	/** Two-way only; a socket over it is closed with 1008. */
	inboundMessagesPerSecond: 10,
	inboundMessageBurst: 20,
	/** How often live public sockets recheck the app's approved commit. */
	accessRecheckMs: 5 * 60 * 1000,
} as const

/** Text frame the platform answers without waking the app or its hooks. */
export const packageRealtimePingMessage = 'kody:ping'
export const packageRealtimePongMessage = 'kody:pong'

/** Who may open sockets and whether app hooks run for their messages. */
export type PackageRealtimeAccess = 'member' | 'receive' | 'two-way'

/** Signed-in Kody user behind a socket; `role` is null outside the org. */
export type PackageRealtimeVisitor = {
	userId: string
	username: string
	role: string | null
}

type PackageRealtimeSocketAttachment = {
	v: 2
	id: string
	facet: string
	connectedAt: string
	access: PackageRealtimeAccess
	visitor: PackageRealtimeVisitor | null
	/** Commit the owner approved for public visitors when the socket opened. */
	approvedCommit: string | null
}

type PersistedPackageRealtimeSession = PackageRealtimeSocketAttachment & {
	lastSeenAt: string
	topics: Array<string>
}

type StoredPackageRealtimeSessionState = {
	topics: Array<string>
	lastSeenAt: string
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
	/** True when the visitor is not signed in to Kody at all. */
	anonymous: boolean
	visitor: PackageRealtimeVisitor | null
}

type PackageRealtimeSessionOutput = {
	session_id: string
	facet: string
	topics: Array<string>
	connected_at: string
	last_seen_at: string
	anonymous: boolean
	visitor: PackageRealtimeVisitor | null
}

export type PackageRealtimeEmitResult = {
	delivered: boolean
	reason?: string
}

export type PackageRealtimeBroadcastResult = {
	deliveredCount: number
	sessionIds: Array<string>
	/** Public sockets skipped by the payload or broadcast-rate cap. */
	limitedCount?: number
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
	/**
	 * The signed-in Kody user behind the socket, or null for an anonymous
	 * visitor, matching `X-Kody-Visitor` on HTTP requests.
	 */
	visitor: PackageRealtimeVisitor | null
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
	/** Defaults to `member`. */
	access?: PackageRealtimeAccess
	visitor?: PackageRealtimeVisitor | null
	/** Public access only; required for `receive` and `two-way`. */
	approvedCommit?: string | null
	/** Public access only: hashed client IP for the per-IP caps. */
	ipHash?: string | null
}

export type PackageRealtimeConnectOptions = Pick<
	PackageRealtimeConnectPayload,
	'access' | 'visitor' | 'approvedCommit' | 'ipHash'
>

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

function sessionStorageKey(sessionId: string) {
	return `${sessionStoragePrefix}${sessionId}`
}

function ipTag(ipHash: string) {
	return `${ipTagPrefix}${ipHash}`
}

function isPublicAccess(access: PackageRealtimeAccess | undefined) {
	return access === 'receive' || access === 'two-way'
}

function readSocketAttachment(
	value: unknown,
): PackageRealtimeSocketAttachment | null {
	if (!value || typeof value !== 'object') return null
	const attachment = value as Partial<PackageRealtimeSocketAttachment>
	if (attachment.v !== 2 || typeof attachment.id !== 'string') return null
	return attachment as PackageRealtimeSocketAttachment
}

const utf8Encoder = new TextEncoder()

function payloadByteLength(message: string | ArrayBuffer) {
	if (typeof message !== 'string') return message.byteLength
	// UTF-8 needs at most 3 bytes per UTF-16 code unit.
	if (message.length * 3 <= anonymousRealtimeLimits.maxPayloadBytes) {
		return message.length
	}
	return utf8Encoder.encode(message).byteLength
}

/** Token bucket in memory; it resets when the object is evicted. */
class RateBucket {
	private readonly ratePerSecond: number
	private readonly burst: number
	private tokens: number
	private updatedAt = Date.now()
	constructor(ratePerSecond: number, burst: number) {
		this.ratePerSecond = ratePerSecond
		this.burst = burst
		this.tokens = burst
	}
	take() {
		const now = Date.now()
		this.tokens = Math.min(
			this.burst,
			this.tokens + ((now - this.updatedAt) / 1000) * this.ratePerSecond,
		)
		this.updatedAt = now
		if (this.tokens < 1) return false
		this.tokens -= 1
		return true
	}
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

function closeSocket(socket: WebSocket, code: number, reason: string) {
	try {
		socket.close(code, reason)
	} catch {
		// Ignore sockets that are already closing.
	}
}

function outboundByteLength(message: string | undefined) {
	return typeof message === 'string' ? payloadByteLength(message) : 0
}

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
		anonymous: isPublicAccess(session.access) && session.visitor === null,
		visitor: session.visitor,
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
		anonymous: isPublicAccess(session.access) && session.visitor === null,
		visitor: session.visitor,
	}
}

class PackageRealtimePinMismatchError extends Error {
	constructor() {
		super(
			'The running app version is not the one approved for public visitors.',
		)
		this.name = 'PackageRealtimePinMismatchError'
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

/**
 * The approved internet-visible commit when it is also the live published
 * commit, else null. Same rule as `refuseUnapprovedAnonymousServe`.
 */
export async function resolvePublicRealtimeCommit(input: {
	env: Env
	binding: PackageRealtimeBindingState
}) {
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.binding.userId,
		packageId: input.binding.packageId,
	})
	if (!savedPackage) return null
	const [approvedCommit, source] = await Promise.all([
		resolveInternetVisibleApprovedCommit({
			env: input.env,
			lookup: { savedPackage, retired: false },
			requestUrl: input.binding.baseUrl,
		}),
		getEntitySourceById(input.env.APP_DB, savedPackage.sourceId),
	])
	if (!approvedCommit || source?.published_commit !== approvedCommit) {
		return null
	}
	return approvedCommit
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

type LegacyPersistedPackageRealtimeSession = {
	id: string
	facet: string
	connectedAt: string
	lastSeenAt: string
	topics: Array<string>
}

type LegacyPackageRealtimeState = {
	binding?: PackageRealtimeBindingState | null
	sessions?: Record<string, LegacyPersistedPackageRealtimeSession>
}

const maxPublicFacetLength = 128
// DurableObjectStorage.delete accepts at most 128 keys per call.
const storageDeleteBatchSize = 128
const connectWindowMs = 60_000
const maxTrackedConnectIps = 10_000

function publicConnectRefusal(message: string, retryAfterSeconds?: number) {
	return new Response(message, {
		status: 429,
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'no-store',
			...(retryAfterSeconds
				? { 'Retry-After': String(retryAfterSeconds) }
				: {}),
		},
	})
}

export class PackageRealtimeSession extends DurableObject<Env> {
	private stateSnapshot: PackageRealtimeState = createInitialState()
	private sessionIds = new WeakMap<WebSocket, string | null>()
	// Session ids with a `session-state:` record in storage.
	private persistedSessionIds = new Set<string>()
	private inboundBuckets = new WeakMap<WebSocket, RateBucket>()
	private broadcastBucket = new RateBucket(
		anonymousRealtimeLimits.broadcastsPerSecond,
		anonymousRealtimeLimits.broadcastsPerSecond,
	)
	private connectsByIp = new Map<string, Array<number>>()
	private publicAccessLookup: {
		commit: Promise<string | null>
		expiresAt: number
	} | null = null
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
		// Answered by the runtime without waking the object, so idle public
		// sockets can keep their connection alive for free.
		this.ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair(
				packageRealtimePingMessage,
				packageRealtimePongMessage,
			),
		)
		this.ctx.blockConcurrencyWhile(async () => {
			await this.restoreState()
		})
	}

	private async restoreState() {
		const [binding, legacy, stored] = await Promise.all([
			this.ctx.storage.get<PackageRealtimeBindingState>(bindingStorageKey),
			this.ctx.storage.get<LegacyPackageRealtimeState>(
				legacySessionStateStorageKey,
			),
			this.ctx.storage.list<StoredPackageRealtimeSessionState>({
				prefix: sessionStoragePrefix,
			}),
		])
		this.stateSnapshot = {
			binding: binding ?? legacy?.binding ?? null,
			sessions: {},
		}
		const legacySessions = legacy?.sessions ?? {}
		for (const ws of this.ctx.getWebSockets()) {
			let raw: unknown = null
			try {
				raw = ws.deserializeAttachment()
			} catch {
				// Ignore missing attachment support.
			}
			let attachment = readSocketAttachment(raw)
			if (!attachment && typeof raw === 'string') {
				const legacySession = legacySessions[raw.trim()]
				if (legacySession) {
					attachment = {
						v: 2,
						id: legacySession.id,
						facet: legacySession.facet,
						connectedAt: legacySession.connectedAt,
						access: 'member',
						visitor: null,
						approvedCommit: null,
					}
				}
			}
			if (!attachment) continue
			const persisted =
				stored.get(sessionStorageKey(attachment.id)) ??
				legacySessions[attachment.id]
			this.stateSnapshot.sessions[attachment.id] = {
				...attachment,
				topics: [...(persisted?.topics ?? [])],
				lastSeenAt: persisted?.lastSeenAt ?? attachment.connectedAt,
			}
			this.sessionIds.set(ws, attachment.id)
		}
		const staleKeys: Array<string> = []
		for (const key of stored.keys()) {
			const sessionId = key.slice(sessionStoragePrefix.length)
			if (this.stateSnapshot.sessions[sessionId]) {
				this.persistedSessionIds.add(sessionId)
			} else {
				staleKeys.push(key)
			}
		}
		if (legacy) {
			if (!binding && this.stateSnapshot.binding) {
				await this.ctx.storage.put(
					bindingStorageKey,
					this.stateSnapshot.binding,
				)
			}
			for (const session of Object.values(this.stateSnapshot.sessions)) {
				if (
					!this.persistedSessionIds.has(session.id) &&
					session.topics.length
				) {
					await this.persistSession(session)
				}
			}
			staleKeys.push(legacySessionStateStorageKey)
		}
		for (let i = 0; i < staleKeys.length; i += storageDeleteBatchSize) {
			await this.ctx.storage.delete(
				staleKeys.slice(i, i + storageDeleteBatchSize),
			)
		}
	}

	/** One small record per socket, written only when its topics change. */
	private async persistSession(session: PersistedPackageRealtimeSession) {
		await this.ctx.storage.put<StoredPackageRealtimeSessionState>(
			sessionStorageKey(session.id),
			{ topics: [...session.topics], lastSeenAt: session.lastSeenAt },
		)
		this.persistedSessionIds.add(session.id)
	}

	private async forgetSession(sessionId: string) {
		delete this.stateSnapshot.sessions[sessionId]
		if (!this.persistedSessionIds.delete(sessionId)) return
		await this.ctx.storage.delete(sessionStorageKey(sessionId))
	}

	private async purgeSessionState() {
		this.closeAllSockets(1000, 'account-deleted')
		this.stateSnapshot = createInitialState()
		this.persistedSessionIds.clear()
		this.cachedAppWorkerKey = null
		this.cachedAppWorkerKeyLookup = null
		this.cachedAppWorkerBuildInputPromise = null
		this.publicAccessLookup = null
		await this.ctx.storage.deleteAll()
	}

	private async initializeBinding(binding: PackageRealtimeBindingState) {
		if (!this.stateSnapshot.binding) {
			this.stateSnapshot.binding = binding
			await this.ctx.storage.put(bindingStorageKey, binding)
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
			await this.ctx.storage.put(bindingStorageKey, this.stateSnapshot.binding)
		}
	}

	private async getPackageAppWorker(
		binding: PackageRealtimeBindingState,
		requiredCommit: string | null,
	) {
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
		// Public sockets run only the commit the owner approved (ADR 0069).
		if (
			requiredCommit !== null &&
			buildInput.savedPackage.publishedCommit !== requiredCommit
		) {
			throw new PackageRealtimePinMismatchError()
		}
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

	/**
	 * The commit public sockets may run right now: the app's approved
	 * internet-visible commit when it is also the live published commit, the
	 * same rule anonymous HTTP applies. Null when public access is off.
	 */
	private resolvePublicAccessCommit(binding: PackageRealtimeBindingState) {
		const now = Date.now()
		const cached = this.publicAccessLookup
		if (cached && cached.expiresAt > now) return cached.commit
		const commit = resolvePublicRealtimeCommit({ env: this.env, binding })
		this.publicAccessLookup = {
			commit,
			expiresAt: now + packageAppWorkerCacheKeyRefreshMs,
		}
		commit.catch(() => {
			if (this.publicAccessLookup?.commit === commit) {
				this.publicAccessLookup = null
			}
		})
		return commit
	}

	private async publicAccessAllowed(
		binding: PackageRealtimeBindingState,
		session: PersistedPackageRealtimeSession,
	) {
		const commit = await this.resolvePublicAccessCommit(binding)
		return commit !== null && commit === session.approvedCommit
	}

	private stashSession(
		ws: WebSocket,
		attachment: PackageRealtimeSocketAttachment,
	) {
		this.sessionIds.set(ws, attachment.id)
		try {
			ws.serializeAttachment(attachment)
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
			const attachment: unknown = ws.deserializeAttachment()
			const parsed = readSocketAttachment(attachment)
			if (parsed) {
				sessionId = parsed.id
			} else if (
				typeof attachment === 'string' &&
				attachment.trim().length > 0
			) {
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

	private async sendToSession(sessionId: string, message: string) {
		const socket = this.getSocketBySessionId(sessionId)
		if (!socket) {
			await this.forgetSession(sessionId)
			return { delivered: false, reason: 'session_not_connected' as const }
		}
		try {
			socket.send(message)
		} catch {
			await this.forgetSession(sessionId)
			return { delivered: false, reason: 'session_not_connected' as const }
		}
		return { delivered: true as const }
	}

	private async emitToSession(
		sessionId: string,
		data: unknown,
	): Promise<PackageRealtimeEmitResult> {
		const message = serializeOutboundMessage(data)
		const session = this.stateSnapshot.sessions[sessionId]
		if (
			session &&
			isPublicAccess(session.access) &&
			outboundByteLength(message) > anonymousRealtimeLimits.maxPayloadBytes
		) {
			return { delivered: false, reason: 'payload_too_large' }
		}
		return await this.sendToSession(sessionId, message)
	}

	private async broadcast(input: {
		facet?: string | null
		topic?: string | null
		data: unknown
	}): Promise<PackageRealtimeBroadcastResult> {
		const sessions = this.listSessions({
			facet: input.facet,
			topic: input.topic,
		})
		const message = serializeOutboundMessage(input.data)
		// Decided once per broadcast: every public socket gets it or none do.
		let publicAllowed: boolean | null = null
		let deliveredCount = 0
		let limitedCount = 0
		const sessionIds: Array<string> = []
		for (const output of sessions) {
			const session = this.stateSnapshot.sessions[output.session_id]
			if (session && isPublicAccess(session.access)) {
				publicAllowed ??=
					outboundByteLength(message) <=
						anonymousRealtimeLimits.maxPayloadBytes &&
					this.broadcastBucket.take()
				if (!publicAllowed) {
					limitedCount += 1
					continue
				}
			}
			const delivered = await this.sendToSession(output.session_id, message)
			if (delivered.delivered) {
				deliveredCount += 1
				sessionIds.push(output.session_id)
			}
		}
		return {
			deliveredCount,
			sessionIds,
			...(limitedCount > 0 ? { limitedCount } : {}),
		}
	}

	private async resolveRealtimeHookResult(input: {
		binding: PackageRealtimeBindingState
		payload: PackageRealtimeHookInput
		/** Approved commit a public socket's hooks must run at. */
		requiredCommit: string | null
	}) {
		// The build input (including its caller identity) outlives a single
		// event, so re-check suspension per hook; the resolver's short cache
		// keeps this off the D1 hot path.
		await resolveBackgroundMcpUser(this.env.APP_DB, input.binding.userId)
		let visitNonce: string | null = null
		try {
			const appWorker = await this.getPackageAppWorker(
				input.binding,
				input.requiredCommit,
			)
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
			await this.persistSession(session)
		}
	}

	private socketCount(tag: string) {
		return this.ctx.getWebSockets(tag).length
	}

	/** Per-app and per-IP caps, checked before a public socket is accepted. */
	private admitPublicSocket(ipHash: string) {
		if (
			this.socketCount(publicSocketTag) >= anonymousRealtimeLimits.socketsPerApp
		) {
			return publicConnectRefusal(
				'This app has reached its limit of anonymous realtime connections. Try again later.',
				60,
			)
		}
		if (
			this.socketCount(ipTag(ipHash)) >= anonymousRealtimeLimits.socketsPerIp
		) {
			return publicConnectRefusal(
				'Too many realtime connections to this app from your network.',
			)
		}
		const now = Date.now()
		const recent = (this.connectsByIp.get(ipHash) ?? []).filter(
			(at) => now - at < connectWindowMs,
		)
		if (recent.length >= anonymousRealtimeLimits.connectsPerIpPerMinute) {
			this.connectsByIp.set(ipHash, recent)
			return publicConnectRefusal(
				'Too many realtime connection attempts from your network. Try again in a minute.',
				60,
			)
		}
		recent.push(now)
		this.connectsByIp.delete(ipHash)
		this.connectsByIp.set(ipHash, recent)
		if (this.connectsByIp.size > maxTrackedConnectIps) {
			const oldest = this.connectsByIp.keys().next().value
			if (oldest !== undefined) this.connectsByIp.delete(oldest)
		}
		return null
	}

	private sessionForSocket(ws: WebSocket) {
		const sessionId = this.loadSessionId(ws)
		return sessionId ? (this.stateSnapshot.sessions[sessionId] ?? null) : null
	}

	/**
	 * Close public sockets past the session cap, or whose approved commit is
	 * no longer what the app serves to public visitors (republished without
	 * approval, opted out, or no longer internet-visible).
	 */
	async alarm() {
		const binding = this.stateSnapshot.binding
		if (!binding) return
		const sockets = this.ctx.getWebSockets(publicSocketTag)
		if (sockets.length === 0) return
		this.publicAccessLookup = null
		const commit = await this.resolvePublicAccessCommit(binding).then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => {
				console.warn('package-realtime-access-recheck-failed', error)
				return { ok: false as const }
			},
		)
		const now = Date.now()
		for (const ws of sockets) {
			const session = this.sessionForSocket(ws)
			if (!session) continue
			if (
				now - Date.parse(session.connectedAt) >=
				anonymousRealtimeLimits.maxSessionMs
			) {
				closeSocket(ws, 1001, 'max-session-duration')
			} else if (commit.ok && commit.value !== session.approvedCommit) {
				closeSocket(ws, 1012, 'app-updated')
			}
		}
		await this.scheduleAccessAlarm()
	}

	private async scheduleAccessAlarm() {
		const sockets = this.ctx.getWebSockets(publicSocketTag)
		if (sockets.length === 0) return
		const now = Date.now()
		let next = now + anonymousRealtimeLimits.accessRecheckMs
		for (const ws of sockets) {
			const session = this.sessionForSocket(ws)
			if (!session) continue
			next = Math.min(
				next,
				Date.parse(session.connectedAt) + anonymousRealtimeLimits.maxSessionMs,
			)
		}
		next = Math.max(next, now + 1_000)
		const current = await this.ctx.storage.getAlarm()
		if (current === null || current > next) {
			await this.ctx.storage.setAlarm(next)
		}
	}

	private async handleConnectRequest(payload: PackageRealtimeConnectPayload) {
		await this.initializeBinding(payload.binding)
		const access = payload.access ?? 'member'
		const isPublic = isPublicAccess(access)
		const approvedCommit = isPublic ? (payload.approvedCommit ?? null) : null
		const facet = buildFacetName(payload.facet)
		const ipHash = pickString(payload.ipHash) ?? 'unknown'
		if (isPublic) {
			if (!approvedCommit) {
				return new Response('Public realtime needs an approved commit.', {
					status: 403,
				})
			}
			if (facet.length > maxPublicFacetLength) {
				return new Response('Realtime facet name is too long.', {
					status: 400,
				})
			}
			const refusal = this.admitPublicSocket(ipHash)
			if (refusal) return refusal
		}
		const pair = new WebSocketPair()
		const sockets = Object.values(pair)
		const client = sockets[0]
		const server = sockets[1]
		if (!client || !server) {
			throw new Error('Failed to create WebSocket pair.')
		}
		const sessionId = crypto.randomUUID()
		const now = new Date().toISOString()
		const attachment: PackageRealtimeSocketAttachment = {
			v: 2,
			id: sessionId,
			facet,
			connectedAt: now,
			access,
			visitor: payload.visitor ?? null,
			approvedCommit,
		}
		const tags = [sessionTag(sessionId), facetTag(facet)]
		if (isPublic) tags.push(publicSocketTag, ipTag(ipHash))
		this.ctx.acceptWebSocket(server, tags)
		this.stashSession(server, attachment)
		const session: PersistedPackageRealtimeSession = {
			...attachment,
			topics: [],
			lastSeenAt: now,
		}
		this.stateSnapshot.sessions[sessionId] = session
		if (isPublic) await this.scheduleAccessAlarm()
		// Receive-only sockets never run app code: no connect hook either.
		if (access === 'receive') {
			return new Response(null, { status: 101, webSocket: client })
		}
		try {
			const actions = await this.resolveRealtimeHookResult({
				binding: payload.binding,
				requiredCommit: approvedCommit,
				payload: {
					event: 'connect',
					facet,
					visitor: session.visitor,
					session: createSessionRecord(session),
					request: payload.request,
				},
			})
			await this.applyHookActions(sessionId, actions)
		} catch (error) {
			await this.forgetSession(sessionId)
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
			if (error instanceof PackageRealtimePinMismatchError) {
				closeSocket(server, 1012, 'app-updated')
				return new Response(error.message, { status: 403 })
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
		if (isPublicAccess(session.access)) {
			const refusal = await this.checkPublicInbound(
				ws,
				binding,
				session,
				message,
			)
			if (refusal) {
				closeSocket(ws, refusal.code, refusal.reason)
				return
			}
		}
		session.lastSeenAt = new Date().toISOString()
		let actions: Array<PackageRealtimeAction>
		try {
			actions = await this.resolveRealtimeHookResult({
				binding,
				requiredCommit: session.approvedCommit,
				payload: {
					event: 'message',
					facet: session.facet,
					visitor: session.visitor,
					session: createSessionRecord(session),
					message: decodeInboundMessage(message),
				},
			})
		} catch (error) {
			if (error instanceof PackageRealtimePinMismatchError) {
				closeSocket(ws, 1012, 'app-updated')
				return
			}
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

	/** Why a public socket's inbound frame closes it, or null to deliver it. */
	private async checkPublicInbound(
		ws: WebSocket,
		binding: PackageRealtimeBindingState,
		session: PersistedPackageRealtimeSession,
		message: string | ArrayBuffer,
	) {
		if (session.access === 'receive') {
			return { code: 1008, reason: 'receive-only' }
		}
		if (
			Date.now() - Date.parse(session.connectedAt) >=
			anonymousRealtimeLimits.maxSessionMs
		) {
			return { code: 1001, reason: 'max-session-duration' }
		}
		if (payloadByteLength(message) > anonymousRealtimeLimits.maxPayloadBytes) {
			return { code: 1009, reason: 'message-too-big' }
		}
		let bucket = this.inboundBuckets.get(ws)
		if (!bucket) {
			bucket = new RateBucket(
				anonymousRealtimeLimits.inboundMessagesPerSecond,
				anonymousRealtimeLimits.inboundMessageBurst,
			)
			this.inboundBuckets.set(ws, bucket)
		}
		if (!bucket.take()) return { code: 1008, reason: 'rate-limited' }
		if (!(await this.publicAccessAllowed(binding, session))) {
			return { code: 1012, reason: 'app-updated' }
		}
		return null
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
			closeSocket(socket, code, reason)
		}
	}

	private recordSessionUsage(
		binding: PackageRealtimeBindingState,
		session: PersistedPackageRealtimeSession,
	) {
		// Owner-billed like every public-app unit (ADR 0095); no credit debit.
		const visitorUserId = session.visitor?.userId ?? ''
		this.ctx.waitUntil(
			recordUsage(this.env, {
				userId: binding.userId,
				eventType: 'realtime_session',
				entityId: session.id,
				durationMs: Math.max(0, Date.now() - Date.parse(session.connectedAt)),
				outcome: 'success',
				packageId: binding.packageId,
				packageAppVisitorUserId: visitorUserId,
				actorUserId: visitorUserId,
			}),
		)
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
		await this.forgetSession(sessionId)
		if (!session || !binding) return
		this.recordSessionUsage(binding, session)
		if (session.access === 'receive') return
		if (
			isPublicAccess(session.access) &&
			!(await this.publicAccessAllowed(binding, session).catch(() => false))
		) {
			return
		}
		let actions: Array<PackageRealtimeAction>
		try {
			actions = await this.resolveRealtimeHookResult({
				binding,
				requiredCommit: session.approvedCommit,
				payload: {
					event: 'disconnect',
					facet: session.facet,
					visitor: session.visitor,
					session: createSessionRecord(session),
					close,
				},
			})
		} catch (error) {
			if (
				isAccountSuspendedError(error) ||
				isComputeOverageLimitError(error) ||
				error instanceof PackageRealtimePinMismatchError
			) {
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
		async connect(
			request: Request,
			facet?: string | null,
			options?: PackageRealtimeConnectOptions,
		) {
			const payload: PackageRealtimeConnectPayload = {
				...options,
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
