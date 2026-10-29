import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	getParkedDeadLetterMessage,
	listParkedDeadLetterMessages,
	summarizeParkedDeadLetterMessages,
	type DeadLetterPageCursor,
} from '#worker/dead-letter/store.ts'
import { adminCapabilityAccess } from './admin-shared.ts'
import {
	deadLetterMessageIdSchema,
	deadLetterMessageMetadataSchema,
	deadLetterQueueNameSchema,
	formatDeadLetterMessageMetadata,
	requireDeadLetterQueue,
} from './dead-letter-queue-shared.ts'

const inputSchema = z.object({
	queue: deadLetterQueueNameSchema,
	message_id: deadLetterMessageIdSchema
		.optional()
		.describe('Return only this message. Omit to page through the queue.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(50)
		.optional()
		.describe('Messages per page, oldest first (default 20, max 50).'),
	cursor: z
		.string()
		.trim()
		.min(1)
		.max(256)
		.optional()
		.describe('next_cursor from the previous page.'),
})

const outputSchema = z.object({
	queue: z.string(),
	source_queue: z.string(),
	parked_count: z.number().int(),
	messages: z.array(deadLetterMessageMetadataSchema),
	next_cursor: z.string().nullable(),
	redaction: z.string(),
})

const redactionNote =
	'Metadata only: message bodies, user content, tokens, and secrets are never returned. top_level_keys lists identifier-shaped key names; stable_ids keeps only id-shaped fields with id-shaped values.'

function encodeCursor(cursor: DeadLetterPageCursor) {
	return btoa(JSON.stringify([cursor.enqueuedAtMs, cursor.messageId]))
}

function decodeCursor(value: string): DeadLetterPageCursor {
	try {
		const parsed = JSON.parse(atob(value)) as unknown
		if (
			Array.isArray(parsed) &&
			typeof parsed[0] === 'number' &&
			Number.isFinite(parsed[0]) &&
			typeof parsed[1] === 'string'
		) {
			return { enqueuedAtMs: parsed[0], messageId: parsed[1] }
		}
	} catch {
		// Fall through to the caller error.
	}
	throw new McpCallerError('Invalid cursor; pass next_cursor unchanged.')
}

export const adminDeadLetterQueuePeekCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminDeadLetterQueuePeek',
		contextRuns: 'deny',
		description:
			'Peek at messages parked from one production dead-letter queue, oldest first, as redacted metadata only: message id, attempts, timestamps, source queue, kind/type, payload size, top-level key names, and stable ids such as feedbackId. Never returns message bodies, user content, tokens, or secrets. Admin-only.',
		keywords: ['admin', 'dead letter queue', 'dlq', 'peek', 'messages'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const queue = requireDeadLetterQueue(args.queue)
			const nowMs = Date.now()
			const summaries = await summarizeParkedDeadLetterMessages(ctx.env.APP_DB)
			const parkedCount = summaries.get(queue.name)?.count ?? 0
			if (args.message_id) {
				const message = await getParkedDeadLetterMessage(ctx.env.APP_DB, {
					deadLetterQueue: queue.name,
					messageId: args.message_id,
				})
				return {
					queue: queue.name,
					source_queue: queue.sourceQueue,
					parked_count: parkedCount,
					messages: message
						? [formatDeadLetterMessageMetadata(queue, message, nowMs)]
						: [],
					next_cursor: null,
					redaction: redactionNote,
				}
			}
			const page = await listParkedDeadLetterMessages(ctx.env.APP_DB, {
				deadLetterQueue: queue.name,
				limit: args.limit ?? 20,
				after: args.cursor ? decodeCursor(args.cursor) : null,
			})
			return {
				queue: queue.name,
				source_queue: queue.sourceQueue,
				parked_count: parkedCount,
				messages: page.messages.map((message) =>
					formatDeadLetterMessageMetadata(queue, message, nowMs),
				),
				next_cursor: page.next ? encodeCursor(page.next) : null,
				redaction: redactionNote,
			}
		},
	},
)
