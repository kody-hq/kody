import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminPackageCodemodStepInputSchema,
	packageCodemodHeavyPagingHint,
	packageCodemodStepResultSchema,
	runFleetPackageCodemodStep,
} from '#mcp/capabilities/packages/package-codemod-shared.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

export const adminPackageCodemodApplyCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		destructive: true,
		name: 'adminPackageCodemodApply',
		contextRuns: 'deny',
		description: `Fleet-apply a registered package codemod: republishes transformed published trees after the same gates as dry-run. Prefer adminPackageCodemodDryRun first; canary with filters. Keep the returned runId to revert with adminPackageCodemodRevert. ${packageCodemodHeavyPagingHint}`,
		keywords: [
			'admin',
			'package',
			'codemod',
			'apply',
			'fleet',
			'migrate',
			'republish',
			'package codemod',
		],
		tags: ['codemod'],
		inputSchema: adminPackageCodemodStepInputSchema,
		outputSchema: packageCodemodStepResultSchema,
		async handler(args, ctx) {
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminPackageCodemodApply',
				async () =>
					await runFleetPackageCodemodStep(ctx, {
						codemodId: args.codemodId,
						mode: 'apply',
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
