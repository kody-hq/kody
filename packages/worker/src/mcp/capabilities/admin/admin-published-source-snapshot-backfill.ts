import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	publishedSourceSnapshotBackfillApplyLimitDefault,
	publishedSourceSnapshotBackfillApplyLimitMax,
	publishedSourceSnapshotBackfillScanLimitDefault,
	publishedSourceSnapshotBackfillScanLimitMax,
	runPublishedSourceSnapshotBackfill,
} from '#worker/package-runtime/published-source-snapshot-backfill.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const pagingHint =
	'One page per execute/sandbox. Resume with the returned nextCursor until null — a filtered scan can return empty outcomes with a non-null nextCursor after exhausting the underlying page budget, so keep paging until nextCursor is null. dryRun default is true (scan only); set dryRun false to rebuild missing source-snapshot KV keys from the Artifacts git tip at the current published commit with no content change.'

const outcomeSchema = z.discriminatedUnion('outcome', [
	z.object({
		packageId: z.string(),
		ownerUserId: z.string(),
		packageName: z.string(),
		kodyId: z.string(),
		sourceId: z.string(),
		publishedCommit: z.string(),
		outcome: z.enum(['would_rebuild', 'rebuilt', 'already_present']),
	}),
	z.object({
		packageId: z.string(),
		ownerUserId: z.string(),
		packageName: z.string(),
		kodyId: z.string(),
		sourceId: z.string(),
		publishedCommit: z.null(),
		outcome: z.literal('skipped_unpublished'),
	}),
	z.object({
		packageId: z.string(),
		ownerUserId: z.string(),
		packageName: z.string(),
		kodyId: z.string(),
		sourceId: z.string(),
		publishedCommit: z.string().nullable(),
		outcome: z.literal('failed'),
		error: z.string(),
	}),
])

const inputSchema = z.object({
	dryRun: z
		.boolean()
		.optional()
		.describe(
			'When true (default), report packages with missing published source snapshots without rebuilding. Set false to rebuild from the Artifacts git tip at the published commit.',
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
		.max(publishedSourceSnapshotBackfillScanLimitMax)
		.optional()
		.describe(
			`Packages to inspect this step. dryRun default ${publishedSourceSnapshotBackfillScanLimitDefault} (max ${publishedSourceSnapshotBackfillScanLimitMax}); apply default ${publishedSourceSnapshotBackfillApplyLimitDefault} (max ${publishedSourceSnapshotBackfillApplyLimitMax}).`,
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
	sourceIds: z
		.array(z.string().min(1))
		.min(1)
		.max(90)
		.optional()
		.describe('Optional canary: only these entity_sources ids.'),
})

const outputSchema = z.object({
	dryRun: z.boolean(),
	scannedPackages: z.number().int().nonnegative(),
	publishedPackages: z.number().int().nonnegative(),
	packagesNeedingRebuild: z.number().int().nonnegative(),
	rebuiltPackages: z.number().int().nonnegative(),
	failedPackages: z.number().int().nonnegative(),
	alreadyPresentPackages: z.number().int().nonnegative(),
	skippedUnpublished: z.number().int().nonnegative(),
	nextCursor: z
		.string()
		.nullable()
		.describe(
			'Resume cursor (saved_packages.id). May be non-null even when outcomes is empty if filters skipped a full underlying scan budget; keep paging until null.',
		),
	outcomes: z.array(outcomeSchema),
})

export const adminPublishedSourceSnapshotBackfillCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminMutationCapabilityAccess,
		destructive: true,
		name: 'adminPublishedSourceSnapshotBackfill',
		contextRuns: 'deny',
		description: `Fleet scan/apply for published packages whose source-snapshot KV key is missing at the current published commit (entity_sources.published_commit with no BUNDLE_ARTIFACTS_KV snapshot). Rebuilds the snapshot from the Artifacts git tip only (no source/content change). Safe and idempotent. ${pagingHint}`,
		keywords: [
			'admin',
			'package',
			'source snapshot',
			'published snapshot',
			'backfill',
			'rebuild',
			'fleet',
			'published',
			'missing snapshot',
			'KV',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const dryRun = args.dryRun !== false
			return auditAdminCapabilityInvocation(
				ctx,
				'adminPublishedSourceSnapshotBackfill',
				async () =>
					await runPublishedSourceSnapshotBackfill({
						env: ctx.env,
						dryRun,
						afterId: args.cursor ?? null,
						limit: args.limit,
						packageIds: args.packageIds,
						ownerUserIds: args.ownerUserIds,
						sourceIds: args.sourceIds,
					}),
				{
					successReason: (result) =>
						`dry_run=${result.dryRun};scanned=${result.scannedPackages};need=${result.packagesNeedingRebuild};rebuilt=${result.rebuiltPackages};failed=${result.failedPackages}`,
				},
			)
		},
	})
