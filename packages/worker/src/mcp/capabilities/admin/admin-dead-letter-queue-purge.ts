import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import { reportDeadLetterFailure } from '#worker/dead-letter/report.ts'
import { purgeParkedDeadLetterMessages } from '#worker/dead-letter/store.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	resolveActingAdminPerson,
} from './admin-shared.ts'
import {
	deadLetterAuditReason,
	deadLetterQueueNameSchema,
	requireDeadLetterQueue,
} from './dead-letter-queue-shared.ts'

const maxReturnedMessageIds = 100

const inputSchema = z.object({
	queue: deadLetterQueueNameSchema,
	confirm: z
		.string()
		.describe(
			'Must equal the queue name exactly. Guards against purging the wrong queue.',
		),
})

const outputSchema = z.object({
	queue: z.string(),
	purged_count: z.number().int(),
	message_ids: z.array(z.string()),
	message_ids_truncated: z.boolean(),
	outcome: z.literal('purged'),
})

export const adminDeadLetterQueuePurgeCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		destructive: true,
		name: 'adminDeadLetterQueuePurge',
		contextRuns: 'deny',
		description:
			'Purge every parked message from one production dead-letter queue without replaying. Requires confirm to equal the queue name. Prefer adminDeadLetterQueueAck for single messages. Admin-only; audit-logs each purged message id.',
		keywords: ['admin', 'dead letter queue', 'dlq', 'purge', 'clear'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const admin = await resolveActingAdminPerson(ctx)
			const queue = requireDeadLetterQueue(args.queue)
			return auditAdminCapabilityInvocation(
				ctx,
				'adminDeadLetterQueuePurge',
				async () => {
					if (args.confirm !== queue.name) {
						throw new McpCallerError(
							`Purge not confirmed for queue=${queue.name}: confirm must equal the queue name exactly.`,
						)
					}
					let messageIds: Array<string>
					try {
						messageIds = await purgeParkedDeadLetterMessages(ctx.env.APP_DB, {
							deadLetterQueue: queue.name,
						})
					} catch (error) {
						reportDeadLetterFailure({
							stage: 'purge',
							queue: queue.name,
							error,
						})
						throw new Error(`Purge failed for queue=${queue.name}.`, {
							cause: error,
						})
					}
					for (const messageId of messageIds) {
						await logAuditEvent({
							db: auditDatabaseFromEnv(ctx.env),
							category: 'admin',
							action: 'adminDeadLetterQueuePurge',
							result: 'success',
							email: admin.email,
							path: '/mcp',
							reason: deadLetterAuditReason({
								queue: queue.name,
								message_id: messageId,
								outcome: 'purged',
							}),
						})
					}
					return {
						queue: queue.name,
						purged_count: messageIds.length,
						message_ids: messageIds.slice(0, maxReturnedMessageIds),
						message_ids_truncated: messageIds.length > maxReturnedMessageIds,
						outcome: 'purged' as const,
					}
				},
				{
					successReason: (result) =>
						deadLetterAuditReason({
							queue: result.queue,
							purged_count: result.purged_count,
							outcome: result.outcome,
						}),
				},
			)
		},
	},
)
