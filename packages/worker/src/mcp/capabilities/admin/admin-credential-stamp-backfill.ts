import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	credentialStampFleetApplyLimitDefault,
	credentialStampFleetApplyLimitMax,
	credentialStampFleetScanLimitDefault,
	credentialStampFleetScanLimitMax,
	runCredentialStampFleet,
} from '#worker/credentials/credential-stamp-fleet.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const pagingHint =
	'One page per execute/sandbox. Resume with the returned nextCursor until null — a filtered scan can return empty outcomes with a non-null nextCursor after exhausting the underlying page budget, so keep paging until nextCursor is null. dryRun default is true (scan only); set dryRun false to restamp seal-ready packages at the current published commit with no content change. Packages that need safe conversion first: run adminCredentialStampMigrate (codemod 0015-convert-credential-stamps) dryRun→apply, then this backfill. Packages that only need descriptions: adminPackageCodemodApply with codemodId 0014-seal-credential-stamps. Packages still reported unconvertible stay on the publish gate (long-term); do not email owners. Packages reported deferred_scan_budget hit the known Durable Object CPU blowup on large prebuilt client assets (e.g. world-builder public/client/main.js) — retry after the publish-seal CPU fix is live; do not treat them as unconvertible.'

const gateFailureCodeSchema = z.enum([
	'non_literal',
	'unstampable_pattern',
	'server_eval',
	'missing_description',
	'invalid_key',
	'credential_named',
])

const outcomeSchema = z.discriminatedUnion('outcome', [
	z.object({
		packageId: z.string(),
		ownerUserId: z.string(),
		packageName: z.string(),
		kodyId: z.string(),
		sourceId: z.string(),
		publishedCommit: z.string(),
		stampKeyCount: z.number().int().nonnegative(),
		outcome: z.enum([
			'stamped',
			'would_restamp',
			'restamped',
			'needs_manifest',
		]),
	}),
	z.object({
		packageId: z.string(),
		ownerUserId: z.string(),
		packageName: z.string(),
		kodyId: z.string(),
		sourceId: z.string(),
		publishedCommit: z.string(),
		stampKeyCount: z.number().int().nonnegative(),
		outcome: z.literal('unconvertible'),
		blockingFailureCodes: z.array(gateFailureCodeSchema),
		blockingFailures: z
			.array(
				z.object({
					code: gateFailureCodeSchema,
					message: z.string(),
					path: z.string().optional(),
				}),
			)
			.describe(
				'Up to 3 sampled blocking stamp-gate failures (one per distinct code first, messages truncated) for false-positive sampling before stop-and-notify. Full codes are in blockingFailureCodes.',
			),
	}),
	z.object({
		packageId: z.string(),
		ownerUserId: z.string(),
		packageName: z.string(),
		kodyId: z.string(),
		sourceId: z.string(),
		publishedCommit: z.null(),
		stampKeyCount: z.number().int().nonnegative(),
		outcome: z.literal('skipped_unpublished'),
	}),
	z.object({
		packageId: z.string(),
		ownerUserId: z.string(),
		packageName: z.string(),
		kodyId: z.string(),
		sourceId: z.string(),
		publishedCommit: z.string().nullable(),
		stampKeyCount: z.number().int().nonnegative(),
		outcome: z.literal('deferred_scan_budget'),
		error: z.string(),
	}),
	z.object({
		packageId: z.string(),
		ownerUserId: z.string(),
		packageName: z.string(),
		kodyId: z.string(),
		sourceId: z.string(),
		publishedCommit: z.string().nullable(),
		stampKeyCount: z.number().int().nonnegative(),
		outcome: z.literal('failed'),
		error: z.string(),
	}),
])

const inputSchema = z.object({
	dryRun: z
		.boolean()
		.optional()
		.describe(
			'When true (default), report stamp presence and seal readiness without writing. Set false to store stamps for seal-ready packages missing a KV stamp at the current published commit.',
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
		.max(credentialStampFleetScanLimitMax)
		.optional()
		.describe(
			`Packages to inspect this step. dryRun default ${credentialStampFleetScanLimitDefault} (max ${credentialStampFleetScanLimitMax}); apply default ${credentialStampFleetApplyLimitDefault} (max ${credentialStampFleetApplyLimitMax}).`,
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
	stampedPackages: z.number().int().nonnegative(),
	missingStampPackages: z.number().int().nonnegative(),
	needsManifestPackages: z.number().int().nonnegative(),
	unconvertiblePackages: z.number().int().nonnegative(),
	deferredScanBudgetPackages: z
		.number()
		.int()
		.nonnegative()
		.describe(
			'Packages that hit Durable Object CPU / isolate-reset while scanning (known large-asset seal bug). Not unconvertible; do not stop-and-notify.',
		),
	restampedPackages: z.number().int().nonnegative(),
	failedPackages: z.number().int().nonnegative(),
	skippedUnpublished: z.number().int().nonnegative(),
	nextCursor: z
		.string()
		.nullable()
		.describe(
			'Resume cursor (saved_packages.id). May be non-null even when outcomes is empty if filters skipped a full underlying scan budget; keep paging until null.',
		),
	outcomes: z.array(outcomeSchema),
	unconvertibleFailureCodes: z
		.array(gateFailureCodeSchema)
		.describe(
			'Distinct blocking stamp-gate failure codes seen on unconvertible packages this page (issue #3836 phase 2 stop-and-notify input).',
		),
})

export const adminCredentialStampBackfillCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		destructive: true,
		name: 'adminCredentialStampBackfill',
		contextRuns: 'deny',
		description: `Fleet scan/apply for published packages missing a complete credential stamp at the current published commit (issue #3836 phase 2). Reports stamped, would_restamp, needs_manifest (run codemod 0014-seal-credential-stamps), and unconvertible (agent convert then notify Kent). Apply restamps seal-ready packages only (no content change). ${pagingHint}`,
		keywords: [
			'admin',
			'credential',
			'stamp',
			'credentials',
			'backfill',
			'fleet',
			'published',
			'3836',
			'rescan',
			'restamp',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const dryRun = args.dryRun !== false
			return auditAdminCapabilityInvocation(
				ctx,
				'adminCredentialStampBackfill',
				async () =>
					await runCredentialStampFleet({
						env: ctx.env,
						baseUrl: ctx.callerContext.baseUrl,
						dryRun,
						afterId: args.cursor ?? null,
						limit: args.limit,
						packageIds: args.packageIds,
						ownerUserIds: args.ownerUserIds,
						sourceIds: args.sourceIds,
					}),
				{
					successReason: (result) =>
						`dry_run=${result.dryRun};scanned=${result.scannedPackages};stamped=${result.stampedPackages};missing=${result.missingStampPackages};needs_manifest=${result.needsManifestPackages};unconvertible=${result.unconvertiblePackages};deferred_scan_budget=${result.deferredScanBudgetPackages};restamped=${result.restampedPackages};failed=${result.failedPackages}`,
				},
			)
		},
	},
)
