import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { deadLetterQueues } from '#worker/dead-letter/queues.ts'
import { summarizeParkedDeadLetterMessages } from '#worker/dead-letter/store.ts'
import { readCloudflareBacklogs } from '#worker/dead-letter/cloudflare-backlog.ts'
import { adminCapabilityAccess } from './admin-shared.ts'

const inputSchema = z.object({})

const cloudflareBacklogSchema = z.object({
	backlog_count: z.number().int(),
	oldest_message_at: z.string().nullable(),
	oldest_message_age_seconds: z.number().int().nullable(),
})

const outputSchema = z.object({
	queues: z.array(
		z.object({
			queue: z.string(),
			source_queue: z.string(),
			depth: z
				.number()
				.int()
				.describe(
					'parked_count plus the Cloudflare backlog (messages not yet parked). Null Cloudflare metrics count as 0.',
				),
			oldest_message_at: z.string().nullable(),
			oldest_message_age_seconds: z.number().int().nullable(),
			parked_count: z.number().int(),
			parked_oldest_enqueued_at: z.string().nullable(),
			cloudflare: cloudflareBacklogSchema.nullable(),
			cloudflare_error: z.string().nullable(),
			replay_supported: z.boolean(),
			replay_unsupported_reason: z.string().nullable(),
		}),
	),
})

function ageSeconds(timestampMs: number | null, nowMs: number) {
	return timestampMs === null
		? null
		: Math.max(0, Math.floor((nowMs - timestampMs) / 1000))
}

function iso(timestampMs: number | null) {
	return timestampMs === null ? null : new Date(timestampMs).toISOString()
}

export const adminDeadLetterQueueListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminDeadLetterQueueList',
		contextRuns: 'deny',
		description:
			'List every production dead-letter queue with its depth and oldest-message age: messages parked in Kody for admin review plus any Cloudflare backlog not yet parked. Use adminDeadLetterQueuePeek for redacted message metadata, then adminDeadLetterQueueReplay, adminDeadLetterQueueAck, or adminDeadLetterQueuePurge. Admin-only.',
		keywords: [
			'admin',
			'dead letter queue',
			'dlq',
			'queues',
			'depth',
			'backlog',
		],
		inputSchema,
		outputSchema,
		async handler(_args, ctx) {
			const nowMs = Date.now()
			const [parked, cloudflare] = await Promise.all([
				summarizeParkedDeadLetterMessages(ctx.env.APP_DB),
				readCloudflareBacklogs(ctx.env),
			])
			return {
				queues: deadLetterQueues.map((queue) => {
					const parkedSummary = parked.get(queue.name)
					const parkedCount = parkedSummary?.count ?? 0
					const parkedOldest =
						parkedCount > 0 ? (parkedSummary?.oldestEnqueuedAtMs ?? null) : null
					const metrics = cloudflare.metrics?.get(queue.name) ?? null
					const backlog = metrics instanceof Error ? null : metrics
					const oldestCandidates = [
						parkedOldest,
						backlog?.oldestMessageTimestampMs ?? null,
					].filter((value): value is number => value !== null)
					const oldest =
						oldestCandidates.length > 0 ? Math.min(...oldestCandidates) : null
					return {
						queue: queue.name,
						source_queue: queue.sourceQueue,
						depth: parkedCount + (backlog?.backlogCount ?? 0),
						oldest_message_at: iso(oldest),
						oldest_message_age_seconds: ageSeconds(oldest, nowMs),
						parked_count: parkedCount,
						parked_oldest_enqueued_at: iso(parkedOldest),
						cloudflare: backlog
							? {
									backlog_count: backlog.backlogCount,
									oldest_message_at: iso(backlog.oldestMessageTimestampMs),
									oldest_message_age_seconds: ageSeconds(
										backlog.oldestMessageTimestampMs,
										nowMs,
									),
								}
							: null,
						cloudflare_error:
							metrics instanceof Error ? metrics.message : cloudflare.error,
						replay_supported: queue.replay.kind !== 'unsupported',
						replay_unsupported_reason:
							queue.replay.kind === 'unsupported' ? queue.replay.reason : null,
					}
				}),
			}
		},
	},
)
