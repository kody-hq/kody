import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { searchOwnerEmailMessages } from '#worker/email/owner-email-reader.ts'
import {
	emailDeliveryStatusValues,
	emailDirectionValues,
	emailProcessingStatusValues,
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

export const emailMessageSearchCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'emailMessageSearch',
		contextRuns: 'allow',
		orgPermission: 'email:read',
		description:
			'Search stored email messages for the current org by case-insensitive substring match against subject, header From, and envelope sender. The default "inbox" view skips spam and archived messages; pass view "all" to search everything.',
		keywords: ['email', 'message', 'inbox', 'search', 'find', 'query'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			query: z
				.string()
				.trim()
				.min(1)
				.max(256)
				.describe(
					'Substring to match (case-insensitive) against subject, from address, and envelope sender.',
				),
			inbox_id: z.string().min(1).optional(),
			direction: z.enum(emailDirectionValues).optional(),
			processing_status: z.enum(emailProcessingStatusValues).optional(),
			delivery_status: z.enum(emailDeliveryStatusValues).optional(),
			view: emailMessageViewInputSchema,
			limit: z.number().int().positive().max(100).default(25),
		}),
		outputSchema: z.object({
			messages: z.array(emailMessageSummarySchema),
		}),
		async handler(args, ctx) {
			const user = await requireVerifiedEmailAccountUser(ctx)
			const messages = await searchOwnerEmailMessages({
				env: ctx.env,
				ownerId: emailOwnerOrgId(ctx, user),
				query: args.query,
				inboxId: args.inbox_id ?? null,
				direction: args.direction ?? null,
				processingStatus: args.processing_status ?? null,
				deliveryStatus: args.delivery_status ?? null,
				view: resolveEmailMessageView(args),
				limit: args.limit,
			})
			return { messages: messages.map(toMessageSummary) }
		},
	},
)
