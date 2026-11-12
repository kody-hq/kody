import { allStorageRows } from './storage-pages.ts'
import { isCredentialInvalidatedByStoredPasswordChange } from '#worker/password-change-lockout.ts'
import { DurableObject } from 'cloudflare:workers'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import * as Y from 'yjs'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { fileStoreRpc } from './client.ts'
import {
	fileCollaborationAccess,
	type FileAccessLookups,
} from './collaboration-access.ts'
import { commentAnchorExists } from '#universal/comment-anchor.ts'
import { CommentLedger } from './comment-ledger.ts'
import {
	createCollaborativeDocument,
	collaborativeContent,
	replaceCollaborativeContent,
} from '#universal/collaborative-document.ts'
import {
	collaborationLimits,
	decodeCollaborationBytes,
	encodeCollaborationBytes,
	roomClientMessageSchema,
	type CollaborationActor,
	type FilePresence,
	type RecentParticipant,
	type RoomSnapshot,
	type RoomServerMessage,
	type CommentCommand,
} from '#universal/file-collaboration.ts'
import type { FileMetadata } from '#universal/files.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'

type RoomState = {
	ownerId: OwnerId
	fileId: string
	mediaType: string
	state: Uint8Array
	revisionId: string
	checkpointId: string
	sequence: number
	updatedAt: string
	author: string
	actorId: string
	profileId: string | null
	hash: string
	bytes: number
}
export type FileSessionProof = { issuedAt: number; expiresAt: number }
type Attachment = {
	request: RequestContext
	presence: FilePresence
	session: FileSessionProof
}
type SessionAccess = Awaited<ReturnType<typeof fileCollaborationAccess>>
/**
 * Access resolved during one handler run, keyed by session. Sockets from the
 * same session share one lookup; the next handler run resolves again, so a
 * revoked grant still closes its sockets on the next broadcast.
 */
type AccessPass = Map<string, Promise<SessionAccess>>
type LiveUserRow = {
	stable_user_id: string
	password_changed_at: string | null
	suspended_at: string | null
	deleting_at: string | null
}
/**
 * Person/org lookups (liveness, org binding, collaboration flag) shared by every
 * session checked in one handler run. Scoped to the pass so it never outlives it.
 */
const passLookups = new WeakMap<AccessPass, FileAccessLookups>()
function lookupsFor(pass: AccessPass) {
	let lookups = passLookups.get(pass)
	if (!lookups) {
		lookups = new Map()
		passLookups.set(pass, lookups)
	}
	return lookups
}
const liveKey = (userId: string) => `live:${userId}`
const sessionKey = (attachment: Attachment) =>
	JSON.stringify([attachment.request, attachment.session.issuedAt])
function assertUnexpired(session: FileSessionProof | undefined) {
	if (!session?.expiresAt || session.expiresAt <= Date.now())
		throw new Error('Session expired.')
}
const unavailableCode = (error: unknown) =>
	error instanceof Error && error.message === 'Session expired.' ? 4000 : 4003
