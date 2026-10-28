import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { loadIntegrationListScope } from '#mcp/capabilities/integrations/authorize-integration.ts'
import { listScopeIncludes } from '#worker/authorization/authorize.ts'
import {
	emptyCapabilityInputSchema,
	type CapabilityContext,
} from '#mcp/capabilities/types.ts'
import { listIntegrations } from '#worker/integrations/service.ts'
import { integrationConfigSchema } from './integration-shared.ts'

const outputSchema = z.object({
	integrations: z.array(integrationConfigSchema),
})

export const integrationListCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'integrationList',
		contextRuns: 'allow',
		orgPermission: 'integration:read',
		description:
			'List saved OAuth integration connections. Call createAuthenticatedFetch(name) to use one. Do not persist access or refresh tokens with secretSet.',
		keywords: [
			'integration',
			'oauth',
			'config',
			'registry',
			'list',
			'connection',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema,
		async handler(_args, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			const [integrations, scope] = await Promise.all([
				listIntegrations({
					env: ctx.env,
					userId: ownerIdFromCaller(ctx.callerContext),
				}),
				loadIntegrationListScope(ctx, 'integration:read'),
			])
			return {
				integrations: integrations.filter((integration) =>
					listScopeIncludes(scope, integration.credentialId ?? ''),
				),
			}
		},
	},
)
