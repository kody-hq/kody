import * as Y from 'yjs'
import { actorColor, sessionNumber } from '#universal/collaboration-color.ts'
import { Awareness, applyAwarenessUpdate } from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import {
	DbClient,
	collectionOptions,
	type SyncConfig,
} from '@tanstack/react-db'
import {
	encodeCollaborationBytes,
	decodeCollaborationBytes,
	type FileThread,
	type FileComment,
	type FilePresence,
	type RecentParticipant,
	type RoomServerMessage,
	type RoomClientMessage,
	type RoomSnapshot,
	type CommentCommand,
} from '#universal/file-collaboration.ts'
import {
	sendFileComment,
	readFileCollaboration,
	readFileThreadComments,
} from '#start/server/file-collaboration'

type Cache = {
	state: Uint8Array
	pending: [string, string][]
	comments: CommentCommand[]
}
export type RoomConnection = {
	status: 'connecting' | 'saved' | 'pending' | 'offline' | 'forbidden' | 'error'
	ready: boolean
	locallySaved: boolean
	message: string
	snapshot: RoomSnapshot | null
}
function remoteCollection<T extends { id: string }>(db: DbClient, id: string) {
	let publish: (rows: T[]) => void = () => {},
		queued: T[] = []
	const options = collectionOptions<T>({
		id,
		getKey: (row) => row.id,
		sync: {
			sync: ({ begin, write, commit, markReady }) => {
				publish = (rows) => {
					begin({ snapshot: true })
					for (const value of rows) write({ type: 'insert', value })
					commit()
					markReady()
				}
				publish(queued)
				return () => {
					publish = () => {}
				}
			},
		} satisfies SyncConfig<T>,
	})
	const collection = db.collection(options)
	collection.startSyncImmediate()
	return {
		options,
		collection,
		replace(rows: T[]) {
			queued = rows
			publish(rows)
		},
	}
}
async function openCache() {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open('kody-file-collaboration', 1)
		request.onupgradeneeded = () => request.result.createObjectStore('files')
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error)
	})
}

function readPresenceCursor(selection: FilePresence['selection']) {
	if (!selection) return null
	try {
		const anchor = JSON.parse(selection.anchor)
		const head = JSON.parse(selection.head)
		if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor))
			return null
		if (!head || typeof head !== 'object' || Array.isArray(head)) return null
		return { anchor, head }
	} catch {
		return null
	}
}

