import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminPackageCodemodStepInputSchema,
	packageCodemodHeavyPagingHint,
	packageCodemodStepResultSchema,
	runFleetPackageCodemodStep,
} from '#mcp/capabilities/packages/package-codemod-shared.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

export const adminPackageCodemodDryRunCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminPackageCodemodDryRun',
		contextRuns: 'deny',
		description: `Fleet dry-run a registered package codemod: transform in memory and run publish checks without writing. Optional filters canary by userIds or packageIds. ${packageCodemodHeavyPagingHint}`,
		keywords: [
			'admin',
			'package',
			'codemod',
			'dry-run',
			'preview',
			'fleet',
			'migration',
			'package codemod',
		],
		tags: ['codemod'],
		inputSchema: adminPackageCodemodStepInputSchema,
		outputSchema: packageCodemodStepResultSchema,
		async handler(args, ctx) {
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminPackageCodemodDryRun',
				async () =>
					await runFleetPackageCodemodStep(ctx, {
						codemodId: args.codemodId,
						mode: 'dry-run',
						packageIds: args.packageIds,
						filters: args.filters,
						runId: args.runId,
						cursor: args.cursor,
						limit: args.limit,
					}),
				{
					successReason: (result) =>
						`codemod=${result.codemodId};run=${result.runId}`,
				},
			)
		},
	},
)
