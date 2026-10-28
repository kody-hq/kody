import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { rebuildPublishedPackageArtifactsViaRepoSession } from '#mcp/capabilities/repo/package-artifact-rebuild.ts'
import {
	publishedCommitRefRepairApplyLimitMax,
	publishedCommitRefRepairScanLimitDefault,
	publishedCommitRefRepairScanLimitMax,
	runPublishedCommitRefRepair,
} from '#worker/repo/published-commit-ref-repair.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const outcomeSchema = z.object({
	packageId: z.string(),
	ownerUserId: z.string(),
	sourceId: z.string(),
	publishedCommit: z.string().nullable(),
	outcome: z.enum([
		'consistent',
		'repairable',
		'unrecoverable',
		'repaired',
		'skipped_unpublished',
		'skipped_owner_deleting',
		'failed',
	]),
	defaultBranch: z.string().optional(),
	defaultBranchHead: z.string().nullable().optional(),
	repairedCommit: z.string().optional(),
	movedSessionIds: z.array(z.string()).optional(),
	backupKey: z.string().optional(),
	error: z.string().optional(),
})

const inputSchema = z.object({
	dryRun: z
		.boolean()
		.optional()
		.describe(
			'When true (default), classify packages without writing. Set false (with packageIds) to repair repairable packages.',
		),
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Resume after this saved_packages.id from a prior nextCursor. Omit to start from the beginning.',
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(publishedCommitRefRepairScanLimitMax)
		.optional()
		.describe(
			`Packages to inspect this step. Scan default ${publishedCommitRefRepairScanLimitDefault} (max ${publishedCommitRefRepairScanLimitMax}); apply max ${publishedCommitRefRepairApplyLimitMax}.`,
		),
	packageIds: z
		.array(z.string().min(1))
		.min(1)
		.max(90)
		.optional()
		.describe('Only these saved package ids. Required when dryRun is false.'),
})

const outputSchema = z.object({
	dryRun: z.boolean(),
	scannedPackages: z.number().int().nonnegative(),
	consistent: z.number().int().nonnegative(),
	repairable: z.number().int().nonnegative(),
	unrecoverable: z.number().int().nonnegative(),
	repaired: z.number().int().nonnegative(),
	failed: z.number().int().nonnegative(),
	skippedUnpublished: z.number().int().nonnegative(),
	skippedOwnerDeleting: z
		.number()
		.int()
		.nonnegative()
		.describe(
			'Packages skipped because their owner is mid-deletion or deleted.',
		),
	nextCursor: z
		.string()
		.nullable()
		.describe('Resume cursor (saved_packages.id). Keep paging until null.'),
	outcomes: z
		.array(outcomeSchema)
		.describe(
			'Non-consistent packages, plus every requested package when packageIds is set.',
		),
})

export const adminPublishedCommitRefRepairCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		destructive: true,
		name: 'adminPublishedCommitRefRepair',
		contextRuns: 'deny',
		description:
			'Find published packages whose published_commit is not reachable from any Artifacts ref (a publish advanced the pointer but the git ref never moved), and repair them from the published source snapshot. Repair backs up the source row, refs, and affected sessions to KV, commits the snapshot tree as a fast-forward child of the default-branch tip, confirms the ref, moves session branches and records that pointed at the lost commit, then advances published_commit and rebuilds artifacts. Never force-pushes the default branch and never deletes. Packages with no snapshot are reported as unrecoverable. dryRun defaults to true; apply requires packageIds. One page per execute; resume with nextCursor until null.',
		keywords: [
			'admin',
			'package',
			'published commit',
			'artifacts',
			'git ref',
			'unreachable',
			'repair',
			'repo session',
			'snapshot',
			'fleet',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const dryRun = args.dryRun !== false
			const baseUrl = ctx.callerContext.baseUrl
			return auditAdminCapabilityInvocation(
				ctx,
				'adminPublishedCommitRefRepair',
				async () =>
					await runPublishedCommitRefRepair({
						env: ctx.env,
						baseUrl,
						dryRun,
						afterId: args.cursor ?? null,
						limit: args.limit,
						packageIds: args.packageIds,
						rebuildArtifacts: async ({ sourceId, userId, publishedCommit }) => {
							await rebuildPublishedPackageArtifactsViaRepoSession({
								env: ctx.env,
								rpcSessionId: `source-ref-repair-${sourceId}`,
								sourceId,
								userId,
								publishedCommit,
								baseUrl,
							})
						},
					}),
				{
					successReason: (result) =>
						`dry_run=${result.dryRun};scanned=${result.scannedPackages};repairable=${result.repairable};unrecoverable=${result.unrecoverable};repaired=${result.repaired};failed=${result.failed}`,
				},
			)
		},
	},
)