export class FileRoomClient {
	readonly doc = new Y.Doc()
	readonly awareness = new Awareness(this.doc)
	readonly db = new DbClient()
	readonly threads = remoteCollection<FileThread>(this.db, 'threads')
	readonly comments = remoteCollection<FileComment>(this.db, 'comments')
	readonly recent = remoteCollection<RecentParticipant>(this.db, 'recent')
	readonly participants = remoteCollection<FilePresence & { id: string }>(
		this.db,
		'participants',
	)
	private listeners = new Set<() => void>()
	private value: RoomConnection = {
		status: 'connecting',
		ready: false,
		locallySaved: false,
		message: '',
		snapshot: null,
	}
	private pending = new Map<string, string>()
	private pendingComments: CommentCommand[] = []
	private awaiting = new Map<
		string,
		{ resolve: () => void; reject: (error: Error) => void }
	>()
	private socket: WebSocket | null = null
	private cache: IDBDatabase | null = null
	private disposed = false
	private reconnect: ReturnType<typeof setTimeout> | undefined
	private heartbeat: ReturnType<typeof setInterval> | undefined
	private presenceTimer: ReturnType<typeof setTimeout> | undefined
	private persistTimer: ReturnType<typeof setTimeout> | undefined
	private failedConnections = 0
	private retryMs = 500
	readonly sessionId = crypto.randomUUID()
	readonly orgSlug: string
	readonly fileId: string
	private key: string
	constructor(orgSlug: string, fileId: string, personId: string) {
		this.orgSlug = orgSlug
		this.fileId = fileId
		this.key = `${personId}:${orgSlug}:${fileId}`
		this.doc.on('update', (update: Uint8Array, origin: unknown) => {
			if (origin === 'remote' || origin === 'cache') return
			const id = crypto.randomUUID()
			this.pending.set(id, encodeCollaborationBytes(update))
			this.set({
				status:
					this.socket?.readyState === WebSocket.OPEN ? 'pending' : 'offline',
			})
			void this.persist().then(() => this.flush())
		})
		this.awareness.on(
			'update',
			({ added, updated }: { added: number[]; updated: number[] }) => {
				if ([...added, ...updated].includes(this.doc.clientID))
					this.sendPresence()
			},
		)
	}
	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	getSnapshot = () => this.value
	private set(patch: Partial<RoomConnection>) {
		this.value = { ...this.value, ...patch }
		for (const listener of this.listeners) listener()
	}
	async start() {
		try {
			this.cache = await openCache()
			const cache = await new Promise<Cache | undefined>((resolve, reject) => {
				const r = this.cache!.transaction('files')
					.objectStore('files')
					.get(this.key)
				r.onsuccess = () => resolve(r.result)
				r.onerror = () => reject(r.error)
			})
			if (cache) {
				Y.applyUpdate(this.doc, cache.state, 'cache')
				this.pending = new Map(cache.pending)
				this.pendingComments = cache.comments
				this.set({ locallySaved: true })
			}
		} catch {
			this.set({ locallySaved: false })
		}
		if (!this.disposed) this.connect()
	}
	private async persist() {
		if (!this.cache) return
		try {
			await new Promise<void>((resolve, reject) => {
				const tx = this.cache!.transaction('files', 'readwrite')
				tx.objectStore('files').put(
					{
						state: Y.encodeStateAsUpdate(this.doc),
						pending: Array.from(this.pending),
						comments: this.pendingComments,
					} satisfies Cache,
					this.key,
				)
				tx.oncomplete = () => resolve()
				tx.onerror = () => reject(tx.error)
				tx.onabort = () => reject(tx.error)
			})
			this.set({ locallySaved: true })
		} catch {
			this.set({ locallySaved: false })
		}
	}
	private connect() {
		const url = new URL(
			`/file-session/${encodeURIComponent(this.orgSlug)}/${this.fileId}`,
			location.origin,
		)
		url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
		url.searchParams.set('session', this.sessionId)
		const socket = new WebSocket(url)
		this.socket = socket
		socket.onmessage = (e) => {
			try {
				this.receive(JSON.parse(e.data) as RoomServerMessage)
			} catch {
				this.set({
					status: 'error',
					message: 'Could not read a collaboration update.',
				})
			}
		}
		socket.onclose = (e) => {
			for (const pending of this.awaiting.values()) pending.resolve()
			this.awaiting.clear()
			this.awareness.setLocalStateField('cursor', null)
			if (this.disposed) return
			if (e.code === 4003) {
				this.set({
					status: 'forbidden',
					message: 'Your access to this file changed.',
				})
				return
			}
			this.set({ status: 'offline' })
			if (!this.value.ready && ++this.failedConnections >= 3) {
				void readFileCollaboration({
					data: { orgSlug: this.orgSlug, fileId: this.fileId },
				}).then(
					(snapshot) => {
						if (!this.disposed) {
							this.receive({ type: 'snapshot', snapshot })
							this.set({ status: 'offline' })
						}
					},
					() => {
						if (!this.disposed)
							this.set({
								status: 'forbidden',
								message:
									'Could not open this file. Check your access and reconnect.',
							})
					},
				)
				return
			}
			this.reconnect = setTimeout(() => this.connect(), this.retryMs)
			this.retryMs = Math.min(10_000, this.retryMs * 2)
		}
		socket.onerror = () => this.set({ status: 'offline' })
	}
	private receive(message: RoomServerMessage) {
		if (message.type === 'snapshot') {
			Y.applyUpdate(
				this.doc,
				decodeCollaborationBytes(message.snapshot.state),
				'remote',
			)
			this.retryMs = 500
			this.failedConnections = 0
			this.set({
				snapshot: message.snapshot,
				ready: true,
				status:
					this.pending.size || this.pendingComments.length
						? 'pending'
						: 'saved',
				message: '',
			})
			this.awareness.setLocalStateField('user', {
				name: message.snapshot.actor.name,
				color: actorColor(message.snapshot.actor.id),
			})
			this.threads.replace(message.snapshot.threads)
			this.comments.replace(message.snapshot.comments)
			this.presence(message.snapshot.presence, message.snapshot.recent)
			this.flush()
			if (this.heartbeat) clearInterval(this.heartbeat)
			this.heartbeat = setInterval(() => this.sendPresence(), 15_000)
			this.sendPresence()
		} else if (message.type === 'file') {
			if (this.value.snapshot)
				this.set({
					snapshot: {
						...this.value.snapshot,
						revisionId: message.revisionId,
						sequence: message.sequence,
					},
				})
		} else if (message.type === 'update') {
			Y.applyUpdate(
				this.doc,
				decodeCollaborationBytes(message.update),
				'remote',
			)
			if (this.value.snapshot)
				this.set({
					snapshot: {
						...this.value.snapshot,
						revisionId: message.revisionId,
						sequence: message.sequence,
					},
				})
		} else if (message.type === 'ack') {
			this.awaiting.get(message.operationId)?.resolve()
			this.awaiting.delete(message.operationId)
			this.pending.delete(message.operationId)
			this.pendingComments = this.pendingComments.filter(
				(c) => c.operationId !== message.operationId,
			)
			this.set({
				status:
					this.pending.size || this.pendingComments.length
						? 'pending'
						: 'saved',
				snapshot: this.value.snapshot
					? {
							...this.value.snapshot,
							revisionId: message.revisionId,
							sequence: message.sequence,
						}
					: null,
			})
		} else if (message.type === 'notifications') {
			if (this.value.snapshot)
				this.set({
					snapshot: {
						...this.value.snapshot,
						notifications: message.notifications,
					},
				})
		} else if (message.type === 'comments') {
			this.mergeComments(message.threads, message.comments)
			if (this.value.snapshot)
				this.set({
					snapshot: {
						...this.value.snapshot,
						sequence: message.sequence,
						commentCursors: {
							...message.commentCursors,
							...this.value.snapshot.commentCursors,
						},
					},
				})
		} else if (message.type === 'presence')
			this.presence(message.presence, message.recent)
		else {
			if (message.operationId) {
				this.awaiting
					.get(message.operationId)
					?.reject(new Error(message.message))
				this.awaiting.delete(message.operationId)
			}
			this.set({
				status: message.code === 'forbidden' ? 'forbidden' : 'error',
				message: message.message,
			})
		}
		if (this.persistTimer) clearTimeout(this.persistTimer)
		this.persistTimer = setTimeout(() => void this.persist(), 100)
	}
	private presence(participants: FilePresence[], recent: RecentParticipant[]) {
		const sessions = new Map<string, FilePresence>()
		for (const participant of participants) {
			const previous = sessions.get(participant.sessionId)
			if (!previous || participant.lastSeen >= previous.lastSeen)
				sessions.set(participant.sessionId, participant)
		}
		this.participants.replace(
			Array.from(sessions.values(), (p) => ({ ...p, id: p.sessionId })),
		)
		this.recent.replace(recent)
		const remote = new Map<
			number,
			{ clock: number; state: Record<string, unknown> | null }
		>()
		for (const p of sessions.values()) {
			if (p.sessionId === this.sessionId) continue
			const id = sessionNumber(p.sessionId)
			remote.set(id, {
				clock: Date.now(),
				state: {
					user: {
						name: p.actor.name,
						color: actorColor(p.actor.id),
						sessionId: p.sessionId,
					},
					cursor: readPresenceCursor(p.selection),
				},
			})
		}
		for (const id of this.awareness.getStates().keys())
			if (id !== this.doc.clientID && !remote.has(id))
				remote.set(id, { clock: Date.now(), state: null })
		const encoder = encoding.createEncoder()
		encoding.writeVarUint(encoder, remote.size)
		for (const [id, value] of remote) {
			encoding.writeVarUint(encoder, id)
			encoding.writeVarUint(encoder, value.clock)
			encoding.writeVarString(encoder, JSON.stringify(value.state))
		}
		applyAwarenessUpdate(
			this.awareness,
			encoding.toUint8Array(encoder),
			'remote',
		)
	}
	private sendPresence() {
		if (this.presenceTimer || this.disposed) return
		this.presenceTimer = setTimeout(() => {
			this.presenceTimer = undefined
			this.publishPresence()
		}, 80)
	}
	private publishPresence() {
		const cursor = this.awareness.getLocalState()?.cursor
		this.send({
			type: 'presence',
			state: document.hidden ? 'idle' : cursor ? 'editing' : 'viewing',
			selection: cursor
				? {
						anchor: JSON.stringify(cursor.anchor),
						head: JSON.stringify(cursor.head),
					}
				: undefined,
		})
	}
	private send(message: RoomClientMessage) {
		if (this.socket?.readyState === WebSocket.OPEN)
			this.socket.send(JSON.stringify(message))
	}
	private flush() {
		if (this.value.status === 'error' || this.value.status === 'forbidden')
			return
		if (this.value.snapshot?.access.write)
			for (const [operationId, update] of this.pending)
				this.send({ type: 'update', operationId, update })
		if (this.value.snapshot?.access.comment)
			for (const command of this.pendingComments)
				this.send({ type: 'comment', command })
	}
	async loadMoreThreads() {
		const cursor = this.value.snapshot?.nextCursor
		if (!cursor) return
		const result = await readFileCollaboration({
			data: { orgSlug: this.orgSlug, fileId: this.fileId, cursor },
		})
		this.mergeComments(result.threads, result.comments)
		if (this.value.snapshot)
			this.set({
				snapshot: {
					...this.value.snapshot,
					nextCursor: result.nextCursor,
					commentCursors: {
						...this.value.snapshot.commentCursors,
						...result.commentCursors,
					},
				},
			})
	}
	async loadMoreComments(threadId: string) {
		const cursor = this.value.snapshot?.commentCursors[threadId]
		if (!cursor) return
		const result = await readFileThreadComments({
			data: { orgSlug: this.orgSlug, fileId: this.fileId, threadId, cursor },
		})
		this.mergeComments([], result.comments)
		if (this.value.snapshot)
			this.set({
				snapshot: {
					...this.value.snapshot,
					commentCursors: {
						...this.value.snapshot.commentCursors,
						[threadId]: result.nextCursor,
					},
				},
			})
	}

