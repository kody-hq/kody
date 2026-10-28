import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { getOwnerEmailAttachmentById } from '#worker/email/owner-email-reader.ts'
import {
	emailOwnerOrgId,
	requireVerifiedEmailAccountUser,
} from './require-verified-user.ts'

const emailAttachmentContentSchema = z.object({
	id: z.string(),
	message_id: z.string(),
	filename: z.string().nullable(),
	content_type: z.string().nullable(),
	content_id: z.string().nullable(),
	disposition: z.string().nullable(),
	size: z.number(),
	data_base64: z.string(),
})

export const emailAttachmentGetCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'emailAttachmentGet',
		contextRuns: 'allow',
		orgPermission: 'email:read',
		description:
			'Get one stored email attachment by id, returning metadata plus the attachment bytes as base64.',
		keywords: ['email', 'attachment', 'get', 'download'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			attachment_id: z.string().min(1),
		}),
		outputSchema: emailAttachmentContentSchema,
		async handler(args, ctx) {
			const user = await requireVerifiedEmailAccountUser(ctx)
			const attachment = await getOwnerEmailAttachmentById({
				env: ctx.env,
				ownerId: emailOwnerOrgId(ctx, user),
				blobs: ctx.env.EMAIL_BLOBS,
				attachmentId: args.attachment_id,
			})
			if (!attachment) {
				throw new Error(`Email attachment not found: ${args.attachment_id}`)
			}
			if (attachment.contentBase64 == null) {
				throw new Error(
					`Email attachment "${args.attachment_id}" is unavailable because the stored message has no raw MIME payload.`,
				)
			}
			return {
				id: attachment.id,
				message_id: attachment.messageId,
				filename: attachment.filename,
				content_type: attachment.contentType,
				content_id: attachment.contentId,
				disposition: attachment.disposition,
				size: attachment.size,
				data_base64: attachment.contentBase64,
			}
		},
	},
)
