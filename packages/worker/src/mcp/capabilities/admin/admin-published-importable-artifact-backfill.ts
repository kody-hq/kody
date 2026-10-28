import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	publishedImportableArtifactBackfillApplyLimitDefault,
	publishedImportableArtifactBackfillApplyLimitMax,
	publishedImportableArtifactBackfillScanLimitDefault,
	publishedImportableArtifactBackfillScanLimitMax,
	runPublishedImportableArtifactBackfill,
} from '#worker/package-runtime/published-importable-artifact-backfill.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const pagingHint =
	'One page per execute/sandbox. Resume with the returned nextCursor until null — a filtered scan can return empty outcomes with a non-null nextCursor after exhausting the underlying page budget, so keep paging until nextCursor is null. dryRun default is true (scan only); set dryRun false to rebuild only missing importable-module artifacts at the current published commit with no content change.'

const outcomeSchema = z.discriminatedUnion('outcome', [
	z.object({
		packageId: z.string(),
		ownerUserId: z.string(),
		packageName: z.string(),
		kodyId: z.string(),
		sourceId: z.string(),
		publishedCommit: z.string(),
		missingImportableCount: z.number().int().nonnegative(),
		outcome: z.enum(['would_rebuild', 'rebuilt', 'already_built']),
	}),
	z.object({
		packageId: z.string(),
		ownerUserId: z.string(),
		packageName: z.string(),
		kodyId: z.string(),
		sourceId: z.string(),
		publishedCommit: z.null(),
		missingImportableCount: z.number().int().nonnegative(),
		outcome: z.literal('skipped_unpublished'),
	}),
	z.object({
		packageId: z.string(),
		ownerUserId: z.string(),
		packageName: z.string(),
		kodyId: z.string(),
		sourceId: z.string(),
		publishedCommit: z.string().nullable(),
		missingImportableCount: z.number().int().nonnegative(),
		outcome: z.literal('failed'),
		error: z.string(),
	}),
])

const inputSchema = z.object({
	dryRun: z
		.boolean()
		.optional()
		.describe(
			'When true (default), report packages with missing importable-module artifacts without rebuilding. Set false to rebuild at the published commit.',
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
		.max(publishedImportableArtifactBackfillScanLimitMax)
		.optional()
		.describe(
			`Packages to inspect this step. dryRun default ${publishedImportableArtifactBackfillScanLimitDefault} (max ${publishedImportableArtifactBackfillScanLimitMax}); apply default ${publishedImportableArtifactBackfillApplyLimitDefault} (max ${publishedImportableArtifactBackfillApplyLimitMax}).`,
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
})

const outputSchema = z.object({
	dryRun: z.boolean(),
	scannedPackages: z.number().int().nonnegative(),
	publishedPackages: z.number().int().nonnegative(),
	packagesNeedingRebuild: z.number().int().nonnegative(),
	missingImportableArtifacts: z.number().int().nonnegative(),
	packagesMissingSubpathImportable: z
		.number()
		.int()
		.nonnegative()
		.describe(
			'Packages in this page with at least one missing subpath (non-root) importable-module artifact.',
		),
	rebuiltPackages: z.number().int().nonnegative(),
	failedPackages: z.number().int().nonnegative(),
	alreadyBuiltPackages: z.number().int().nonnegative(),
	skippedUnpublished: z.number().int().nonnegative(),
	nextCursor: z
		.string()
		.nullable()
		.describe(
			'Resume cursor (saved_packages.id). May be non-null even when outcomes is empty if packageId/ownerUserId filters skipped a full underlying scan budget; keep paging until null.',
		),
	outcomes: z.array(outcomeSchema),
})

export const adminPublishedImportableArtifactBackfillCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminMutationCapabilityAccess,
		destructive: true,
		name: 'adminPublishedImportableArtifactBackfill',
		contextRuns: 'deny',
		description: `Fleet scan/apply for published packages whose importable-module artifacts are missing, stale, or unusable at the current published commit (a stored bundle the load sites refuse, such as a pre-binding bundle that inlines other packages, counts as missing). Rebuilds artifacts only (no source/content change). Safe and idempotent. ${pagingHint}`,
		keywords: [
			'admin',
			'package',
			'artifact',
			'importable',
			'backfill',
			'rebuild',
			'fleet',
			'published',
			'missing artifacts',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const dryRun = args.dryRun !== false
			return auditAdminCapabilityInvocation(
				ctx,
				'adminPublishedImportableArtifactBackfill',
				async () =>
					await runPublishedImportableArtifactBackfill({
						env: ctx.env,
						baseUrl: ctx.callerContext.baseUrl,
						dryRun,
						afterId: args.cursor ?? null,
						limit: args.limit,
						packageIds: args.packageIds,
						ownerUserIds: args.ownerUserIds,
					}),
				{
					successReason: (result) =>
						`dry_run=${result.dryRun};scanned=${result.scannedPackages};need=${result.packagesNeedingRebuild};missing=${result.missingImportableArtifacts};rebuilt=${result.rebuiltPackages};failed=${result.failedPackages}`,
				},
			)
		},
	})
