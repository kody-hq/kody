import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	backfillJobCallerContextPackageIds,
	jobCallerContextPackageIdBackfillLimitDefault,
	jobCallerContextPackageIdBackfillLimitMax,
} from '#worker/jobs/job-caller-context-package-id-backfill.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const count = z.number().int().nonnegative()

const inputSchema = z.object({
	dryRun: z
		.boolean()
		.optional()
		.describe(
			'When true (default), count jobs that would get their package storage context restored without writing. Set false to rewrite caller_context_json from the package job id (same blob publish writes).',
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(jobCallerContextPackageIdBackfillLimitMax)
		.optional()
		.describe(
			`Jobs to inspect this page from the jobs store (1-${jobCallerContextPackageIdBackfillLimitMax}, default ${jobCallerContextPackageIdBackfillLimitDefault}). Soft-deleted rows are counted as skippedDeleted.`,
		),
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Resume after this job id. Keep paging until nextCursor is null.',
		),
})

const outcomeSchema = z.object({
	jobId: z.string(),
	orgId: z.string(),
	packageId: z.string().nullable(),
	outcome: z.enum([
		'repaired',
		'already_ok',
		'skipped_bad_job_id',
		'skipped_deleted',
		'failed',
	]),
	error: z.string().optional(),
})

const outputSchema = z.object({
	dryRun: z.boolean(),
	counts: z.object({
		scanned: count,
		repaired: count.describe(
			'Jobs whose stored caller context was missing storageContext.packageId (or mismatched the package job id) and were restored (or would be on dryRun).',
		),
		alreadyOk: count,
		skippedBadJobId: count,
		skippedDeleted: count,
		failed: count,
	}),
	nextCursor: z.string().nullable(),
	outcomes: z.array(outcomeSchema),
})

export const adminJobCallerContextPackageIdBackfillCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminMutationCapabilityAccess,
		idempotent: true,
		name: 'adminJobCallerContextPackageIdBackfill',
		contextRuns: 'deny',
		description:
			'Restore package job caller_context_json rows that lost storageContext.packageId (for example after Run now persisted the clicker context). Rebuilds the blob the same way package publish does. Idempotent: skips rows that already match the package id in the job id. dryRun defaults to true. Page with cursor until nextCursor is null, then set dryRun false and page again.',
		keywords: [
			'admin',
			'job',
			'caller context',
			'packageId',
			'storageContext',
			'backfill',
			'repair',
			'run now',
			'secret',
			'migration',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminJobCallerContextPackageIdBackfill',
				async () =>
					await backfillJobCallerContextPackageIds({
						env: ctx.env,
						dryRun: args.dryRun !== false,
						limit: args.limit,
						cursor: args.cursor ?? null,
						baseUrl: ctx.callerContext.baseUrl,
					}),
				{
					successReason: (result) =>
						`dry_run=${result.dryRun};scanned=${result.counts.scanned};repaired=${result.counts.repaired};already_ok=${result.counts.alreadyOk};skipped_bad_job_id=${result.counts.skippedBadJobId};skipped_deleted=${result.counts.skippedDeleted};failed=${result.counts.failed}`,
				},
			)
		},
	})
