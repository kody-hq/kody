import { z } from 'zod'
import {
	AdminMailboxMessageNotFoundError,
	adminMailboxMaintenanceRetentionMaxLimit,
	loadAdminMailboxMaintenanceStatus,
	runAdminMailboxMaintenanceDeleteMessage,
	runAdminMailboxMaintenanceRetention,
} from '#worker/admin/mailbox-maintenance.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	adminStableOwnerId,
	auditAdminCapabilityInvocation,
	stableUserIdSchema,
} from './admin-shared.ts'

const retentionLimitSchema = z
	.number()
	.int()
	.min(1)
	.max(adminMailboxMaintenanceRetentionMaxLimit)
	.optional()
	.describe(
		`Optional owner page size (1–${adminMailboxMaintenanceRetentionMaxLimit}). Defaults to ${adminMailboxMaintenanceRetentionMaxLimit}.`,
	)

const mailboxCountSchema = z.object({
	threads: z.number().int().nonnegative(),
	messages: z.number().int().nonnegative(),
	attachments: z.number().int().nonnegative(),
	deliveryEvents: z.number().int().nonnegative(),
})

const outboundProviderIndexHealthSchema = z.object({
	indexCount: z
		.number()
		.int()
		.nonnegative()
		.describe('Rows in email_outbound_provider_index.'),
	distinctOwnerCount: z.number().int().nonnegative(),
	malformedCount: z.number().int().nonnegative(),
	healthy: z
		.boolean()
		.describe('True when every thin index row is structurally valid.'),
})

const statusSchema = z.object({
	generatedAt: z.string(),
	authority: z
		.object({
			ownerCount: z.number().int().nonnegative(),
			frozenAt: z.string(),
			droppedAt: z
				.string()
				.nullable()
				.describe(
					'Null while approval schema 0134 is deployed before drop 0135.',
				),
		})
		.nullable(),
	outboundProviderIndex: outboundProviderIndexHealthSchema.describe(
		'Fleet-wide aggregate thin D1 outbound provider reverse-index health.',
	),
	providerIndexRepair: z.object({
		pendingOwners: z.number().int().nonnegative(),
		pendingCount: z.number().int().nonnegative(),
		oldestPendingAt: z.string().nullable(),
	}),
	inboundDueOwners: z.object({
		pendingOwners: z.number().int().nonnegative(),
		dueOwners: z.number().int().nonnegative(),
		oldestDueAt: z.string().nullable(),
	}),
	deliveryAlerts: z.object({
		retainedEvents: z.number().int().nonnegative(),
		lastHourEvents: z.number().int().nonnegative(),
		oldestEventAt: z.string().nullable(),
	}),
	systemEmail: z.object({
		authority: z.object({
			authority: z.literal('dedicated'),
			cutoverAt: z.string(),
		}),
		counts: mailboxCountSchema,
		invalidReferenceCount: z.number().int().nonnegative(),
		providerLinkCount: z.number().int().nonnegative(),
		healthy: z.boolean(),
	}),
})

const retentionMetricsSchema = z.object({
	mailbox: z.object({
		ownersAttempted: z.number().int().nonnegative(),
		ownersSucceeded: z.number().int().nonnegative(),
		ownersFailed: z.number().int().nonnegative(),
		before: mailboxCountSchema,
		after: mailboxCountSchema,
		blobDeleteFailureOwners: z.number().int().nonnegative(),
		expiredRemainingOwners: z.number().int().nonnegative(),
	}),
})

const deleteMessageResultSchema = z.object({
	authoritativeMessageAbsent: z
		.boolean()
		.describe('True when the authoritative message is gone after delete.'),
	attachmentsSeen: z
		.number()
		.int()
		.nonnegative()
		.describe('Attachment metadata rows captured at delete time.'),
	externalAttachmentsSeen: z
		.number()
		.int()
		.nonnegative()
		.describe('External-storage attachment rows captured at delete time.'),
	rawMimeBlobAbsent: z
		.boolean()
		.describe(
			'True when head() finds no object for every captured raw-MIME blob key.',
		),
	externalAttachmentBlobsAbsent: z
		.number()
		.int()
		.nonnegative()
		.describe(
			'Count of captured attachment blob keys with no R2 object after delete.',
		),
	allCapturedBlobsAbsent: z
		.boolean()
		.describe(
			'True when every captured authoritative Mailbox blob key is absent via head.',
		),
})

