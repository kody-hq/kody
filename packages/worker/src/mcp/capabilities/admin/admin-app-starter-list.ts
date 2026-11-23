import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import { listAdminAppStarters } from '#worker/app-starters/service.ts'
import { adminCapabilityAccess } from './admin-shared.ts'
import { appStartersOutputSchema } from './app-starter-shared.ts'

export const adminAppStarterListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminAppStarterList',
		contextRuns: 'deny',
		description:
			"List the app starters recommended to agents, in rank order, with each package's kody.starter manifest and anything that keeps it from being recommended. Admin-only.",
		keywords: ['admin', 'app starter', 'starter', 'template', 'recommended'],
		inputSchema: z.object({}),
		outputSchema: appStartersOutputSchema,
		async handler(_args, ctx: CapabilityContext) {
			return { starters: await listAdminAppStarters(ctx.env) }
		},
	},
)
