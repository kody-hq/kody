import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	deadLetterQueueNames,
	getDeadLetterQueue,
	type DeadLetterQueueDefinition,
} from '#worker/dead-letter/queues.ts'
import { type ParkedDeadLetterMessage } from '#worker/dead-letter/store.ts'

export const deadLetterQueueNameSchema = z
	.enum(deadLetterQueueNames)
	.describe(
		'Production dead-letter queue name, for example kody-platform-feedback-dispatch-dlq. adminDeadLetterQueueList returns every name.',
	)

export const deadLetterMessageIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.describe('Cloudflare Queue message id from adminDeadLetterQueuePeek.')

export const deadLetterMessageMetadataSchema = z.object({
	message_id: z.string(),
	queue: z.string(),
	source_queue: z.string(),
	status: z.enum(['parked', 'replaying']),
	attempts: z.number().int(),
	enqueued_at: z.string(),
	parked_at: z.string(),
	age_seconds: z.number().int(),
	payload_type: z.string(),
	payload_bytes: z.number().int(),
	top_level_keys: z.array(z.string()),
	top_level_key_count: z.number().int(),
	kind: z.string().nullable(),
	stable_ids: z.record(z.string(), z.string()),
	replayable: z.boolean(),
})

export function requireDeadLetterQueue(
	name: string,
): DeadLetterQueueDefinition {
	const queue = getDeadLetterQueue(name)
	if (!queue) {
		throw new McpCallerError(`Unknown dead-letter queue: ${name}.`)
	}
	return queue
}

export function isDeadLetterMessageReplayable(
	queue: DeadLetterQueueDefinition,
	message: Pick<ParkedDeadLetterMessage, 'bodyJson'>,
) {
	return queue.replay.kind !== 'unsupported' && message.bodyJson !== null
}

/** Redacted view of a parked row. Never includes `bodyJson`. */
export function formatDeadLetterMessageMetadata(
	queue: DeadLetterQueueDefinition,
	message: ParkedDeadLetterMessage,
	nowMs: number,
): z.infer<typeof deadLetterMessageMetadataSchema> {
	return {
		message_id: message.messageId,
		queue: message.deadLetterQueue,
		source_queue: message.sourceQueue,
		status: message.status,
		attempts: message.attempts,
		enqueued_at: new Date(message.enqueuedAtMs).toISOString(),
		parked_at: new Date(message.parkedAtMs).toISOString(),
		age_seconds: Math.max(0, Math.floor((nowMs - message.enqueuedAtMs) / 1000)),
		payload_type: message.metadata.payloadType,
		payload_bytes: message.metadata.payloadBytes,
		top_level_keys: message.metadata.topLevelKeys,
		top_level_key_count: message.metadata.topLevelKeyCount,
		kind: message.metadata.kind,
		stable_ids: message.metadata.stableIds,
		replayable: isDeadLetterMessageReplayable(queue, message),
	}
}

export function deadLetterAuditReason(fields: Record<string, string | number>) {
	return Object.entries(fields)
		.map(([key, value]) => `${key}=${String(value)}`)
		.join(';')
		.slice(0, 240)
}
