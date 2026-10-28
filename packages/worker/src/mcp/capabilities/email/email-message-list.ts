import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { listOwnerEmailMessages } from '#worker/email/owner-email-reader.ts'
import {
	emailClassificationValues,
	emailDeliveryStatusValues,
} from '#worker/email/types.ts'
import {
	emailOwnerOrgId,
	requireVerifiedEmailAccountUser,
} from './require-verified-user.ts'
import {
	emailMessageSummarySchema,
	emailMessageViewInputSchema,
	resolveEmailMessageView,
	toMessageSummary,
} from './shared.ts'

export const emailMessageListCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'emailMessageList',
		contextRuns: 'allow',
		orgPermission: 'email:read',
		description:
			'List stored inbound and outbound email messages for the current org. The default "inbox" view hides messages marked as spam and archived messages; pass view "spam", "archived", or "all" to see them.',
		keywords: [
			'email',
			'message',
			'inbox',
			'list',
			'quarantine',
			'spam',
			'archive',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			inbox_id: z.string().min(1).optional(),
			direction: z.enum(['inbound', 'outbound']).optional(),
			processing_status: z.enum(['stored', 'sent', 'failed']).optional(),
			delivery_status: z.enum(emailDeliveryStatusValues).optional(),
			classification: z.enum(emailClassificationValues).optional(),
			view: emailMessageViewInputSchema,
			limit: z.number().int().positive().max(100).default(25),
		}),
		outputSchema: z.object({
			messages: z.array(emailMessageSummarySchema),
		}),
		async handler(args, ctx) {
			const user = await requireVerifiedEmailAccountUser(ctx)
			const messages = await listOwnerEmailMessages({
				env: ctx.env,
				ownerId: emailOwnerOrgId(ctx, user),
				inboxId: args.inbox_id ?? null,
				direction: args.direction ?? null,
				processingStatus: args.processing_status ?? null,
				deliveryStatus: args.delivery_status ?? null,
				classification: args.classification ?? null,
				view: resolveEmailMessageView(args),
				limit: args.limit,
			})
			return { messages: messages.map(toMessageSummary) }
		},
	},
)