	private mergeComments(threads: FileThread[], comments: FileComment[]) {
		this.threads.replace([
			...new Map(
				[...this.threads.collection.toArray, ...threads].map((thread) => [
					thread.id,
					thread,
				]),
			).values(),
		])
		this.comments.replace([
			...new Map(
				[...this.comments.collection.toArray, ...comments].map((comment) => [
					comment.id,
					comment,
				]),
			).values(),
		])
	}

	async comment(command: CommentCommand) {
		if (command.kind !== 'read' && !this.value.snapshot?.access.comment)
			throw new Error('Comment access is required.')
		this.pendingComments.push(command)
		this.set({
			status:
				this.socket?.readyState === WebSocket.OPEN ? 'pending' : 'offline',
		})
		await this.persist()
		if (this.socket?.readyState === WebSocket.OPEN) {
			await new Promise<void>((resolve, reject) => {
				this.awaiting.set(command.operationId, { resolve, reject })
				this.send({ type: 'comment', command })
			})
		} else if (this.value.status !== 'offline') {
			try {
				const result = await sendFileComment({
					data: { orgSlug: this.orgSlug, fileId: this.fileId, command },
				})
				this.mergeComments(result.threads, result.comments)
				this.pendingComments = this.pendingComments.filter(
					(c) => c.operationId !== command.operationId,
				)
				await this.persist()
			} catch (error) {
				this.set({
					status: 'error',
					message:
						error instanceof Error
							? error.message
							: 'Could not send the comment.',
				})
				throw error
			}
		}
	}
	retry() {
		if (this.disposed) return
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.set({
				status:
					this.pending.size || this.pendingComments.length
						? 'pending'
						: 'saved',
				message: '',
			})
			this.flush()
			return
		}
		if (this.socket?.readyState === WebSocket.CONNECTING) return
		if (this.reconnect) clearTimeout(this.reconnect)
		this.failedConnections = 0
		this.set({ status: 'connecting', message: '' })
		this.connect()
	}

	dispose() {
		this.disposed = true
		if (this.reconnect) clearTimeout(this.reconnect)
		if (this.heartbeat) clearInterval(this.heartbeat)
		if (this.presenceTimer) clearTimeout(this.presenceTimer)
		if (this.persistTimer) clearTimeout(this.persistTimer)
		void this.persist().finally(() => this.cache?.close())
		this.socket?.close(1000)
		this.awareness.destroy()
		this.doc.destroy()
		void this.db.cleanup().catch(() => {})
	}
}
