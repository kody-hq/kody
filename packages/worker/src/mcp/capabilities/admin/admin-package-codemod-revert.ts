import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminPackageCodemodRevertInputSchema,
	packageCodemodHeavyPagingHint,
	packageCodemodStepResultSchema,
	runFleetPackageCodemodStep,
} from '#mcp/capabilities/packages/package-codemod-shared.ts'
import { getPackageCodemodRunById } from '#worker/package-codemods/ledger.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

export const adminPackageCodemodRevertCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		destructive: true,
		name: 'adminPackageCodemodRevert',
		contextRuns: 'deny',
		description: `Fleet-revert a prior adminPackageCodemodApply (or other apply) run by republishing stored pre-codemod snapshots. ${packageCodemodHeavyPagingHint}`,
		keywords: [
			'admin',
			'package',
			'codemod',
			'revert',
			'undo',
			'fleet',
			'migration',
			'package codemod',
		],
		tags: ['codemod'],
		inputSchema: adminPackageCodemodRevertInputSchema,
		outputSchema: packageCodemodStepResultSchema,
		async handler(args, ctx) {
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminPackageCodemodRevert',
				async () => {
					const priorRun = await getPackageCodemodRunById(
						ctx.env.APP_DB,
						args.revertOfRunId,
					)
					if (!priorRun) {
						throw new McpCallerError(
							`Package codemod run "${args.revertOfRunId}" was not found.`,
						)
					}
					return await runFleetPackageCodemodStep(ctx, {
						codemodId: priorRun.codemodId,
						mode: 'revert',
						filters: args.filters,
						runId: args.runId,
						cursor: args.cursor,
						limit: args.limit,
						revertOfRunId: args.revertOfRunId,
					})
				},
				{
					successReason: (result) =>
						`codemod=${result.codemodId};run=${result.runId};revert_of=${args.revertOfRunId}`,
				},
			)
		},
	},
)
