import { z } from 'zod'
import { adminUserVerificationFilterValues } from '#universal/email-verification-delivery.ts'
import { loadAdminUsersData } from '#worker/admin/users-data.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	adminUserMetadataSchema,
	auditAdminCapabilityInvocation,
	roleNameSchema,
} from './admin-shared.ts'

const inputSchema = z.object({
	page: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe('One-indexed page of users to return. Defaults to 1.'),
	pageSize: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe('Users per page. Defaults to 20 and maxes at 100.'),
	query: z
		.string()
		.optional()
		.describe('Case-insensitive substring match on username or email.'),
	role: roleNameSchema
		.optional()
		.describe('Only return users holding this role (for example "admin").'),
	verification: z
		.enum(adminUserVerificationFilterValues)
		.optional()
		.describe(
			'Only return unverified person accounts whose latest signup/verify send is still accepted after 60 minutes with no Cloudflare lifecycle event.',
		),
})

const outputSchema = z.object({
	total: z.number().int().nonnegative(),
	page: z.number().int().positive(),
	pageSize: z.number().int().positive(),
	users: z.array(adminUserMetadataSchema),
})

export const adminUserListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminUserList',
		contextRuns: 'deny',
		description:
			'List account metadata for users, including roles. Admin-only; never returns user content. Unverified person accounts older than 7 days are purged automatically.',
		keywords: [
			'admin',
			'users',
			'accounts',
			'roles',
			'rbac',
			'verification',
			'stalled',
			'email verification',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(ctx, 'adminUserList', async () => {
				const url = new URL('https://kody.local/admin/users.json')
				if (args.page) url.searchParams.set('page', String(args.page))
				if (args.pageSize) {
					url.searchParams.set('pageSize', String(args.pageSize))
				}
				if (args.query) url.searchParams.set('q', args.query)
				if (args.role) url.searchParams.set('role', args.role)
				if (args.verification) {
					url.searchParams.set('verification', args.verification)
				}
				const data = await loadAdminUsersData(ctx.env, url.toString())
				return {
					total: data.total,
					page: data.page,
					pageSize: data.pageSize,
					users: data.users,
				}
			})
		},
	},
)
