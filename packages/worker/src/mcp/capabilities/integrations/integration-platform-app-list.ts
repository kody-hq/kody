import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	emptyCapabilityInputSchema,
	type CapabilityContext,
} from '#mcp/capabilities/types.ts'
import { listAvailablePlatformApps } from '#worker/integrations/service.ts'
import {
	platformOauthAppPublicSchema,
	toPlatformOauthAppPublic,
} from './platform-app-shared.ts'

const outputSchema = z.object({
	apps: z.array(platformOauthAppPublicSchema),
})

export const integrationPlatformAppListCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'integrationPlatformAppList',
		contextRuns: 'allow',
		orgPermission: 'integration:read',
		description:
			'List the published platform (built-in) OAuth apps this deployment offers. Each connects without a bring-your-own provider app at /connect/oauth?provider=<slug>&platform=<slug>. Often empty: operators publish built-ins individually, and every other provider connects with the user’s own OAuth app at /connect/oauth.',
		keywords: [
			'integration',
			'oauth',
			'platform',
			'built-in',
			'connect',
			'provider',
			'managed',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema,
		async handler(_args, ctx: CapabilityContext) {
			const apps = await listAvailablePlatformApps({ env: ctx.env })
			return { apps: apps.map(toPlatformOauthAppPublic) }
		},
	},
)
