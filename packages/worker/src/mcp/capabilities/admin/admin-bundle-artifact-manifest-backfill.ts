import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	bundleArtifactManifestBackfillLimitDefault,
	bundleArtifactManifestBackfillLimitMax,
	runBundleArtifactManifestBackfill,
} from '#worker/package-runtime/bundle-artifact-manifest-backfill.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z.object({
	dryRun: z
		.boolean()
		.optional()
		.describe(
			'When true (default), report what would be written without writing. Set false to write.',
		),
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Resume after this published_bundle_artifacts.id from a prior nextCursor. Omit to start from the beginning.',
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(bundleArtifactManifestBackfillLimitMax)
		.optional()
		.describe(
			`Rows to inspect this step (default ${bundleArtifactManifestBackfillLimitDefault}, max ${bundleArtifactManifestBackfillLimitMax}).`,
		),
	userIds: z
		.array(z.string().min(1))
		.min(1)
		.max(40)
		.optional()
		.describe('Optional canary: only rows owned by these user or org ids.'),
	sourceIds: z
		.array(z.string().min(1))
		.min(1)
		.max(40)
		.optional()
		.describe('Optional canary: only rows of these package source ids.'),
})

const outputSchema = z.object({
	dryRun: z.boolean(),
	scannedRows: z.number().int().nonnegative(),
	filledRows: z
		.number()
		.int()
		.nonnegative()
		.describe('Rows whose total_bytes was set, or would be in a dry run.'),
	manifestsWritten: z
		.number()
		.int()
		.nonnegative()
		.describe(
			'Stored artifacts that gained a manifest, or would in a dry run.',
		),
	unbackfillableRows: z
		.number()
		.int()
		.nonnegative()
		.describe(
			'Rows whose stored artifact is missing or unusable. Left untouched.',
		),
	readFailedRows: z
		.number()
		.int()
		.nonnegative()
		.describe(
			'Rows whose stored artifact could not be read this time. They keep no total, so a later run from the start retries them.',
		),
	nextCursor: z.string().nullable(),
	problems: z
		.array(
			z.object({
				rowId: z.string(),
				userId: z.string(),
				sourceId: z.string(),
				publishedCommit: z.string(),
				kvKey: z.string(),
				status: z.enum([
					'written',
					'would_write',
					'already',
					'missing',
					'unusable',
					'read_failed',
					'row_changed',
				]),
				totalBytes: z.number().nullable(),
			}),
		)
		.describe('Only the rows that could not be filled.'),
})

export const adminBundleArtifactManifestBackfillCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminMutationCapabilityAccess,
		idempotent: true,
		name: 'adminBundleArtifactManifestBackfill',
		contextRuns: 'deny',
		description:
			'Manifest backfill for stored published bundle artifacts written before manifests existed (issue 5178). For each published_bundle_artifacts row without total_bytes: adds a manifest (module roles, sizes, owners) to the stored artifact when it has none, then records total_bytes on the row. Changes no module bytes, rebuilds nothing, and leaves rows whose stored artifact is missing or unusable untouched (listed in problems). A row whose stored artifact could not be read is listed as read_failed, never as unusable; run again from the start to retry those. One page per call; resume with nextCursor until null. dryRun default is true. Safe to repeat.',
		keywords: [
			'admin',
			'package',
			'artifact',
			'manifest',
			'backfill',
			'total_bytes',
			'fleet',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminBundleArtifactManifestBackfill',
				async () =>
					await runBundleArtifactManifestBackfill({
						env: ctx.env,
						dryRun: args.dryRun !== false,
						afterId: args.cursor ?? null,
						limit: args.limit,
						userIds: args.userIds,
						sourceIds: args.sourceIds,
					}),
				{
					successReason: (result) =>
						`dry_run=${result.dryRun};scanned=${result.scannedRows};filled=${result.filledRows};manifests=${result.manifestsWritten};unbackfillable=${result.unbackfillableRows};read_failed=${result.readFailedRows}`,
				},
			)
		},
	})
