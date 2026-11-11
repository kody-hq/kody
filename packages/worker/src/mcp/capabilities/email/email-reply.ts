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

const recipientsNotAccepted = z
	.unknown()
	.optional()
	.describe(
		'Not accepted. Recipients come only from the stored message; use reply_all and drop_recipients.',
	)

const emailReplyOutputSchema = emailMessageSummarySchema.extend({
	cc_addresses: z.array(z.string()),
})

export const emailReplyCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'emailReply',
		contextRuns: 'allow',
		orgPermission: 'email:send',
		description:
			'Reply to a stored inbound email, preserving thread headers (In-Reply-To, References) and optionally attaching files (base64 content). The reply is sent from the address the original was sent to when that is your platform address {username}@<platform domain> or a plus alias of it ({username}+{tag}@), so a message to {username}+support@ is answered from {username}+support@ with Reply-To set to the alias and the thread stays on it. Otherwise it is sent from {username}@<platform domain>. Pass `from` to choose another plus alias of your own address; any other From is refused. Recipients always come from the stored message. By default the reply goes only to its sender (Reply-To, else From). Pass reply_all: true to reply to everyone on it: its Reply-To or From plus To on To, and Cc on Cc, minus the addresses of this inbox. Reply-all is allowed only on a thread the inbox owner put the inbox on (some message on the thread was sent from one of the verified email destinations of the owner with this inbox in To or Cc); later replies from other participants on that thread also qualify. Otherwise it refuses with reply_all_not_allowed. Pass drop_recipients to leave addresses off a reply-all; recipients can never be added and Bcc is never used (to, cc, and bcc are refused). Reply-all is capped at 5 sends per thread per 24 hours (reply_all_thread_limit), and the sent message records its To and Cc. Refuses with quarantined_inbound_reply when that message is still quarantined, before any send or daily send quota is used, because replies to quarantined mail usually reach spoofed senders. Release it first with emailMessageClassify (classification "accepted") or Not spam on the email inbox page, then reply.',
		keywords: [
			'email',
			'reply',
			'thread',
			'message',
			'attachment',
			'quarantine',
			'alias',
			'plus',
			'reply-all',
			'cc',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z
			.object({
				message_id: z.string().min(1),
				from: z.string().min(1).optional(),
				text: z.string().min(1).optional(),
				html: z.string().min(1).optional(),
				attachments: emailOutboundAttachmentsInputSchema,
				reply_all: z
					.boolean()
					.optional()
					.describe(
						'Reply to everyone on the stored message (Reply-To or From, To, Cc), minus this inbox. Only on threads the inbox owner put the inbox on.',
					),
				drop_recipients: z
					.array(z.string().min(1))
					.max(100)
					.optional()
					.describe(
						'With reply_all, addresses to leave off. Each must already be a recipient of the stored message.',
					),
				to: recipientsNotAccepted,
				cc: recipientsNotAccepted,
				bcc: recipientsNotAccepted,
			})
			.refine((value) => value.text !== undefined || value.html !== undefined, {
				message: 'Email text or HTML body is required.',
				path: ['text'],
			})
			.superRefine((value, ctx) => {
				for (const key of ['to', 'cc', 'bcc'] as const) {
					if (value[key] !== undefined) {
						ctx.addIssue({
							code: 'custom',
							path: [key],
							message: `emailReply does not accept ${key}: recipients come only from the stored message, and Bcc is never used. Use reply_all to include its To and Cc, and drop_recipients to leave addresses off.`,
						})
					}
				}
				if (value.drop_recipients !== undefined && value.reply_all !== true) {
					ctx.addIssue({
						code: 'custom',
						path: ['drop_recipients'],
						message: 'drop_recipients only applies with reply_all: true.',
					})
				}
			}),
		outputSchema: emailReplyOutputSchema,
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
				replyAll: args.reply_all
					? { dropRecipients: args.drop_recipients ?? [] }
					: null,
				from: args.from ?? null,
				subject: original.subject?.toLowerCase().startsWith('re:')
					? original.subject
					: `Re: ${original.subject ?? '(no subject)'}`,
				text: args.text ?? null,
				html: args.html ?? null,
				attachments: toOutboundEmailAttachments(args.attachments),
				inReplyToHeader: original.messageIdHeader ?? null,
				references: Array.from(
					new Set([
						...stringArray(original.references),
						...(original.messageIdHeader ? [original.messageIdHeader] : []),
					]),
				),
				threadId: original.threadId,
				inboxId: original.inboxId,
			})
			if (result.status === 'failed') {
				throw new Error(
					`Email reply delivery failed: ${result.error ?? 'Unknown provider error.'}`,
				)
			}
			return {
				...toMessageSummary(result.message),
				cc_addresses: stringArray(result.message.ccAddresses),
			}
		},
	},
)
