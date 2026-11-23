import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import { updateAppStarter } from '#worker/app-starters/service.ts'
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

export const adminAppStarterUpdateCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		idempotent: true,
		name: 'adminAppStarterUpdate',
		contextRuns: 'deny',
		description:
			'Rank, enable, disable, or change the note of an app starter on the recommended list. Admin-only.',
		keywords: ['admin', 'app starter', 'starter', 'rank', 'enable', 'disable'],
		inputSchema: z.object({
			package_id: z
				.string()
				.min(1)
				.describe('Starter package id from adminAppStarterList.'),
			rank: appStarterRankSchema,
			enabled: z.boolean().optional(),
			note: appStarterNoteSchema,
		}),
		outputSchema: appStartersOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminAppStarterUpdate',
				() =>
					runAppStarterMutation(async () => ({
						starters: await updateAppStarter({
							env: ctx.env,
							packageId: args.package_id,
							rank: args.rank,
							enabled: args.enabled,
							note: args.note,
						}),
					})),
				{ successReason: () => `package_id=${args.package_id}` },
			)
		},
	},
)
