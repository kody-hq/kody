import { orgAuditWriterFromCaller } from '#worker/orgs/org-audit.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { authorizeIntegration } from '#mcp/capabilities/integrations/authorize-integration.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { deleteIntegration } from '#worker/integrations/service.ts'
import { canonicalIntegrationName } from './integration-shared.ts'

const inputSchema = z.object({
	name: z.string().min(1).describe('Integration name to delete.'),
})

const outputSchema = z.object({
	deleted: z.boolean(),
})

export const integrationDeleteCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'integrationDelete',
		contextRuns: 'deny',
		orgPermission: 'integration:delete',
		description:
			'Delete a saved OAuth integration connection by name. When it is the last connection on its OAuth app, the unused app is removed too.',
		keywords: [
			'integration',
			'oauth',
			'config',
			'registry',
			'delete',
			'connection',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			await authorizeIntegration(
				ctx,
				'integration:delete',
				canonicalIntegrationName(args.name),
			)
			const deleted = await deleteIntegration({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
				name: args.name,
				audit: orgAuditWriterFromCaller(ctx.env, ctx.callerContext),
			})
			return { deleted }
		},
	},
)
