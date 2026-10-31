import { z } from 'zod'
import { loadAdminSystemEmailMessageById } from '#worker/admin/system-email-data.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import { adminSystemEmailListItemSchema } from './admin-system-email-list.ts'

const inputSchema = z.object({
	id: z.string().min(1).describe('System email message id to read.'),
})

const attachmentSchema = z.object({
	id: z.string(),
	filename: z.string().nullable(),
	content_type: z.string().nullable(),
	content_id: z.string().nullable(),
	disposition: z.string().nullable(),
	size: z.number().int().nonnegative(),
	storage_kind: z.string(),
	created_at: z.string(),
})

const systemEmailDetailSchema = adminSystemEmailListItemSchema.extend({
	to_addresses: z.array(z.string()),
	cc_addresses: z.array(z.string()),
	reply_to_addresses: z.array(z.string()),
	headers: z.record(z.string(), z.array(z.string())),
	text_body: z.string().nullable(),
	html_body: z.string().nullable(),
	raw_mime: z.string().nullable(),
	attachments: z.array(attachmentSchema),
})

const outputSchema = z.object({
	message: systemEmailDetailSchema.nullable(),
})

export const adminSystemEmailGetCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminSystemEmailGet',
		contextRuns: 'deny',
		description:
			'Read one operator-owned system inbox message, including body content and attachment metadata. Admin-only; never reads user-owned email.',
		keywords: [
			'admin',
			'system email',
			'message content',
			'abuse',
			'postmaster',
			'psl',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminSystemEmailGet',
				async () => {
					const message = await loadAdminSystemEmailMessageById(
						ctx.env.APP_DB,
						args.id,
						ctx.env.EMAIL_BLOBS,
					)
					return { message }
				},
				{
					successReason: (result) =>
						result.message
							? `target_message_id=${result.message.id}`
							: `target_message_id=${args.id};not_found`,
				},
			)
		},
	},
)
