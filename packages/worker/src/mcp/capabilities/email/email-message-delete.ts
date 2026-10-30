import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { authorizeEmailMessageChange } from '#worker/email/authorize-email-message.ts'
import { deleteEmailMessage } from '#worker/email/service.ts'
import {
	emailOwnerOrgId,
	requireVerifiedEmailAccountUser,
} from './require-verified-user.ts'

export const emailMessageDeleteCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'emailMessageDelete',
		contextRuns: 'allow',
		orgPermission: 'email:delete',
		description:
			'Delete one stored email message for the current org. Frees a stored_email_messages slot so new inbound mail can be accepted again.',
		keywords: [
			'email',
			'message',
			'delete',
			'remove',
			'inbox',
			'quota',
			'stored',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			message_id: z.string().min(1),
		}),
		outputSchema: z.object({
			deleted: z.literal(true),
			message_id: z.string(),
		}),
		async handler(args, ctx) {
			const user = await requireVerifiedEmailAccountUser(ctx)
			const ownerId = emailOwnerOrgId(ctx, user)
			const message = await authorizeEmailMessageChange({
				env: ctx.env,
				request: ctx.callerContext.request,
				ownerId,
				messageId: args.message_id,
				permission: 'email:delete',
			})
			const deleted = message
				? await deleteEmailMessage({
						env: ctx.env,
						db: ctx.env.APP_DB,
						userId: ownerId,
						messageId: args.message_id,
					})
				: false
			if (!deleted) {
				throw new McpCallerError(`Email message not found: ${args.message_id}`)
			}
			return {
				deleted: true as const,
				message_id: args.message_id,
			}
		},
	},
)
