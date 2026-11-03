import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	preBindingArtifactRebuildApplyLimitDefault,
	preBindingArtifactRebuildApplyLimitMax,
	preBindingArtifactRebuildScanLimitDefault,
	preBindingArtifactRebuildScanLimitMax,
	runPreBindingArtifactRebuild,
} from '#worker/package-runtime/pre-binding-artifact-rebuild.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z.object({
	dryRun: z
		.boolean()
		.optional()
		.describe(
			'When true (default), report packages with stored pre-binding bundles without rebuilding. Set false to force-rebuild those targets at the published commit.',
		),
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe('Resume after this saved_packages.id from a prior nextCursor.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(preBindingArtifactRebuildScanLimitMax)
		.optional()
		.describe(
			`Packages to inspect this step. dryRun default ${preBindingArtifactRebuildScanLimitDefault} (max ${preBindingArtifactRebuildScanLimitMax}); apply default ${preBindingArtifactRebuildApplyLimitDefault} (max ${preBindingArtifactRebuildApplyLimitMax}).`,
		),
	packageIds: z
		.array(z.string().min(1))
		.min(1)
		.max(90)
		.optional()
		.describe('Optional canary: only these saved package ids.'),
	ownerUserIds: z
		.array(z.string().min(1))
		.min(1)
		.max(90)
		.optional()
		.describe('Optional canary: only these package owner org/user ids.'),
	maxTargets: z
		.number()
		.int()
		.min(1)
		.max(200)
		.optional()
		.describe(
			'Apply only: rebuild at most this many stale targets per package in this call, so a package with many targets fits the execute time limit. Call again with packageIds until its outcome is rebuilt.',
		),
})

const outcomeSchema = z.object({
	packageId: z.string(),
	ownerUserId: z.string(),
	sourceId: z.string(),
	publishedCommit: z.string().nullable(),
	staleTargets: z.number().int().nonnegative(),
	staleMultiPackageTargets: z.number().int().nonnegative(),
	otherCommitTargets: z.number().int().nonnegative().optional(),
	remainingTargets: z.number().int().nonnegative().optional(),
	outcome: z.enum([
		'would_rebuild',
		'rebuilt',
		'partially_rebuilt',
		'rebuilt_unverified',
		'current',
		'other_commit_artifacts',
		'skipped_unpublished',
		'skipped_no_artifacts',
		'failed',
	]),
	error: z.string().optional(),
})

const count = z.number().int().nonnegative()

const outputSchema = z.object({
	dryRun: z.boolean(),
	scannedPackages: count,
	publishedPackages: count,
	packagesNeedingRebuild: count,
	staleTargets: count,
	staleMultiPackageTargets: count.describe(
		'Stale targets whose bundle inlines another saved package (load sites cannot bind these in place).',
	),
	rebuiltPackages: count,
	partiallyRebuiltPackages: count.describe(
		'Packages that still have stale targets because maxTargets capped this call.',
	),
	stillStaleAfterRebuild: count.describe(
		'Rebuilt packages whose targets did not read as current right away (rebuilt_unverified). Stored artifact reads can lag the write; re-check with a dryRun later.',
	),
	failedPackages: count,
	currentPackages: count,
	otherCommitPackages: count.describe(
		'Packages with no pre-binding target but a stored target built from another commit than the published one (not rebuilt here).',
	),
	skippedUnpublished: count,
	skippedNoArtifacts: count,
	nextCursor: z.string().nullable(),
	outcomes: z.array(outcomeSchema),
})

export const adminPreBindingArtifactRebuildCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		destructive: true,
		name: 'adminPreBindingArtifactRebuild',
		contextRuns: 'deny',
		description:
			'Fleet scan/apply for published packages whose stored isolate bundles (module, importable, job, app; not browser app-client) were built before package fetch/kody became lexically bound (GHSA-5fv3), including bundles that inline other packages. In those bundles a wrapper package can be attributed to its caller. Rebuilds artifacts only at the current published commit (no source, version, visibility, enablement, job, or hostname change) and rechecks each target afterwards (a target that does not read as current yet is reported rebuilt_unverified, not failed). One page per execute; resume with nextCursor until null. Pass maxTargets to split a package with many targets across calls. dryRun default is true.',
		keywords: [
			'admin',
			'package',
			'artifact',
			'rebuild',
			'pre-binding',
			'fetch binding',
			'GHSA-5fv3',
			'fleet',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const dryRun = args.dryRun !== false
			return auditAdminCapabilityInvocation(
				ctx,
				'adminPreBindingArtifactRebuild',
				async () =>
					await runPreBindingArtifactRebuild({
						env: ctx.env,
						baseUrl: ctx.callerContext.baseUrl,
						dryRun,
						afterId: args.cursor ?? null,
						limit: args.limit,
						packageIds: args.packageIds,
						ownerUserIds: args.ownerUserIds,
						maxTargets: args.maxTargets,
					}),
				{
					successReason: (result) =>
						`dry_run=${result.dryRun};scanned=${result.scannedPackages};need=${result.packagesNeedingRebuild};stale=${result.staleTargets};multi=${result.staleMultiPackageTargets};rebuilt=${result.rebuiltPackages};failed=${result.failedPackages}`,
				},
			)
		},
	},
)