export class FileRoom extends DurableObject<Env> {
	private ledger: CommentLedger
	private agentPresence = new Map<string, FilePresence>()
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.ledger = new CommentLedger(ctx.storage)
	}
	private serial<T>(run: () => Promise<T>) {
		const result = this.ctx.blockConcurrencyWhile(async () => {
			try {
				return { ok: true as const, value: await run() }
			} catch (error) {
				return {
					ok: false as const,
					message:
						error instanceof Error ? error.message : 'File operation failed.',
				}
			}
		})
		return result.then((result) => {
			if (!result.ok) throw new Error(result.message)
			return result.value
		})
	}
	private async bound(request: RequestContext, fileId: string) {
		const verified = await fileCollaborationAccess(this.env, request, fileId)
		if (!verified.access.read) throw new Error('File access was revoked.')
		const store = fileStoreRpc(this.env, request.org.id),
			file = await store.metadata(request.org.id, fileId)
		if (!file?.revisionId || file.trashedAt) throw new Error('File not found.')
		let state = await this.ctx.storage.get<RoomState>('room')
		if (state && (state.ownerId !== request.org.id || state.fileId !== fileId))
			throw new Error('File room scope mismatch.')
		if (!state) {
			const original =
				file.encoding === 'base64'
					? { ...file, content: '' }
					: await store.read(request.org.id, fileId)
			const checkpoint = await store.readCollaborationCheckpoint(
				request.org.id,
				fileId,
			)
			const doc = checkpoint
				? new Y.Doc()
				: createCollaborativeDocument(
						original.encoding === 'base64' ? '' : original.content,
						file.mediaType,
					)
			if (checkpoint) Y.applyUpdate(doc, checkpoint)
			const revision = file.revisions.find((r) => r.id === file.revisionId)!
			state = {
				ownerId: request.org.id,
				fileId,
				mediaType: file.mediaType,
				state: Y.encodeStateAsUpdate(doc),
				revisionId: file.revisionId,
				checkpointId: file.revisionId,
				sequence: 0,
				updatedAt: file.updatedAt,
				author: revision.author,
				actorId: request.actor!.userId,
				profileId: request.credential.profileId ?? null,
				hash: revision.sha256,
				bytes: revision.bytes,
			}
			doc.destroy()
			await store.activateCollaboration(request.org.id, fileId)
			await this.ctx.storage.put('room', state)
		}
		state.sequence = Math.max(
			state.sequence,
			(await this.ctx.storage.get<number>('sequence')) ?? 0,
		)
		if (file.encoding === 'base64' && state.checkpointId !== file.revisionId) {
			const revision = file.revisions.find((r) => r.id === file.revisionId)!
			state = {
				...state,
				revisionId: file.revisionId,
				checkpointId: file.revisionId,
				bytes: revision.bytes,
				hash: revision.sha256,
				updatedAt: file.updatedAt,
				sequence: state.sequence + 1,
			}
			await this.ledger.refreshAnchors((anchor) =>
				anchor.kind === 'audio' || anchor.kind === 'image'
					? anchor.revisionId === file.revisionId
					: undefined,
			)
			await this.ctx.storage.put({ room: state, sequence: state.sequence })
		}
		return { ...verified, state, file, store }
	}
	private metadata(file: FileMetadata, state: RoomState): FileMetadata {
		return {
			...file,
			headVersion: state.revisionId,
			headBytes: state.bytes,
			updatedAt: state.updatedAt,
		}
	}

	private content(state: RoomState) {
		const doc = new Y.Doc()
		try {
			Y.applyUpdate(doc, state.state)
			return collaborativeContent(doc, state.mediaType)
		} finally {
			doc.destroy()
		}
	}
	async read(request: RequestContext, fileId: string) {
		return this.serial(async () => {
			const { state, file, actor } = await this.bound(request, fileId)
			await this.touch(actor, 'viewed')
			return { ...this.metadata(file, state), content: this.content(state) }
		})
	}
	async noteActivity(
		request: RequestContext,
		fileId: string,
		action: 'viewed' | 'edited',
	) {
		return this.serial(async () => {
			const { actor, access, state } = await this.bound(request, fileId)
			if (action === 'edited' && !access.write)
				throw new Error('Write access is required.')
			await this.touch(actor, action)
			const pass: AccessPass = new Map()
			if (action === 'edited')
				await this.broadcast(
					{
						type: 'file',
						revisionId: state.revisionId,
						sequence: state.sequence,
					},
					pass,
				)
			await this.broadcastPresence(pass)
		})
	}
	private async recent() {
		const now = Date.now()
		const rows = await this.ctx.storage.list<RecentParticipant>({
			prefix: 'recent:',
		})
		return Array.from(rows.values())
			.filter((p) => now - p.lastSeen < collaborationLimits.recentMs)
			.sort((a, b) => b.lastSeen - a.lastSeen)
			.slice(0, 64)
	}
	private presence() {
		const now = Date.now()
		const connected = this.ctx
			.getWebSockets()
			.filter((ws) => ws.readyState === WebSocket.OPEN)
			.map((ws) => (ws.deserializeAttachment() as Attachment)?.presence)
			.filter(
				(p): p is FilePresence =>
					!!p &&
					(p.actor.kind !== 'agent' ||
						now - p.lastSeen < collaborationLimits.agentPresenceMs),
			)
		for (const [id, presence] of this.agentPresence)
			if (now - presence.lastSeen >= collaborationLimits.agentPresenceMs)
				this.agentPresence.delete(id)
		return [...connected, ...this.agentPresence.values()]
	}
	async setAgentPresence(
		request: RequestContext,
		fileId: string,
		presence: Pick<FilePresence, 'state' | 'blockId' | 'selection'> | null,
	) {
		return this.serial(async () => {
			const { actor, access } = await this.bound(request, fileId)
			if (actor.kind !== 'agent')
				throw new Error('Agent credentials are required.')
			if (presence?.state === 'editing' && !access.write)
				throw new Error('File edit access is required.')
			const previous = this.agentPresence.get(actor.id)
			if (presence) {
				this.agentPresence.set(actor.id, {
					...presence,
					sessionId: previous?.sessionId ?? crypto.randomUUID(),
					actor,
					lastSeen: Date.now(),
				})
				await this.touch(
					actor,
					presence.state === 'editing' ? 'edited' : 'viewed',
				)
				await this.schedule()
			} else this.agentPresence.delete(actor.id)
			await this.broadcastPresence()
			return { ok: true as const }
		})
	}

	private async touch(
		actor: CollaborationActor,
		lastAction: RecentParticipant['lastAction'],
	) {
		const previous = await this.ctx.storage.get<RecentParticipant>(
			`recent:${actor.id}`,
		)
		if (
			!previous ||
			Date.now() - previous.lastSeen >
				(actor.kind === 'agent' ? 5000 : 30_000) ||
			lastAction !== previous.lastAction
		)
			await this.ctx.storage.put(`recent:${actor.id}`, {
				id: actor.id,
				actor,
				lastSeen: Date.now(),
				lastAction,
				...(actor.kind === 'agent' ? { activeUntil: Date.now() + 15_000 } : {}),
			} satisfies RecentParticipant)
	}
	async snapshot(request: RequestContext, fileId: string, cursor?: string) {
		return this.serial(async () => {
			const { state, actor, access } = await this.bound(request, fileId)
			const comments = await this.ledger.list(cursor)
			return {
				...comments,
				notifications: await this.ledger.notifications(actor.id),
				state: encodeCollaborationBytes(state.state),
				revisionId: state.revisionId,
				sequence: state.sequence,
				actor,
				access,
				presence: this.presence(),
				recent: await this.recent(),
			}
		})
	}
	async threadComments(
		request: RequestContext,
		fileId: string,
		threadId: string,
		cursor?: string,
	) {
		return this.serial(async () => {
			await this.bound(request, fileId)
			return this.ledger.listComments(threadId, cursor)
		})
	}

	async issueTicket(
		request: RequestContext,
		fileId: string,
		sessionId: string,
		session: FileSessionProof,
	) {
		return this.serial(async () => {
			await this.bound(request, fileId)
			const ticket = crypto.randomUUID()
			await this.schedule()
			await this.ctx.storage.put(`ticket:${ticket}`, {
				request,
				fileId,
				sessionId,
				session,
				expiresAt: Date.now() + 30_000,
			})
			return ticket
		})
	}
	async fetch(request: Request) {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
			return new Response('Not found', { status: 404 })
		const key = `ticket:${new URL(request.url).searchParams.get('ticket') ?? ''}`
		const ticket = await this.ctx.storage.transaction(async (tx) => {
			const value = await tx.get<{
				request: RequestContext
				fileId: string
				sessionId: string
				session: FileSessionProof
				expiresAt: number
			}>(key)
			await tx.delete(key)
			return value
		})
		if (!ticket || ticket.expiresAt < Date.now())
			return new Response('Connection expired', { status: 403 })
		return this.openSession(
			ticket.request,
			ticket.fileId,
			ticket.sessionId,
			ticket.session,
		)
	}

	async openSession(
		request: RequestContext,
		fileId: string,
		sessionId: string,
		session: FileSessionProof,
	) {
		return this.serial(async () => {
			await this.assertSession(request, session)
			const { state, actor, access } = await this.bound(request, fileId)
			if (this.ctx.getWebSockets().length >= collaborationLimits.participants)
				throw new Error('This file has too many active sessions.')
			const pair = new WebSocketPair(),
				client = pair[0],
				server = pair[1]
			const presence: FilePresence = {
				sessionId,
				actor,
				lastSeen: Date.now(),
				state: 'viewing',
			}
			this.ctx.acceptWebSocket(server)
			server.serializeAttachment({
				request,
				presence,
				session: {
					...session,
					expiresAt: Math.min(session.expiresAt, Date.now() + 15 * 60_000),
				},
			} satisfies Attachment)
			await this.touch(actor, 'viewed')
			const comments = await this.ledger.list()
			const snapshot: RoomSnapshot = {
				...comments,
				notifications: await this.ledger.notifications(actor.id),
				state: encodeCollaborationBytes(state.state),
				revisionId: state.revisionId,
				sequence: state.sequence,
				actor,
				access,
				presence: this.presence(),
				recent: await this.recent(),
			}
			server.send(
				JSON.stringify({
					type: 'snapshot',
					snapshot,
				} satisfies RoomServerMessage),
			)
			await this.broadcastPresence()
			await this.schedule()
			return new Response(null, { status: 101, webSocket: client })
		})
	}
	private async schedule() {
		const current = await this.ctx.storage.getAlarm()
		if (current === null || current > Date.now() + 5000)
			await this.ctx.storage.setAlarm(Date.now() + 5000)
	}
	private async assertSession(
		request: RequestContext,
		session: FileSessionProof,
	) {
		assertUnexpired(session)
		await this.assertSessionLive(request, session.issuedAt)
	}
	private loadLiveUser(userId: string) {
		return this.env.APP_DB.prepare(
			'SELECT stable_user_id, password_changed_at, suspended_at, deleting_at FROM users WHERE stable_user_id = ? AND deleted_at IS NULL',
		)
			.bind(userId)
			.first<LiveUserRow>()
	}
	/** Loads liveness rows for every not-yet-cached person in one query. */
	private prefetchLiveUsers(
		userIds: Array<string>,
		lookups: FileAccessLookups,
	) {
		const missing = [...new Set(userIds)].filter(
			(id) => !lookups.has(liveKey(id)),
		)
		if (!missing.length) return
		const rows = this.env.APP_DB.prepare(
			`SELECT stable_user_id, password_changed_at, suspended_at, deleting_at FROM users WHERE stable_user_id IN (${missing.map(() => '?').join(', ')}) AND deleted_at IS NULL`,
		)
			.bind(...missing)
			.all<LiveUserRow>()
			.then(
				(result) =>
					new Map(
						(result.results ?? []).map((row) => [row.stable_user_id, row]),
					),
			)
		for (const id of missing) {
			const row = rows.then((byId) => byId.get(id) ?? null)
			// Sockets that fail fast (e.g. expired) never await their row; a failed
			// batch still rejects for every socket that does, closing it as before.
			row.catch(() => {})
			lookups.set(liveKey(id), row)
		}
	}
	private async assertSessionLive(
		request: RequestContext,
		issuedAt: number,
		lookups?: FileAccessLookups,
	) {
		const userId = request.actor!.userId
		let lookup = lookups?.get(liveKey(userId)) as
			| Promise<LiveUserRow | null>
			| undefined
		if (!lookup) {
			lookup = this.loadLiveUser(userId)
			lookups?.set(liveKey(userId), lookup)
		}
		const person = await lookup
		if (
			!person ||
			person.suspended_at ||
			person.deleting_at ||
			isCredentialInvalidatedByStoredPasswordChange({
				issuedAtMs: issuedAt,
				storedPasswordChangedAt: person.password_changed_at,
			})
		)
			throw new Error('Session access was revoked.')
	}
	private async sessionAccess(
		attachment: Attachment,
		fileId: string,
		pass: AccessPass = new Map(),
	) {
		assertUnexpired(attachment.session)
		const key = sessionKey(attachment)
		let access = pass.get(key)
		if (!access) {
			access = this.resolveAccess(attachment, fileId, lookupsFor(pass))
			pass.set(key, access)
		}
		return access
	}
	private async resolveAccess(
		attachment: Attachment,
		fileId: string,
		lookups?: FileAccessLookups,
	) {
		await this.assertSessionLive(
			attachment.request,
			attachment.session.issuedAt,
			lookups,
		)
		return fileCollaborationAccess(
			this.env,
			attachment.request,
			fileId,
			lookups,
		)
	}
	/** Closes sockets that lost access and returns the rest with their actors. */
	private async readableSockets(fileId: string, pass: AccessPass) {
		const sockets = this.ctx.getWebSockets()
		const attachments = sockets.map(
			(ws) => ws.deserializeAttachment() as Attachment,
		)
		this.prefetchLiveUsers(
			attachments.flatMap((a) =>
				a?.request?.actor?.userId ? [a.request.actor.userId] : [],
			),
			lookupsFor(pass),
		)
		const outcomes = await Promise.allSettled(
			attachments.map(async (attachment) =>
				this.sessionAccess(attachment, fileId, pass),
			),
		)
		const readable: Array<{ ws: WebSocket; actor: CollaborationActor }> = []
		sockets.forEach((ws, index) => {
			const outcome = outcomes[index]!
			if (outcome.status === 'rejected')
				ws.close(unavailableCode(outcome.reason), 'Session unavailable')
			else if (!outcome.value.access.read) ws.close(4003, 'Access revoked')
			else readable.push({ ws, actor: outcome.value.actor })
		})
		return readable
	}
	private send(ws: WebSocket, payload: string) {
		try {
			ws.send(payload)
		} catch (error) {
			ws.close(unavailableCode(error), 'Session unavailable')
		}
	}

	private async broadcast(
		message: RoomServerMessage,
		pass: AccessPass = new Map(),
	) {
		const state = await this.ctx.storage.get<RoomState>('room')
		if (!state) return
		const payload = JSON.stringify(message)
		for (const { ws } of await this.readableSockets(state.fileId, pass))
			this.send(ws, payload)
	}
	private async broadcastNotifications(pass: AccessPass = new Map()) {
		const state = await this.ctx.storage.get<RoomState>('room')
		if (!state) return
		await Promise.all(
			(await this.readableSockets(state.fileId, pass)).map(
				async ({ ws, actor }) => {
					try {
						this.send(
							ws,
							JSON.stringify({
								type: 'notifications',
								notifications: await this.ledger.notifications(actor.id),
							} satisfies RoomServerMessage),
						)
					} catch {
						ws.close(4003, 'Session unavailable')
					}
				},
			),
		)
	}

	private async broadcastPresence(pass: AccessPass = new Map()) {
		await this.broadcast(
			{
				type: 'presence',
				presence: this.presence(),
				recent: await this.recent(),
			},
			pass,
		)
	}
	private async accept(
		state: RoomState,
		candidate: Y.Doc,
		operationId: string,
		actor: CollaborationActor,
		fingerprint: string,
		revisionId: string = crypto.randomUUID(),
		requireCheckpoint = false,
	) {
		const content = collaborativeContent(candidate, state.mediaType),
			bytes = new TextEncoder().encode(content)
		const update = Y.encodeStateAsUpdate(candidate)
		if (
			bytes.byteLength > 65536 ||
			update.byteLength > collaborationLimits.stateBytes
		)
			throw new Error('This shared document is too large.')
		const next = {
			...state,
			state: update,
			revisionId,
			sequence: state.sequence + 1,
			updatedAt: new Date().toISOString(),
			author: actor.name,
			actorId: actor.personId,
			profileId: actor.profileId,
			hash: await sha256Hex(bytes),
			bytes: bytes.byteLength,
		}
		await fileStoreRpc(this.env, state.ownerId).reserveCollaboration({
			ownerId: state.ownerId,
			fileId: state.fileId,
			bytes: bytes.byteLength + update.byteLength,
			maxBytes: Number(this.env.FILES_INCLUDED_BYTES ?? 0),
		})
		await this.ctx.storage.transaction(async (tx) => {
			await tx.put({
				room: next,
				sequence: next.sequence,
				[`update-receipt:${operationId}`]: {
					fingerprint,
					sequence: next.sequence,
					revisionId: next.revisionId,
				},
				'checkpoint-outbox': { revisionId: next.revisionId },
				...(requireCheckpoint ? { 'must-checkpoint': next.revisionId } : {}),
			})
		})
		const anchorsChanged = await this.ledger.refreshAnchors((anchor) =>
			commentAnchorExists(candidate, state.mediaType, anchor, next.revisionId),
		)
		if (anchorsChanged) {
			const comments = await this.ledger.list()
			await this.broadcast({
				type: 'comments',
				threads: comments.threads,
				comments: comments.comments,
				sequence: next.sequence,
			})
		}
		await this.touch(actor, 'edited')
		await this.schedule()
		const previous = new Y.Doc()
		Y.applyUpdate(previous, state.state)
		const difference = Y.encodeStateAsUpdate(
			candidate,
			Y.encodeStateVector(previous),
		)
		previous.destroy()
		await this.broadcast({
			type: 'update',
			update: encodeCollaborationBytes(difference),
			sequence: next.sequence,
			revisionId: next.revisionId,
		})
		return next
	}
	async update(
		request: RequestContext,
		fileId: string,
		operationId: string,
		update: string,
	) {
		return this.serial(async () => {
			if (await this.ctx.storage.get('must-checkpoint')) await this.checkpoint()
			const { state, actor, access, file } = await this.bound(request, fileId)
			if (file.encoding === 'base64')
				throw new Error('This file uses revision-safe replacement.')
			if (!access.write) throw new Error('File edit access is required.')
			const fingerprint = await sha256Hex(
				new TextEncoder().encode(JSON.stringify({ actor: actor.id, update })),
			)
			const receipt = await this.ctx.storage.get<{
				fingerprint: string
				sequence: number
				revisionId: string
			}>(`update-receipt:${operationId}`)
			if (receipt) {
				if (receipt.fingerprint !== fingerprint)
					throw new Error('Operation id was already used.')
				return { sequence: receipt.sequence, revisionId: receipt.revisionId }
			}
			const bytes = decodeCollaborationBytes(update)
			if (bytes.byteLength > collaborationLimits.updateBytes)
				throw new Error('Update is too large.')
			const candidate = new Y.Doc()
			try {
				Y.applyUpdate(candidate, state.state)
				Y.applyUpdate(candidate, bytes)
				const next = await this.accept(
					state,
					candidate,
					operationId,
					actor,
					fingerprint,
				)
				return { sequence: next.sequence, revisionId: next.revisionId }
			} finally {
				candidate.destroy()
			}
		})
	}
	async write(
		request: RequestContext,
		fileId: string,
		writeId: string,
		baseRevisionId: string,
		content: string,
	) {
		return this.serial(async () => {
			if (await this.ctx.storage.get('must-checkpoint')) await this.checkpoint()
			const { state, file, actor, access } = await this.bound(request, fileId)
			if (file.encoding === 'base64')
				throw new Error('This file uses revision-safe replacement.')
			if (!access.write) throw new Error('File edit access is required.')
			const fingerprint = await sha256Hex(
				new TextEncoder().encode(
					JSON.stringify({ actor: actor.id, baseRevisionId, content }),
				),
			)
			const receipt = await this.ctx.storage.get<{
				revisionId: string
				fingerprint: string
			}>(`update-receipt:${writeId}`)
			if (receipt && receipt.fingerprint !== fingerprint)
				throw new Error('Operation id was already used.')
			if (receipt)
				return {
					ok: true as const,
					file: await fileStoreRpc(this.env, state.ownerId).read(
						state.ownerId,
						fileId,
						receipt.revisionId,
					),
				}
			if (baseRevisionId !== state.revisionId)
				return {
					ok: false as const,
					code: 'revision_conflict' as const,
					current_revision_id: state.revisionId,
					current: this.content(state),
					proposed: content,
				}
			const doc = new Y.Doc()
			try {
				Y.applyUpdate(doc, state.state)
				replaceCollaborativeContent(doc, state.mediaType, content)
				const next = await this.accept(
					state,
					doc,
					writeId,
					actor,
					fingerprint,
					writeId,
					true,
				)
				await this.checkpoint()
				return {
					ok: true as const,
					file: {
						...this.metadata(
							(await fileStoreRpc(this.env, state.ownerId).metadata(
								state.ownerId,
								fileId,
							))!,
							{ ...next, checkpointId: next.revisionId },
						),
						content,
					},
				}
			} finally {
				doc.destroy()
			}
		})
	}
	async comment(
		request: RequestContext,
		fileId: string,
		command: CommentCommand,
	) {
		return this.serial(async () => {
			let { state, actor, access } = await this.bound(request, fileId)
			const validateAnchor = () => {
				if (command.kind !== 'create') return
				const document = new Y.Doc()
				try {
					Y.applyUpdate(document, state.state)
					if (
						!commentAnchorExists(
							document,
							state.mediaType,
							command.anchor,
							state.revisionId,
						)
					)
						throw new Error('The selected content is no longer available.')
				} finally {
					document.destroy()
				}
			}
			if (command.kind === 'create') {
				await this.checkpoint()
				state = (await this.ctx.storage.get<RoomState>('room'))!
			}
			const result = await this.ledger.command({
				command,
				actor,
				access,
				fileId,
				revisionId: state.revisionId,
				sequence: state.sequence,
				validateAnchor,
			})
			if (!result.replayed) {
				await this.ctx.storage.put('room', {
					...state,
					sequence: result.sequence,
				})
				if (command.kind !== 'read') await this.touch(actor, 'commented')
				await this.schedule()
			}

			const page = await this.ledger.list()
			const comments = {
				...page,
				threads: [
					...new Map(
						[...page.threads, ...(result.thread ? [result.thread] : [])].map(
							(thread) => [thread.id, thread],
						),
					).values(),
				],
				comments: [
					...new Map(
						[...page.comments, ...(result.comment ? [result.comment] : [])].map(
							(comment) => [comment.id, comment],
						),
					).values(),
				],
			}
			await this.broadcast({
				type: 'comments',
				threads: comments.threads,
				comments: comments.comments,
				commentCursors: comments.commentCursors,
				sequence: result.sequence,
			})
			if (command.kind === 'read') await this.broadcastNotifications()
			return { ...result, ...comments }
		})
	}
	async flushForRead(request: RequestContext, fileId: string) {
		return this.serial(async () => {
			await this.bound(request, fileId)
			await this.checkpoint()
		})
	}
	/** Called only after a server-side public grant check. No comments or people escape this boundary. */
	async readPublished(ownerId: OwnerId, fileId: string) {
		return this.serial(async () => {
			const state = await this.ctx.storage.get<RoomState>('room')
			if (!state) return fileStoreRpc(this.env, ownerId).read(ownerId, fileId)
			if (state.ownerId !== ownerId || state.fileId !== fileId)
				throw new Error('File room scope mismatch.')
			await this.checkpoint()
			const file = await fileStoreRpc(this.env, ownerId).metadata(
				ownerId,
				fileId,
			)
			if (!file || file.trashedAt) throw new Error('File not found.')
			return { ...this.metadata(file, state), content: this.content(state) }
		})
	}

	async exportMetadata(ownerId: OwnerId, fileId: string) {
		return this.serial(async () => {
			const state = await this.ctx.storage.get<RoomState>('room')
			if (!state) return null
			if (state.ownerId !== ownerId || state.fileId !== fileId)
				throw new Error('File room scope mismatch.')
			const rows = await allStorageRows(this.ctx.storage, '')
			return {
				fileId,
				room: { ...state, state: encodeCollaborationBytes(state.state) },
				records: Array.from(rows.entries()).filter(
					([key]) => !key.startsWith('ticket:') && key !== 'room',
				),
			}
		})
	}
	async purge(ownerId: OwnerId, fileId: string) {
		return this.serial(async () => {
			const state = await this.ctx.storage.get<RoomState>('room')
			if (state && (state.ownerId !== ownerId || state.fileId !== fileId))
				throw new Error('File room scope mismatch.')
			for (const ws of this.ctx.getWebSockets()) ws.close(4003, 'File removed')
			await this.ctx.storage.deleteAll()
			await this.ctx.storage.deleteAlarm()
		})
	}

	async checkpoint() {
		const state = await this.ctx.storage.get<RoomState>('room')
		if (!state || state.checkpointId === state.revisionId) return
		return withAccountWriteLease({
			db: this.env.APP_DB,
			env: this.env,
			stableUserId: state.ownerId,
			holder: 'file-checkpoint',
			write: () => this.persistCheckpoint(),
		})
	}
	private async persistCheckpoint() {
		const state = await this.ctx.storage.get<RoomState>('room')
		if (!state || state.checkpointId === state.revisionId) return
		const store = fileStoreRpc(this.env, state.ownerId)
		const result = await store.write({
			ownerId: state.ownerId,
			fileId: state.fileId,
			writeId: state.revisionId,
			baseRevisionId: state.checkpointId,
			content: this.content(state),
			collaborationState: state.state,
			actorId: state.actorId,
			profileId: state.profileId,
			author: state.author,
			maxBytes: Number(this.env.FILES_INCLUDED_BYTES ?? 0),
		})
		if (!result.ok)
			throw new Error(
				'The file checkpoint changed outside its collaboration room.',
			)
		await this.ctx.storage.transaction(async (tx) => {
			await tx.put('room', { ...state, checkpointId: state.revisionId })
			await tx.delete('checkpoint-outbox')
			await tx.delete('must-checkpoint')
		})
		await store.releaseCollaboration(state.ownerId, state.fileId)
	}
	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
		const attachment = ws.deserializeAttachment() as Attachment
		let operationId: string | undefined
		try {
			if (typeof raw !== 'string' || raw.length > 700_000)
				throw new Error('Invalid collaboration message.')
			const message = roomClientMessageSchema.parse(JSON.parse(raw)),
				state = await this.ctx.storage.get<RoomState>('room')
			operationId =
				message.type === 'update'
					? message.operationId
					: message.type === 'comment'
						? message.command.operationId
						: undefined
			if (!state) throw new Error('File not found.')
			const pass: AccessPass = new Map()
			const { access } = await this.sessionAccess(
				attachment,
				state.fileId,
				pass,
			)
			if (!access.read) {
				ws.close(4003, 'Access revoked')
				return
			}
			if (message.type === 'update') {
				const receipt = await withAccountWriteLease({
					db: this.env.APP_DB,
					env: this.env,
					stableUserId: state.ownerId,
					holder: 'file-socket',
					write: () =>
						this.update(
							attachment.request,
							state.fileId,
							message.operationId,
							message.update,
						),
				})
				ws.send(
					JSON.stringify({
						type: 'ack',
						operationId: message.operationId,
						...receipt,
					} satisfies RoomServerMessage),
				)
			} else if (message.type === 'comment') {
				const receipt = await withAccountWriteLease({
					db: this.env.APP_DB,
					env: this.env,
					stableUserId: state.ownerId,
					holder: 'file-comment-socket',
					write: () =>
						this.comment(attachment.request, state.fileId, message.command),
				})
				const current = await this.ctx.storage.get<RoomState>('room')
				ws.send(
					JSON.stringify({
						type: 'ack',
						operationId: message.command.operationId,
						sequence: receipt.sequence,
						revisionId: current!.revisionId,
					} satisfies RoomServerMessage),
				)
			} else if (message.type === 'sync') {
				const doc = new Y.Doc()
				Y.applyUpdate(doc, state.state)
				ws.send(
					JSON.stringify({
						type: 'update',
						update: encodeCollaborationBytes(
							Y.encodeStateAsUpdate(
								doc,
								decodeCollaborationBytes(message.stateVector),
							),
						),
						sequence: state.sequence,
						revisionId: state.revisionId,
					} satisfies RoomServerMessage),
				)
				doc.destroy()
				const comments = await this.ledger.list()
				ws.send(
					JSON.stringify({
						type: 'comments',
						threads: comments.threads,
						comments: comments.comments,
						sequence: state.sequence,
					} satisfies RoomServerMessage),
				)
			} else {
				attachment.presence = {
					...attachment.presence,
					lastSeen: Date.now(),
					state:
						message.state === 'editing' && !access.write
							? 'viewing'
							: message.state,
					blockId: message.blockId,
					selection: message.selection,
				}
				ws.serializeAttachment(attachment)
				await this.touch(
					attachment.presence.actor,
					message.state === 'editing' ? 'edited' : 'viewed',
				)
				await this.broadcastPresence(pass)
			}
		} catch (error) {
			if (error instanceof Error && error.message === 'Session expired.') {
				ws.close(4000, 'Session expired')
				return
			}
			ws.send(
				JSON.stringify({
					type: 'error',
					operationId,
					code:
						error instanceof Error && /access|revoked/i.test(error.message)
							? 'forbidden'
							: 'invalid',
					message: error instanceof Error ? error.message : 'Could not sync.',
				} satisfies RoomServerMessage),
			)
		}
	}
	async webSocketClose(ws: WebSocket, code: number) {
		if (code === 1005 || code === 1006 || code === 1015) ws.close()
		else ws.close(code, 'Session closed')
		await this.broadcastPresence()
	}
	async webSocketError(ws: WebSocket) {
		ws.close(1011, 'Connection failed')
		await this.broadcastPresence()
	}
	async alarm() {
		await this.serial(async () => {
			await this.ledger.deliverNotifications(async (name) => {
				const user = await this.env.APP_DB.prepare(
					'SELECT stable_user_id FROM users WHERE username = ? AND deleted_at IS NULL',
				)
					.bind(name)
					.first<{ stable_user_id: string }>()
				return user?.stable_user_id ?? null
			})
			const pass: AccessPass = new Map()
			await this.broadcastNotifications(pass)
			const tickets = await this.ctx.storage.list<{ expiresAt: number }>({
				prefix: 'ticket:',
			})
			for (const [key, ticket] of tickets)
				if (ticket.expiresAt < Date.now()) await this.ctx.storage.delete(key)
			if (tickets.size) await this.schedule()
			try {
				await this.checkpoint()
			} catch {
				await this.schedule()
			}
			for (const ws of this.ctx.getWebSockets()) {
				const attachment = ws.deserializeAttachment() as Attachment
				if (
					attachment.presence.actor.kind === 'agent' &&
					Date.now() - attachment.presence.lastSeen >=
						collaborationLimits.agentPresenceMs
				)
					ws.close(4000, 'Session expired')
			}
			await this.broadcastPresence(pass)
			const expired = await this.ctx.storage.list<RecentParticipant>({
				prefix: 'recent:',
			})
			for (const [key, value] of expired)
				if (Date.now() - value.lastSeen > collaborationLimits.recentMs)
					await this.ctx.storage.delete(key)
			if (this.ctx.getWebSockets().length || this.agentPresence.size)
				await this.schedule()
		})
	}
}
export function fileRoomRpc(env: Env, ownerId: OwnerId, fileId: string) {
	const stub = env.FILE_ROOM.get(
		env.FILE_ROOM.idFromName(`${ownerId}:file:${fileId}:v1`),
	)
	const rpc = stub as unknown as Pick<
		FileRoom,
		| 'read'
		| 'noteActivity'
		| 'setAgentPresence'
		| 'readPublished'
		| 'threadComments'
		| 'snapshot'
		| 'issueTicket'
		| 'update'
		| 'write'
		| 'comment'
		| 'flushForRead'
		| 'exportMetadata'
		| 'purge'
	>
	return {
		setAgentPresence: (...args: Parameters<FileRoom['setAgentPresence']>) =>
			rpc.setAgentPresence(...args),
		noteActivity: (...args: Parameters<FileRoom['noteActivity']>) =>
			rpc.noteActivity(...args),
		read: (...args: Parameters<FileRoom['read']>) => rpc.read(...args),
		threadComments: (...args: Parameters<FileRoom['threadComments']>) =>
			rpc.threadComments(...args),
		readPublished: (...args: Parameters<FileRoom['readPublished']>) =>
			rpc.readPublished(...args),
		snapshot: (...args: Parameters<FileRoom['snapshot']>) =>
			rpc.snapshot(...args),
		update: (...args: Parameters<FileRoom['update']>) => rpc.update(...args),
		write: (...args: Parameters<FileRoom['write']>) => rpc.write(...args),
		comment: (...args: Parameters<FileRoom['comment']>) => rpc.comment(...args),
		flushForRead: (...args: Parameters<FileRoom['flushForRead']>) =>
			rpc.flushForRead(...args),
		exportMetadata: (...args: Parameters<FileRoom['exportMetadata']>) =>
			rpc.exportMetadata(...args),
		purge: (...args: Parameters<FileRoom['purge']>) => rpc.purge(...args),

		openSession: async (
			request: RequestContext,
			id: string,
			sessionId: string,
			session: FileSessionProof = {
				issuedAt: Date.now(),
				expiresAt: Date.now() + 15 * 60_000,
			},
		) => {
			const ticket = await rpc.issueTicket(request, id, sessionId, session)
			return stub.fetch(
				new Request(`https://file-room/socket?ticket=${ticket}`, {
					headers: { Upgrade: 'websocket' },
				}),
			)
		},
	}
}
