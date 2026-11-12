import { allStorageRows } from './storage-pages.ts'
import type {
	FileNotification,
	CommentAnchor,
	CollaborationActor,
	CommentCommand,
	FileThread,
	FileComment,
	CollaborationAccess,
} from '#universal/file-collaboration.ts'

type Storage = Pick<
	DurableObjectStorage,
	'get' | 'put' | 'list' | 'transaction'
>
/** Separate durable rows, never rewrite file bodies to add a discussion. */
export class CommentLedger {
	private indexesReady?: Promise<void>
	private storage: Storage
	constructor(storage: Storage) {
		this.storage = storage
	}
	private ensureIndexes() {
		return (this.indexesReady ??= (async () => {
			if (await this.storage.get('comment-index-version')) return
			let cursor: string | undefined
			do {
				const rows = await this.storage.list<FileComment>({
					prefix: 'comment:',
					startAfter: cursor,
					limit: 40,
				})
				const index: Record<string, string | boolean> = {}
				for (const comment of rows.values()) {
					index[
						`comment-order:${comment.threadId}:${comment.createdAt}:${comment.id}`
					] = comment.id
					index[`participant:${comment.threadId}:${comment.author.id}`] = true
				}
				if (Object.keys(index).length) await this.storage.put(index)
				cursor = rows.size === 40 ? Array.from(rows.keys()).at(-1) : undefined
			} while (cursor)
			await this.storage.put('comment-index-version', 1)
		})().catch((error) => {
			this.indexesReady = undefined
			throw error
		}))
	}
	async listComments(threadId: string, cursor?: string) {
		await this.ensureIndexes()
		if (!(await this.storage.get(`thread:${threadId}`)))
			throw new Error('Discussion not found.')
		const prefix = `comment-order:${threadId}:`
		if (cursor && !cursor.startsWith(prefix))
			throw new Error('Invalid discussion cursor.')
		const rows = await this.storage.list<string>({
			prefix,
			startAfter: cursor,
			limit: 51,
		})
		const page = Array.from(rows).slice(0, 50)
		const comments = await Promise.all(
			page.map(([, id]) =>
				this.storage.get<FileComment>(`comment:${threadId}:${id}`),
			),
		)
		return {
			comments: comments.filter((comment): comment is FileComment => !!comment),
			nextCursor: rows.size > 50 ? page.at(-1)![0] : null,
		}
	}

	async list(cursor?: string) {
		await this.ensureIndexes()
		const threads = Array.from(
			(
				await this.storage.list<FileThread>({
					prefix: 'thread:',
					startAfter: cursor ? `thread:${cursor}` : undefined,
					limit: 51,
				})
			).values(),
		)
		const visible = threads.slice(0, 50)
		const pages = await Promise.all(
			visible.map((thread) => this.listComments(thread.id)),
		)
		const comments = pages.flatMap((page) => page.comments)
		const commentCursors = Object.fromEntries(
			visible.map((thread, index) => [thread.id, pages[index]!.nextCursor]),
		)

		return {
			threads: visible,
			comments,
			commentCursors,
			nextCursor: threads.length > 50 ? visible.at(-1)!.id : null,
		}
	}
	async notifications(actorId: string) {
		const rows = await this.storage.list<FileNotification>({
			prefix: `notification:${actorId}:`,
			limit: 100,
		})
		return Promise.all(
			Array.from(rows.values(), async (row) => ({
				...row,
				read:
					((await this.storage.get<number>(
						`comment-read:${actorId}:${row.threadId}`,
					)) ?? 0) >= row.sequence,
			})),
		)
	}
	async deliverNotifications(
		resolveMention: (name: string) => Promise<string | null>,
	) {
		await this.ensureIndexes()
		const outbox = await this.storage.list<{
			id: string
			actor: CollaborationActor
			command: CommentCommand
			createdAt: string
			sequence: number
		}>({ prefix: 'notification-outbox:', limit: 100 })
		for (const [key, event] of outbox) {
			const command = event.command
			const threadId =
				'threadId' in command
					? command.threadId
					: 'commentId' in command
						? await this.storage.get<string>(
								`comment-index:${command.commentId}`,
							)
						: null
			if (!threadId) continue
			const thread = await this.storage.get<FileThread>(`thread:${threadId}`)
			if (!thread) continue
			const recipients = new Set<string>([thread.createdBy.id])
			const prefix = `participant:${threadId}:`
			const participants = await allStorageRows<boolean>(this.storage, prefix)
			for (const key of participants.keys())
				recipients.add(key.slice(prefix.length))
			if ('body' in command)
				for (const match of command.body.matchAll(
					/(?:^|\s)@([a-zA-Z0-9_-]+)/g,
				)) {
					const recipient = await resolveMention(match[1]!)
					if (recipient) recipients.add(recipient)
				}
			recipients.delete(event.actor.id)
			await this.storage.transaction(async (tx) => {
				for (const recipient of recipients)
					await tx.put(`notification:${recipient}:${event.id}`, {
						id: event.id,
						threadId,
						actor: event.actor,
						createdAt: event.createdAt,
						sequence: event.sequence,
						read: false,
					} satisfies FileNotification)
				await tx.delete(key)
			})
		}
	}

