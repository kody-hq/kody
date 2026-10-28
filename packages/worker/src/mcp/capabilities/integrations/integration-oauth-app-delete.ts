import { orgAuditWriterFromCaller } from '#worker/orgs/org-audit.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { authorizeIntegrationOrgWide } from '#mcp/capabilities/integrations/authorize-integration.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { deleteOauthAppWithConnections } from '#worker/integrations/service.ts'

const inputSchema = z.object({
	slug: z
		.string()
		.min(1)
		.describe(
			'User-lane OAuth app slug to delete, including every connection.',
		),
})

const outputSchema = z.object({
	deleted: z.boolean(),
	connectionNames: z.array(z.string()),
})

export const integrationOauthAppDeleteCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'integrationOauthAppDelete',
		contextRuns: 'deny',
		orgPermission: 'integration:delete',
		description:
			'Delete a user-registered OAuth app and every connection on it. Built-in (platform) apps cannot be deleted this way — disconnect their connections with integrationDelete instead.',
		keywords: ['integration', 'oauth', 'app', 'delete', 'remove', 'connection'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			await authorizeIntegrationOrgWide(ctx, 'integration:delete')
			return deleteOauthAppWithConnections({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
				slug: args.slug,
				audit: orgAuditWriterFromCaller(ctx.env, ctx.callerContext),
			})
		},
	},
)
