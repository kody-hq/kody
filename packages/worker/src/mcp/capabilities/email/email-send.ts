import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	emailOwnerOrgId,
	requireVerifiedEmailAccountUser,
} from './require-verified-user.ts'
import { sendOutboundEmail } from '#worker/email/outbound.ts'
import {
	emailMessageSummarySchema,
	emailOutboundAttachmentsInputSchema,
	toMessageSummary,
	toOutboundEmailAttachments,
} from './shared.ts'

const emailSendInputSchema = z
	.object({
		to: z
			.union([z.string().min(1), z.array(z.string().min(1)).min(1)])
			.optional(),
		subject: z.string().min(1),
		text: z.string().min(1).optional(),
		html: z.string().min(1).optional(),
		from: z.string().min(1).optional(),
		reply_to: z.string().min(1).optional(),
		attachments: emailOutboundAttachmentsInputSchema,
	})
	.refine((value) => value.text || value.html, {
		message: 'Email text or HTML body is required.',
		path: ['text'],
	})

export const emailSendCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'emailSend',
		contextRuns: 'allow',
		orgPermission: 'email:send',
		description:
			'Send email from your platform-assigned {username}@<platform domain> to your verified email destinations, optionally attaching files (base64 content). Pass `from` to send from a plus alias of that address ({username}+{tag}@<platform domain>, tag of letters, digits, ".", "_", "-") so replies come back to the alias; any other From (another handle, domain, or a malformed tag) is refused. A plus-alias From also sets Reply-To to the alias unless `reply_to` is given. Destinations expand the allowed to set; Kody is not an open relay. Omit `to` to use the default destination. Every explicit address must be the verified identity email or a verified extra destination; if any `to` is missing or unverified the whole send fails. With attachments, the whole message must fit the plan email_message_bytes cap. Use emailReply to answer stored inbound mail.',
		keywords: [
			'email',
			'send',
			'mail',
			'outbound',
			'notify',
			'attachment',
			'alias',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: emailSendInputSchema,
		outputSchema: z.object({
			message: emailMessageSummarySchema,
			provider_message_id: z.string().nullable(),
			status: z.string(),
			error: z.string().nullable(),
		}),
		async handler(args, ctx) {
			const user = await requireVerifiedEmailAccountUser(ctx)
			const result = await sendOutboundEmail({
				env: ctx.env,
				userId: emailOwnerOrgId(ctx, user),
				actorPersonId: user.userId,
				request: ctx.callerContext.request,
				accountEmail: user.email,
				recipientPolicy: 'self',
				to: args.to ?? null,
				subject: args.subject,
				text: args.text ?? null,
				html: args.html ?? null,
				from: args.from ?? null,
				replyTo: args.reply_to ?? null,
				attachments: toOutboundEmailAttachments(args.attachments),
			})
			return {
				message: toMessageSummary(result.message),
				provider_message_id: result.providerMessageId,
				status: result.status,
				error: result.error,
			}
		},
	},
)
