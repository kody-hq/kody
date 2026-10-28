import { z } from 'zod'
import { loadAdminUserByTarget } from '#worker/admin/users-data.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	adminUserMetadataSchema,
	auditAdminCapabilityInvocation,
	stableUserIdSchema,
} from './admin-shared.ts'

const inputSchema = z
	.object({
		stableUserId: stableUserIdSchema.optional(),
		email: z.string().email().optional().describe('Email address to look up.'),
		username: z.string().min(1).optional().describe('Username to look up.'),
	})
	.refine(
		(value) =>
			[value.stableUserId, value.email, value.username].filter(
				(item) => item !== undefined,
			).length === 1,
		{ message: 'Provide exactly one of stableUserId, email, or username.' },
	)

const outputSchema = z.object({
	user: adminUserMetadataSchema.nullable(),
})

export const adminUserGetCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminUserGet',
		contextRuns: 'deny',
		description:
			'Get one user account metadata record and roles by stable user id, email, or username. Admin-only; never returns user content.',
		keywords: ['admin', 'user', 'account', 'roles', 'lookup', 'rbac'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(ctx, 'adminUserGet', async () => {
				const user = await loadAdminUserByTarget(ctx.env.APP_DB, args)
				return { user }
			})
		},
	},
)