const inputSchema = z.discriminatedUnion('action', [
	z
		.object({
			action: z.literal('status'),
		})
		.strict(),
	z
		.object({
			action: z.literal('retention'),
			limit: retentionLimitSchema,
			start_after_user_id: stableUserIdSchema
				.optional()
				.describe(
					'Stable-user-id keyset cursor from a prior retention nextStartAfter. Ordered by stable_user_id ASC.',
				),
		})
		.strict(),
	z
		.object({
			action: z.literal('delete_message'),
			stable_user_id: stableUserIdSchema.describe(
				'Owning users.stable_user_id. Foreign or missing messages are rejected.',
			),
			message_id: z
				.string()
				.min(1)
				.describe('Authoritative Mailbox message id to delete for the owner.'),
		})
		.strict(),
])

const outputSchema = z.discriminatedUnion('action', [
	z.object({
		action: z.literal('status'),
		status: statusSchema,
	}),
	z.object({
		action: z.literal('retention'),
		metrics: retentionMetricsSchema,
		nextStartAfter: stableUserIdSchema
			.nullable()
			.describe(
				'Pass as start_after_user_id on the next call when truncated is true.',
			),
		truncated: z
			.boolean()
			.describe(
				'True when more owners remain (full page) or the wall-clock budget stopped scheduling.',
			),
		status: statusSchema,
	}),
	z.object({
		action: z.literal('delete_message'),
		result: deleteMessageResultSchema,
	}),
])

export const adminMailboxMaintenanceCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminMailboxMaintenance',
		contextRuns: 'deny',
		description:
			'Admin-only Mailbox retention/delete maintenance and structural status: final authority marker, provider repair, due-owner and delivery-alert health, thin provider-index counts, dedicated system-email counts/health, keyset-paged Mailbox retention, or owner-scoped delete_message. Audited.',
		keywords: [
			'admin',
			'mailbox',
			'maintenance',
			'provider-index',
			'system-email-graph',
			'retention',
			'delete',
			'cutover',
		],
		destructive: true,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminMailboxMaintenance',
				async () => {
					switch (args.action) {
						case 'status': {
							const status = await loadAdminMailboxMaintenanceStatus({
								db: ctx.env.APP_DB,
							})
							return { action: 'status' as const, status }
						}
						case 'retention': {
							const result = await runAdminMailboxMaintenanceRetention({
								env: ctx.env,
								limit: args.limit,
								startAfterUserId: args.start_after_user_id,
							})
							return {
								action: 'retention' as const,
								metrics: result.metrics,
								nextStartAfter: result.nextStartAfter,
								truncated: result.truncated,
								status: result.status,
							}
						}
						case 'delete_message': {
							try {
								const result = await runAdminMailboxMaintenanceDeleteMessage({
									env: ctx.env,
									stableUserId: adminStableOwnerId(args.stable_user_id),
									messageId: args.message_id,
								})
								return { action: 'delete_message' as const, result }
							} catch (error) {
								// Missing/foreign canary targets are caller-supplied ids that
								// do not resolve — keep them off Sentry via McpCallerError.
								if (error instanceof AdminMailboxMessageNotFoundError) {
									throw new McpCallerError(error.message, { cause: error })
								}
								throw error
							}
						}
						default: {
							const exhaustive: never = args
							throw new Error(
								`Unhandled adminMailboxMaintenance action: ${JSON.stringify(exhaustive)}`,
							)
						}
					}
				},
				{
					successReason: (result) => {
						switch (result.action) {
							case 'status':
								return `action=status;cutover_owners=${result.status.authority?.ownerCount ?? -1};provider_repairs=${result.status.providerIndexRepair.pendingCount};due_owners=${result.status.inboundDueOwners.dueOwners};system_email_healthy=${result.status.systemEmail.healthy ? 1 : 0}`
							case 'retention':
								return `action=retention;attempted=${result.metrics.mailbox.ownersAttempted};succeeded=${result.metrics.mailbox.ownersSucceeded};truncated=${result.truncated ? 1 : 0}`
							case 'delete_message': {
								const targetStableUserId =
									args.action === 'delete_message'
										? args.stable_user_id
										: 'unknown'
								const targetMessageId =
									args.action === 'delete_message' ? args.message_id : 'unknown'
								return `action=delete_message;stable_user_id=${targetStableUserId};message_id=${targetMessageId};authoritative_absent=${result.result.authoritativeMessageAbsent ? 1 : 0};blobs_absent=${result.result.allCapturedBlobsAbsent ? 1 : 0}`
							}
							default: {
								const exhaustive: never = result
								return `action=unknown;${JSON.stringify(exhaustive)}`
							}
						}
					},
				},
			)
		},
	},
)