	async refreshAnchors(exists: (anchor: CommentAnchor) => boolean | undefined) {
		const rows = await allStorageRows<FileThread>(this.storage, 'thread:')
		const changed: Record<string, FileThread> = {}
		for (const [key, thread] of rows) {
			const present = exists(thread.anchor)
			if (present === undefined) continue
			const outdated = !present
			if (outdated !== thread.outdated) changed[key] = { ...thread, outdated }
		}
		const entries = Object.entries(changed)
		for (let i = 0; i < entries.length; i += 100)
			await this.storage.put(Object.fromEntries(entries.slice(i, i + 100)))
		return Object.keys(changed).length > 0
	}

	async command(input: {
		command: CommentCommand
		actor: CollaborationActor
		access: CollaborationAccess
		fileId: string
		revisionId: string
		sequence: number
		validateAnchor?: () => void
	}) {
		await this.ensureIndexes()
		const { command: c, actor, access, fileId, revisionId, sequence } = input
		if (!access.read || (!access.comment && c.kind !== 'read'))
			throw new Error('Comment access is required.')
		const fingerprint = JSON.stringify({ actorId: actor.id, command: c })
		return this.storage.transaction(async (tx) => {
			const receipt = await tx.get<{
				fingerprint: string
				sequence: number
				thread?: FileThread
				comment?: FileComment
			}>(`comment-receipt:${c.operationId}`)
			if (receipt) {
				if (receipt.fingerprint !== fingerprint)
					throw new Error('Operation id was already used.')
				return {
					sequence: Math.max(sequence, receipt.sequence),
					replayed: true,
					thread: receipt.thread
						? await tx.get<FileThread>(`thread:${receipt.thread.id}`)
						: undefined,
					comment: receipt.comment
						? await tx.get<FileComment>(
								`comment:${receipt.comment.threadId}:${receipt.comment.id}`,
							)
						: undefined,
				}
			}
			const nextSequence =
				Math.max(sequence, (await tx.get<number>('sequence')) ?? 0) + 1
			const now = new Date().toISOString()
			if (c.kind === 'create') {
				input.validateAnchor?.()
				if (await tx.get(`comment-index:${c.commentId}`))
					throw new Error('Comment already exists.')
				if (await tx.get(`thread:${c.threadId}`))
					throw new Error('Thread already exists.')
				const thread: FileThread = {
					id: c.threadId,
					fileId,
					anchor: c.anchor,
					anchorVersion: 1,
					revisionId,
					createdAt: now,
					createdBy: actor,
					resolvedAt: null,
					resolvedBy: null,
					version: 0,
					outdated: false,
				}
				const comment: FileComment = {
					id: c.commentId,
					threadId: c.threadId,
					body: c.body,
					author: actor,
					createdAt: now,
					editedAt: null,
					deletedAt: null,
					version: 0,
				}
				await tx.put({
					[`thread:${thread.id}`]: thread,
					[`comment:${thread.id}:${comment.id}`]: comment,
					[`comment-index:${comment.id}`]: thread.id,
					[`comment-order:${thread.id}:${comment.createdAt}:${comment.id}`]:
						comment.id,
					[`participant:${thread.id}:${actor.id}`]: true,
					[`pin:${revisionId}`]: true,
				})
			} else if (
				c.kind === 'reply' ||
				c.kind === 'resolve' ||
				c.kind === 'read'
			) {
				const thread = await tx.get<FileThread>(`thread:${c.threadId}`)
				if (!thread) throw new Error('Discussion not found.')
				if (c.kind === 'reply') {
					if (await tx.get(`comment-index:${c.commentId}`))
						throw new Error('Comment already exists.')
					const comment: FileComment = {
						id: c.commentId,
						threadId: c.threadId,
						body: c.body,
						author: actor,
						createdAt: now,
						editedAt: null,
						deletedAt: null,
						version: 0,
					}
					await tx.put({
						[`comment:${thread.id}:${comment.id}`]: comment,
						[`comment-index:${comment.id}`]: thread.id,
						[`comment-order:${thread.id}:${comment.createdAt}:${comment.id}`]:
							comment.id,
						[`participant:${thread.id}:${actor.id}`]: true,
					})
				} else if (c.kind === 'resolve') {
					if (thread.version !== c.expectedVersion)
						throw new Error('Discussion changed. Refresh and try again.')
					await tx.put(`thread:${thread.id}`, {
						...thread,
						resolvedAt: c.resolved ? now : null,
						resolvedBy: c.resolved ? actor : null,
						version: thread.version + 1,
					})
				} else
					await tx.put(
						`comment-read:${actor.id}:${thread.id}`,
						Math.max(
							Math.min(c.sequence, nextSequence - 1),
							(await tx.get<number>(`comment-read:${actor.id}:${thread.id}`)) ??
								0,
						),
					)
			} else {
				const threadId = await tx.get<string>(`comment-index:${c.commentId}`)
				const comment = threadId
					? await tx.get<FileComment>(`comment:${threadId}:${c.commentId}`)
					: undefined
				if (!comment) throw new Error('Comment not found.')
				if (comment.deletedAt) throw new Error('Comment was removed.')
				if (
					comment.author.id !== actor.id &&
					!(c.kind === 'remove' && access.manage)
				)
					throw new Error('Only the author can edit this comment.')
				if (comment.version !== c.expectedVersion)
					throw new Error('Comment changed. Refresh and try again.')
				await tx.put(`comment:${threadId}:${comment.id}`, {
					...comment,
					body: c.kind === 'edit' ? c.body : '',
					editedAt: c.kind === 'edit' ? now : comment.editedAt,
					deletedAt: c.kind === 'remove' ? now : null,
					version: comment.version + 1,
				})
			}
			const changedThreadId =
				'threadId' in c
					? c.threadId
					: await tx.get<string>(`comment-index:${c.commentId}`)
			const changedThread = changedThreadId
				? await tx.get<FileThread>(`thread:${changedThreadId}`)
				: undefined
			const changedComment =
				'commentId' in c && changedThreadId
					? await tx.get<FileComment>(
							`comment:${changedThreadId}:${c.commentId}`,
						)
					: undefined
			await tx.put({
				[`comment-receipt:${c.operationId}`]: {
					thread: changedThread,
					comment: changedComment,
					fingerprint,
					sequence: nextSequence,
				},
				...(c.kind === 'read'
					? {}
					: {
							[`notification-outbox:${c.operationId}`]: {
								id: c.operationId,
								fileId,
								actor,
								command: c,
								createdAt: now,
								sequence: nextSequence,
							},
						}),
				sequence: nextSequence,
			})
			return {
				sequence: nextSequence,
				replayed: false,
				thread: changedThread,
				comment: changedComment,
			}
		})
	}
}
