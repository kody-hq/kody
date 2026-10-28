import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	backfillOwnerCronEnablements,
	ownerCronEnablementBackfillLimitDefault,
	ownerCronEnablementBackfillLimitMax,
} from '#worker/enablements/owner-cron-enablement.ts'
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
			'When true (default), count jobs that would get an owner cron enablement without writing. Set false to insert.',
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(ownerCronEnablementBackfillLimitMax)
		.optional()
		.describe(
			`Jobs to inspect this page from the jobs store (1-${ownerCronEnablementBackfillLimitMax}, default ${ownerCronEnablementBackfillLimitDefault}). Includes disabled/deleted rows that are counted as skippedNotEnabled.`,
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
	jobName: z.string(),
	outcome: z.enum([
		'inserted',
		'already_present',
		'skipped_no_owner',
		'skipped_bad_job_id',
		'skipped_not_enabled',
		'failed',
	]),
	error: z.string().optional(),
})

const outputSchema = z.object({
	dryRun: z.boolean(),
	counts: z.object({
		scanned: count,
		inserted: count.describe(
			'Owner cron enablements inserted (or that would be inserted on dryRun).',
		),
		alreadyPresent: count,
		skippedNoOwner: count,
		skippedBadJobId: count,
		skippedNotEnabled: count,
		failed: count,
	}),
	nextCursor: z.string().nullable(),
	outcomes: z.array(outcomeSchema),
})

export const adminJobOwnerEnablementBackfillCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		idempotent: true,
		name: 'adminJobOwnerEnablementBackfill',
		contextRuns: 'deny',
		description:
			'Backfill an on cron enablement for the owner of each enabled package job that is missing one (so scheduled ticks run). Idempotent: skips jobs that already have a non-off owner enablement. dryRun defaults to true. Page with cursor until nextCursor is null, then set dryRun false and page again. Creating a job now auto-enables the owner; this repairs jobs that predate that rule.',
		keywords: [
			'admin',
			'job',
			'cron',
			'enablement',
			'backfill',
			'owner',
			'schedule',
			'migration',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminJobOwnerEnablementBackfill',
				async () =>
					await backfillOwnerCronEnablements({
						env: ctx.env,
						dryRun: args.dryRun !== false,
						limit: args.limit,
						cursor: args.cursor ?? null,
					}),
				{
					successReason: (result) =>
						`dry_run=${result.dryRun};scanned=${result.counts.scanned};inserted=${result.counts.inserted};already_present=${result.counts.alreadyPresent};skipped_no_owner=${result.counts.skippedNoOwner};skipped_bad_job_id=${result.counts.skippedBadJobId};skipped_not_enabled=${result.counts.skippedNotEnabled};failed=${result.counts.failed}`,
				},
			)
		},
	},
)
