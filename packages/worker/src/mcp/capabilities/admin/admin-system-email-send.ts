import { z } from 'zod'
import { redactEmailRecipient } from '#worker/audit-log.ts'
import {
	maxSystemOutboundRecipients,
	sendSystemEmail,
} from '#worker/email/system-outbound.ts'
import { systemEmailLocals } from '#worker/email/system-email.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z
	.object({
		to: z
			.union([
				z.string().min(1),
				z.array(z.string().min(1)).min(1).max(maxSystemOutboundRecipients),
			])
			.describe(
				`Recipient address, or up to ${maxSystemOutboundRecipients} addresses for one message. Transactional correspondence only — this is not a mailing list.`,
			),
		subject: z.string().min(1),
		text: z.string().min(1).optional(),
		html: z.string().min(1).optional(),
		from_local: z
			.enum(systemEmailLocals)
			.optional()
			.describe(
				'Reserved system sender local part. Defaults to kody, the transactional sender.',
			),
		reply_to: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional Reply-To. Mail from kody@ defaults to support@ on the same apex; an explicit value wins. Other system senders do not default.',
			),
		headers: z
			.record(z.string(), z.string())
			.optional()
			.describe(
				'Optional extra MIME headers. Use for campaign previews that need List-Unsubscribe.',
			),
	})
	.refine((value) => value.text || value.html, {
		message: 'Email text or HTML body is required.',
		path: ['text'],
	})

const outputSchema = z.object({
	from: z.string(),
	to: z.array(z.string()),
	provider_message_id: z.string().nullable(),
})

export const adminSystemEmailSendCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminSystemEmailSend',
		contextRuns: 'deny',
		description:
			'Send operator correspondence from a reserved system sender (kody@<apex> by default) to an external recipient. Admin-only and audit-logged; capped per sender per day. Mail from kody@ sets Reply-To to support@<apex> unless reply_to is provided. Use emailSend/emailReply for user mail — this sender speaks for the platform, not for a user account.',
		keywords: [
			'admin',
			'system email',
			'send',
			'outreach',
			'transactional',
			'kody@',
			'psl@',
			'operator',
			'reply to feedback',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminSystemEmailSend',
				async () => {
					const result = await sendSystemEmail({
						env: ctx.env,
						localPart: args.from_local,
						to: args.to,
						subject: args.subject,
						text: args.text ?? null,
						html: args.html ?? null,
						replyTo: args.reply_to ?? null,
						headers: args.headers,
						waitUntil: ctx.waitUntil,
					})
					return {
						from: result.from,
						to: result.to,
						provider_message_id: result.providerMessageId,
					}
				},
				{
					successReason: (result) =>
						[
							`from=${result.from}`,
							`to=${result.to.map(redactEmailRecipient).join(',')}`,
						].join(';'),
				},
			)
		},
	},
)
