import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { softDeleteOrg } from '#worker/orgs/soft-delete.ts'

const inputSchema = z.object({
	orgId: z
		.string()
		.min(1)
		.describe(
			'Organization id to soft-delete. Must match the bound request org.',
		),
})

const outputSchema = z.object({
	orgId: z.string(),
	deletedAt: z.string(),
})

export const orgDeleteCapability = defineDomainCapability(
	capabilityDomainNames.orgs,
	{
		name: 'orgDelete',
		description:
			'Soft-delete an organization. Resources are tombstoned immediately and can be restored within 30 days.',
		keywords: ['org', 'delete', 'soft delete', 'team'],
		destructive: true,
		contextRuns: 'deny',
		orgPermission: 'org:delete',
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const request = requireMcpRequest(ctx.callerContext)
			if (args.orgId !== request.org.id) {
				throw new McpCallerError(
					'orgId must match the organization bound to this request.',
				)
			}
			return await softDeleteOrg({
				env: ctx.env,
				orgId: request.org.id,
				actorUserId: user.userId,
			})
		},
	},
)
