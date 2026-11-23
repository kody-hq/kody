import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import { addAppStarter } from '#worker/app-starters/service.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import {
	appStarterNoteSchema,
	appStarterRankSchema,
	appStartersOutputSchema,
	runAppStarterMutation,
} from './app-starter-shared.ts'

export const adminAppStarterAddCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminAppStarterAdd',
		contextRuns: 'deny',
		description:
			'Recommend an existing @kody package to agents as an app starter. Kody checks the published package.json kody.starter manifest, the app entry, and the public listing, and refuses the package with the failed fields named. Never creates packages. Admin-only.',
		keywords: ['admin', 'app starter', 'starter', 'template', 'add'],
		inputSchema: z.object({
			package: z
				.string()
				.min(1)
				.describe('The starter package, as `@kody/package-name`.'),
			rank: appStarterRankSchema,
			enabled: z
				.boolean()
				.optional()
				.describe('Defaults to true. Disabled starters stay on the list.'),
			note: appStarterNoteSchema,
		}),
		outputSchema: appStartersOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminAppStarterAdd',
				() =>
					runAppStarterMutation(async () => ({
						starters: await addAppStarter({
							env: ctx.env,
							packageRef: args.package,
							rank: args.rank,
							enabled: args.enabled,
							note: args.note,
						}),
					})),
				{ successReason: () => `package=${args.package}` },
			)
		},
	},
)
