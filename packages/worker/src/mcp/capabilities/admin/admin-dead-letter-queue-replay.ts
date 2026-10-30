import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { sendDeadLetterBodyToSourceQueue } from '#worker/dead-letter/replay.ts'
import { reportDeadLetterFailure } from '#worker/dead-letter/report.ts'
import {
	claimDeadLetterMessageForReplay,
	deleteParkedDeadLetterMessage,
	getParkedDeadLetterMessage,
	releaseDeadLetterReplayClaim,
} from '#worker/dead-letter/store.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	resolveActingAdminPerson,
} from './admin-shared.ts'
import {
	deadLetterAuditReason,
	deadLetterMessageIdSchema,
	deadLetterQueueNameSchema,
	requireDeadLetterQueue,
} from './dead-letter-queue-shared.ts'

/** A replay that crashed between send and delete can be retried after this. */
export const deadLetterReplayStaleClaimMs = 5 * 60 * 1000

const inputSchema = z.object({
	queue: deadLetterQueueNameSchema,
	message_id: deadLetterMessageIdSchema,
})

const outputSchema = z.object({
	queue: z.string(),
	message_id: z.string(),
	source_queue: z.string(),
	outcome: z.literal('replayed'),
})

export const adminDeadLetterQueueReplayCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminDeadLetterQueueReplay',
		contextRuns: 'deny',
		description:
			'Replay one parked dead-letter message to its source queue (for example kody-platform-feedback-dispatch-dlq to kody-platform-feedback-dispatch), then remove it from the dead-letter queue. The source consumer runs it again with fresh retries. Queues without a producer binding (email delivery, Artifacts repo events) report replay as unsupported; ack those instead. Admin-only and audit-logged.',
		keywords: ['admin', 'dead letter queue', 'dlq', 'replay', 'retry'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			await resolveActingAdminPerson(ctx)
			const queue = requireDeadLetterQueue(args.queue)
			const ids = `queue=${queue.name};message_id=${args.message_id}`
			return auditAdminCapabilityInvocation(
				ctx,
				'adminDeadLetterQueueReplay',
				async () => {
					if (queue.replay.kind === 'unsupported') {
						throw new McpCallerError(
							`Replay is unsupported for ${ids}: ${queue.replay.reason}`,
						)
					}
					const message = await getParkedDeadLetterMessage(ctx.env.APP_DB, {
						deadLetterQueue: queue.name,
						messageId: args.message_id,
					})
					if (!message) {
						throw new McpCallerError(`Dead-letter message not found: ${ids}.`)
					}
					if (message.bodyJson === null) {
						throw new McpCallerError(
							`Dead-letter message body was not JSON and cannot be replayed: ${ids}. Ack it instead.`,
						)
					}
					const claimed = await claimDeadLetterMessageForReplay(
						ctx.env.APP_DB,
						{
							deadLetterQueue: queue.name,
							messageId: message.messageId,
							nowMs: Date.now(),
							staleClaimMs: deadLetterReplayStaleClaimMs,
						},
					)
					if (!claimed) {
						throw new McpCallerError(
							`Dead-letter message is already being replayed: ${ids}.`,
						)
					}
					try {
						await sendDeadLetterBodyToSourceQueue({
							env: ctx.env,
							queue,
							body: JSON.parse(message.bodyJson) as unknown,
						})
					} catch (error) {
						reportDeadLetterFailure({
							stage: 'replay',
							queue: queue.name,
							messageId: message.messageId,
							attempts: message.attempts,
							error,
						})
						await releaseDeadLetterReplayClaim(ctx.env.APP_DB, {
							deadLetterQueue: queue.name,
							messageId: message.messageId,
						}).catch(() => {})
						throw new Error(
							`Replay send failed for ${ids}: ${error instanceof Error ? error.message : String(error)}`,
							{ cause: error },
						)
					}
					try {
						await deleteParkedDeadLetterMessage(ctx.env.APP_DB, {
							deadLetterQueue: queue.name,
							messageId: message.messageId,
						})
					} catch (error) {
						reportDeadLetterFailure({
							stage: 'replay',
							queue: queue.name,
							messageId: message.messageId,
							attempts: message.attempts,
							error,
						})
						throw new Error(
							`Replayed but could not remove the parked row for ${ids}; ack it with adminDeadLetterQueueAck so it is not replayed twice.`,
							{ cause: error },
						)
					}
					return {
						queue: queue.name,
						message_id: message.messageId,
						source_queue: queue.sourceQueue,
						outcome: 'replayed' as const,
					}
				},
				{
					successReason: (result) =>
						deadLetterAuditReason({
							queue: result.queue,
							message_id: result.message_id,
							source_queue: result.source_queue,
							outcome: result.outcome,
						}),
				},
			)
		},
	},
)
