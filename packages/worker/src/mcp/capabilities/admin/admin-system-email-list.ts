import { z } from 'zod'
import { loadAdminSystemEmailData } from '#worker/admin/system-email-data.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	emailClassificationValues,
	emailMessageViewValues,
} from '#worker/email/types.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z.object({
	page: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe(
			'One-indexed page of system email messages to return. Defaults to 1.',
		),
	pageSize: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe('Messages per page. Defaults to 25 and maxes at 100.'),
	view: z
		.enum(emailMessageViewValues)
		.optional()
		.describe(
			'"inbox" (default) hides spam and archived mail; "accepted" / "quarantined" narrow the inbox; "spam" and "archived" show those folders; "all" returns everything.',
		),
})

export const adminSystemEmailListItemSchema = z.object({
	id: z.string(),
	inbox_local_part: z.string(),
	from_address: z.string().nullable(),
	envelope_from: z.string().nullable(),
	subject: z.string().nullable(),
	processing_status: z.string(),
	raw_size: z.number().int().nonnegative(),
	received_at: z.string().nullable(),
	created_at: z.string(),
	to_addresses: z.array(z.string()),
	classification: z.enum(emailClassificationValues),
	classification_reason: z.string().nullable(),
	archived_at: z.string().nullable(),
})

const outputSchema = z.object({
	total: z.number().int().nonnegative(),
	page: z.number().int().positive(),
	pageSize: z.number().int().positive(),
	view: z.enum(emailMessageViewValues),
	ownerId: z
		.string()
		.describe(
			'Reserved operator-owned storage owner id; not a user account id.',
		),
	systemLocals: z.array(z.string()),
	messages: z.array(adminSystemEmailListItemSchema),
})

export const adminSystemEmailListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminSystemEmailList',
		contextRuns: 'deny',
		description:
			'List operator-owned system inbox messages for reserved platform addresses, with classification and archive state. The default "inbox" view hides spam and archived mail; pass view "spam", "archived", or "all" to see them. Admin-only; never returns user-owned email.',
		keywords: [
			'admin',
			'system email',
			'operator inbox',
			'spam',
			'archive',
			'abuse',
			'postmaster',
			'psl',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminSystemEmailList',
				async () => {
					const url = new URL('https://kody.local/admin/system-email.json')
					if (args.page) url.searchParams.set('page', String(args.page))
					if (args.pageSize) {
						url.searchParams.set('pageSize', String(args.pageSize))
					}
					if (args.view) url.searchParams.set('view', args.view)
					const data = await loadAdminSystemEmailData(ctx.env, url.toString())
					return {
						total: data.total,
						page: data.page,
						pageSize: data.pageSize,
						view: data.view,
						ownerId: data.ownerId,
						systemLocals: data.systemLocals,
						messages: data.messages,
					}
				},
			)
		},
	},
)
