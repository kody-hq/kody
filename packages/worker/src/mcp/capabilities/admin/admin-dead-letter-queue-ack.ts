import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { reportDeadLetterFailure } from '#worker/dead-letter/report.ts'
import { deleteParkedDeadLetterMessage } from '#worker/dead-letter/store.ts'
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

const inputSchema = z.object({
	queue: deadLetterQueueNameSchema,
	message_id: deadLetterMessageIdSchema,
})

const outputSchema = z.object({
	queue: z.string(),
	message_id: z.string(),
	outcome: z.literal('acked'),
})

export const adminDeadLetterQueueAckCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		destructive: true,
		name: 'adminDeadLetterQueueAck',
		contextRuns: 'deny',
		description:
			'Ack (purge) one parked dead-letter message by id: permanently deletes it without replaying. Use after the failure has been triaged and the work is redone or not needed. Admin-only and audit-logged.',
		keywords: ['admin', 'dead letter queue', 'dlq', 'ack', 'purge', 'delete'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			await resolveActingAdminPerson(ctx)
			const queue = requireDeadLetterQueue(args.queue)
			const ids = `queue=${queue.name};message_id=${args.message_id}`
			return auditAdminCapabilityInvocation(
				ctx,
				'adminDeadLetterQueueAck',
				async () => {
					let deleted: boolean
					try {
						deleted = await deleteParkedDeadLetterMessage(ctx.env.APP_DB, {
							deadLetterQueue: queue.name,
							messageId: args.message_id,
						})
					} catch (error) {
						reportDeadLetterFailure({
							stage: 'ack',
							queue: queue.name,
							messageId: args.message_id,
							error,
						})
						throw new Error(`Ack failed for ${ids}.`, { cause: error })
					}
					if (!deleted) {
						throw new McpCallerError(`Dead-letter message not found: ${ids}.`)
					}
					return {
						queue: queue.name,
						message_id: args.message_id,
						outcome: 'acked' as const,
					}
				},
				{
					successReason: (result) =>
						deadLetterAuditReason({
							queue: result.queue,
							message_id: result.message_id,
							outcome: result.outcome,
						}),
				},
			)
		},
	},
)
