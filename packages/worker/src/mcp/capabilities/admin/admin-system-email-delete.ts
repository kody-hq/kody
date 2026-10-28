import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { deleteSystemEmailMessageById } from '#worker/email/system-email-graph-store.ts'
import { systemEmailOwnerId } from '#worker/email/system-email.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z.object({
	message_id: z
		.string()
		.min(1)
		.describe(
			'Operator-owned system inbox message id to delete (from adminSystemEmailList / adminSystemEmailGet). Never a user-owned mailbox id.',
		),
})

const outputSchema = z.object({
	ownerId: z
		.string()
		.describe(
			'Reserved operator-owned storage owner id; not a user account id.',
		),
	deleted: z.literal(true),
	message_id: z.string(),
})

export const adminSystemEmailDeleteCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		destructive: true,
		name: 'adminSystemEmailDelete',
		contextRuns: 'deny',
		description:
			'Delete one operator-owned system inbox message, including stored attachments, charged delivery-event rows, raw MIME / attachment blobs, and an empty parent thread. Matching SMTP redeliveries stay discarded until the inbound dedupe window expires. Admin-only; never deletes user-owned email.',
		keywords: [
			'admin',
			'system email',
			'message',
			'delete',
			'remove',
			'abuse',
			'phishing',
			'postmaster',
			'psl',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminSystemEmailDelete',
				async () => {
					const deletion = await deleteSystemEmailMessageById({
						db: ctx.env.APP_DB,
						blobs: ctx.env.EMAIL_BLOBS,
						messageId: args.message_id,
					})
					if (!deletion.messageFound) {
						throw new Error(
							`System email message not found: ${args.message_id}`,
						)
					}
					return {
						ownerId: systemEmailOwnerId,
						deleted: true as const,
						message_id: args.message_id,
					}
				},
				{
					successReason: () => `target_message_id=${args.message_id}`,
				},
			)
		},
	},
)
