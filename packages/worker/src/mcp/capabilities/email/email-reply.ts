import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	emailOwnerOrgId,
	requireVerifiedEmailAccountUser,
} from './require-verified-user.ts'
import { sendOutboundEmail } from '#worker/email/outbound.ts'
import { mailboxRpc } from '#worker/email/mailbox-client.ts'
import { mailboxMessageToEmailMessageRecord } from '#worker/email/mailbox-record-mappers.ts'
import {
	emailMessageSummarySchema,
	emailOutboundAttachmentsInputSchema,
	stringArray,
	toMessageSummary,
	toOutboundEmailAttachments,
} from './shared.ts'

export const emailReplyCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'emailReply',
		orgPermission: 'email:send',
		description:
			'Reply to a stored inbound email from your platform-assigned {username}@<platform domain> address, preserving thread headers and optionally attaching files (base64 content). The recipient always comes from the stored message. Refuses with quarantined_inbound_reply when that message is still quarantined, before any send or daily send quota is used, because replies to quarantined mail usually reach spoofed senders. Release it first with emailMessageClassify (classification "accepted") or Not spam on the email inbox page, then reply.',
		keywords: [
			'email',
			'reply',
			'thread',
			'message',
			'attachment',
			'quarantine',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z
			.object({
				message_id: z.string().min(1),
				text: z.string().min(1).optional(),
				html: z.string().min(1).optional(),
				attachments: emailOutboundAttachmentsInputSchema,
			})
			.refine((value) => value.text !== undefined || value.html !== undefined, {
				message: 'Email text or HTML body is required.',
				path: ['text'],
			}),
		outputSchema: emailMessageSummarySchema,
		async handler(args, ctx) {
			const user = await requireVerifiedEmailAccountUser(ctx)
			const originalRecord = await mailboxRpc({
				env: ctx.env,
				userId: emailOwnerOrgId(ctx, user),
			}).getMessage({
				messageId: args.message_id,
			})
			const original = originalRecord
				? mailboxMessageToEmailMessageRecord(
						originalRecord,
						emailOwnerOrgId(ctx, user),
					)
				: null
			if (!original)
				throw new Error(`Email message not found: ${args.message_id}`)
			// The recipient is derived from the stored message inside
			// sendOutboundEmail; this capability never chooses it.
			const result = await sendOutboundEmail({
				env: ctx.env,
				userId: emailOwnerOrgId(ctx, user),
				actorPersonId: user.userId,
				request: ctx.callerContext.request,
				accountEmail: user.email,
				recipientPolicy: 'reply',
				replyToMessageId: original.id,
				subject: original.subject?.toLowerCase().startsWith('re:')
					? original.subject
					: `Re: ${original.subject ?? '(no subject)'}`,
				text: args.text ?? null,
				html: args.html ?? null,
				attachments: toOutboundEmailAttachments(args.attachments),
				inReplyToHeader: original.messageIdHeader ?? null,
				references: [
					...stringArray(original.references),
					...(original.messageIdHeader ? [original.messageIdHeader] : []),
				],
				threadId: original.threadId,
				inboxId: original.inboxId,
			})
			if (result.status === 'failed') {
				throw new Error(
					`Email reply delivery failed: ${result.error ?? 'Unknown provider error.'}`,
				)
			}
			return toMessageSummary(result.message)
		},
	},
)
