import { z } from 'zod'
import { fileIdSchema } from './files.ts'

export const collaborationLimits = {
	updateBytes: 256 * 1024,
	stateBytes: 1024 * 1024,
	participants: 64,
	commentBytes: 8000,
	pageSize: 50,
	recentMs: 7 * 24 * 60 * 60 * 1000,
	agentPresenceMs: 45_000,
	fadeMs: 15 * 60 * 1000,
} as const
const collaborationActorSchema = z.object({
	id: z.string(),
	personId: z.string(),
	name: z.string(),
	kind: z.enum(['person', 'agent']),
	profileId: z.string().nullable(),
	runId: z.string().nullable(),
})
export type CollaborationActor = z.infer<typeof collaborationActorSchema>
const commentAnchorSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('file') }),
	z.object({
		kind: z.literal('video'),
		timeMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	}),
	z.object({
		kind: z.literal('audio'),
		timeMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		revisionId: fileIdSchema,
	}),
	z.object({
		kind: z.literal('image'),
		x: z.number().min(0).max(1),
		y: z.number().min(0).max(1),
		revisionId: fileIdSchema,
	}),
	z.object({
		kind: z.literal('json'),
		pointer: z
			.string()
			.max(8192)
			.regex(/^(?:\/(?:[^~/]|~[01])*)*$/),
		revisionId: fileIdSchema,
	}),
	z.object({
		kind: z.literal('csv'),
		row: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		column: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		revisionId: fileIdSchema,
	}),
	z.object({
		kind: z.literal('block'),
		blockId: fileIdSchema,
		quote: z.string().max(2000).optional(),
	}),
	z.object({
		kind: z.literal('text'),
		blockId: fileIdSchema.optional(),
		start: z.string().max(2000),
		end: z.string().max(2000),
		quote: z.string().min(1).max(2000),
		revisionId: fileIdSchema,
	}),
])
export type CommentAnchor = z.infer<typeof commentAnchorSchema>
export const threadSchema = z.object({
	id: fileIdSchema,
	fileId: fileIdSchema,
	anchor: commentAnchorSchema,
	anchorVersion: z.literal(1),
	revisionId: fileIdSchema,
	createdAt: z.string(),
	createdBy: collaborationActorSchema,
	resolvedAt: z.string().nullable(),
	resolvedBy: collaborationActorSchema.nullable(),
	version: z.number().int().nonnegative(),
	outdated: z.boolean(),
})
export const commentSchema = z.object({
	id: fileIdSchema,
	threadId: fileIdSchema,
	body: z.string().max(collaborationLimits.commentBytes),
	author: collaborationActorSchema,
	createdAt: z.string(),
	editedAt: z.string().nullable(),
	deletedAt: z.string().nullable(),
	version: z.number().int().nonnegative(),
})
export const commentCommandSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('create'),
		operationId: fileIdSchema,
		threadId: fileIdSchema,
		commentId: fileIdSchema,
		anchor: commentAnchorSchema,
		body: z.string().trim().min(1).max(collaborationLimits.commentBytes),
	}),
	z.object({
		kind: z.literal('reply'),
		operationId: fileIdSchema,
		threadId: fileIdSchema,
		commentId: fileIdSchema,
		body: z.string().trim().min(1).max(collaborationLimits.commentBytes),
	}),
	z.object({
		kind: z.literal('resolve'),
		operationId: fileIdSchema,
		threadId: fileIdSchema,
		expectedVersion: z.number().int().nonnegative(),
		resolved: z.boolean(),
	}),
	z.object({
		kind: z.literal('edit'),
		operationId: fileIdSchema,
		commentId: fileIdSchema,
		expectedVersion: z.number().int().nonnegative(),
		body: z.string().trim().min(1).max(collaborationLimits.commentBytes),
	}),
	z.object({
		kind: z.literal('remove'),
		operationId: fileIdSchema,
		commentId: fileIdSchema,
		expectedVersion: z.number().int().nonnegative(),
	}),
	z.object({
		kind: z.literal('read'),
		operationId: fileIdSchema,
		threadId: fileIdSchema,
		sequence: z.number().int().nonnegative(),
	}),
])
export type CommentCommand = z.infer<typeof commentCommandSchema>
export type FileThread = z.infer<typeof threadSchema>
export type FileComment = z.infer<typeof commentSchema>
const presenceSchema = z.object({
	sessionId: fileIdSchema,
	actor: collaborationActorSchema,
	lastSeen: z.number(),
	state: z.enum(['viewing', 'editing', 'idle', 'working']),
	blockId: fileIdSchema.optional(),
	selection: z
		.object({ anchor: z.string().max(2000), head: z.string().max(2000) })
		.optional(),
})
export type FilePresence = z.infer<typeof presenceSchema>
export type RecentParticipant = {
	id: string
	actor: CollaborationActor
	lastSeen: number
	activeUntil?: number
	lastAction: 'viewed' | 'edited' | 'commented'
}
export const fileLiveUpdateSchema = z.object({
	operationId: fileIdSchema,
	update: z.string().max(500_000),
})
export const fileAgentPresenceSchema = presenceSchema.pick({
	state: true,
	blockId: true,
	selection: true,
})
export const roomClientMessageSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('sync'), stateVector: z.string().max(500_000) }),
	fileLiveUpdateSchema.extend({ type: z.literal('update') }),
	fileAgentPresenceSchema.extend({ type: z.literal('presence') }),
	z.object({ type: z.literal('comment'), command: commentCommandSchema }),
])
export type RoomClientMessage = z.infer<typeof roomClientMessageSchema>
export type CollaborationAccess = {
	read: boolean
	write: boolean
	comment: boolean
	manage: boolean
}
const fileNotificationSchema = z.object({
	id: fileIdSchema,
	threadId: fileIdSchema,
	actor: collaborationActorSchema,
	createdAt: z.string(),
	sequence: z.number(),
	read: z.boolean(),
})
export type FileNotification = z.infer<typeof fileNotificationSchema>
export const threadCommentPageSchema = z.object({
	comments: z.array(commentSchema),
	nextCursor: z.string().nullable(),
})
export type RoomSnapshot = {
	commentCursors: Record<string, string | null>
	nextCursor: string | null
	notifications: FileNotification[]
	state: string
	revisionId: string
	sequence: number
	threads: FileThread[]
	comments: FileComment[]
	recent: RecentParticipant[]
	presence: FilePresence[]
	actor: CollaborationActor
	access: CollaborationAccess
}
export type RoomServerMessage =
	| { type: 'snapshot'; snapshot: RoomSnapshot }
	| { type: 'file'; revisionId: string; sequence: number }
	| { type: 'notifications'; notifications: FileNotification[] }
	| { type: 'update'; update: string; sequence: number; revisionId: string }
	| { type: 'ack'; operationId: string; sequence: number; revisionId: string }
	| { type: 'presence'; presence: FilePresence[]; recent: RecentParticipant[] }
	| {
			type: 'comments'
			commentCursors?: Record<string, string | null>
			threads: FileThread[]
			comments: FileComment[]
			sequence: number
	  }
	| {
			type: 'error'
			message: string
			operationId?: string
			code: 'forbidden' | 'conflict' | 'invalid' | 'unavailable'
	  }

