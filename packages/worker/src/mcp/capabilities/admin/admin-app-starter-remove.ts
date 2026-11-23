import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import { removeAppStarter } from '#worker/app-starters/service.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import {
	appStartersOutputSchema,
	runAppStarterMutation,
} from './app-starter-shared.ts'

export const adminAppStarterRemoveCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminAppStarterRemove',
		contextRuns: 'deny',
		description:
			'Take a package off the recommended app starters list. The package itself stays as it is. Admin-only.',
		keywords: ['admin', 'app starter', 'starter', 'remove'],
		inputSchema: z.object({
			package_id: z
				.string()
				.min(1)
				.describe('Starter package id from adminAppStarterList.'),
		}),
		outputSchema: appStartersOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminAppStarterRemove',
				() =>
					runAppStarterMutation(async () => ({
						starters: await removeAppStarter({
							env: ctx.env,
							packageId: args.package_id,
						}),
					})),
				{ successReason: () => `package_id=${args.package_id}` },
			)
		},
	},
)
