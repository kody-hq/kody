import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { authorizeIntegration } from '#mcp/capabilities/integrations/authorize-integration.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { getIntegration } from '#worker/integrations/service.ts'
import {
	canonicalIntegrationName,
	integrationConfigSchema,
} from './integration-shared.ts'

const inputSchema = z.object({
	name: z.string().min(1).describe('Integration name to read.'),
})

const outputSchema = z.object({
	integration: integrationConfigSchema.nullable(),
})

export const integrationGetCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'integrationGet',
		contextRuns: 'allow',
		orgPermission: 'integration:read',
		description:
			'Read an OAuth integration connection by name. Tokens live on the connection — call createAuthenticatedFetch(name) or integrationTokenRefresh. Do not persist tokens with secretSet.',
		keywords: [
			'integration',
			'oauth',
			'config',
			'registry',
			'read',
			'connection',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			await authorizeIntegration(
				ctx,
				'integration:read',
				canonicalIntegrationName(args.name),
			)
			const integration = await getIntegration({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
				name: args.name,
			})
			return { integration }
		},
	},
)