export function encodeCollaborationBytes(bytes: Uint8Array) {
	let result = ''
	for (const byte of bytes) result += String.fromCharCode(byte)
	return btoa(result)
}
export function decodeCollaborationBytes(text: string) {
	return Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
}
export function participantOpacity(lastSeen: number, now = Date.now()) {
	return Math.max(
		0.35,
		1 - (Math.max(0, now - lastSeen) / collaborationLimits.fadeMs) * 0.65,
	)
}

export const roomSnapshotSchema = z.object({
	commentCursors: z.record(z.string(), z.string().nullable()).default({}),
	notifications: z.array(fileNotificationSchema),
	state: z.string(),
	revisionId: fileIdSchema,
	sequence: z.number(),
	threads: z.array(threadSchema),
	comments: z.array(commentSchema),
	recent: z.array(
		z.object({
			id: z.string(),
			actor: collaborationActorSchema,
			lastSeen: z.number(),
			activeUntil: z.number().optional(),
			lastAction: z.enum(['viewed', 'edited', 'commented']),
		}),
	),
	presence: z.array(presenceSchema),
	actor: collaborationActorSchema,
	access: z.object({
		read: z.boolean(),
		write: z.boolean(),
		comment: z.boolean(),
		manage: z.boolean(),
	}),
	nextCursor: z.string().nullable(),
})

export function videoTime(timeMs: number, precise = false) {
	const seconds = Math.floor(timeMs / 1000)
	const minutes = Math.floor(seconds / 60)
	const fraction = String(timeMs % 1000)
		.padStart(3, '0')
		.replace(/0+$/, '')
	const clock =
		String(seconds % 60).padStart(2, '0') +
		(precise && fraction ? `.${fraction}` : '')
	return minutes >= 60
		? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${clock}`
		: `${minutes}:${clock}`
}
