import { z } from 'zod'
import {
	listSoftDeletePurgeCandidates,
	pruneSoftDeleted,
	softDeletePurgeBatchSize,
} from '#worker/orgs/purge.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

export const adminSoftDeletePurgeRunTimeBudgetMs = 10_000

const inputSchema = z.object({
	dryRun: z
		.boolean()
		.optional()
		.describe(
			'When true (default), list entities the next purge pass would hard-delete without claiming or deleting.',
		),
	batchSize: z
		.number()
		.int()
		.min(1)
		.max(20)
		.optional()
		.describe(
			`Rows to inspect in this pass (1-20, default ${softDeletePurgeBatchSize}).`,
		),
})

const outcomeSchema = z.object({
	kind: z.enum(['org', 'user']),
	id: z.string(),
	outcome: z.enum(['purged', 'failed', 'skipped_claim', 'would_purge']),
	legacy: z
		.literal(true)
		.optional()
		.describe(
			'Legacy account deletion (deleting_at set, deleted_at null) finished without the restore window.',
		),
	error: z.string().optional(),
})

const outputSchema = z.object({
	dryRun: z.boolean(),
	legacyDryRun: z.boolean(),
	scanned: z.number().int(),
	purged: z.number().int(),
	failed: z.number().int(),
	timeBudgetExhausted: z.boolean(),
	outcomes: z.array(outcomeSchema),
})

export const adminSoftDeletePurgeRunCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminSoftDeletePurgeRun',
		contextRuns: 'deny',
		description:
			'Run one bounded pass of the soft-delete purge lane (orgs and person accounts past the 30-day restore window, plus legacy account deletions left with deleting_at set and deleted_at null, which have no restore window). dryRun defaults to true and lists candidates without hard deletes. Set dryRun false to execute writes (respects SOFT_DELETE_PURGE_ENABLED on the worker unless dryRun is explicitly false). Admin-only and destructive.',
		keywords: [
			'admin',
			'soft delete',
			'purge',
			'retention',
			'org',
			'account',
			'dry run',
			'scheduled lane',
		],
		destructive: true,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const dryRun = args.dryRun ?? true
			return auditAdminCapabilityInvocation(
				ctx,
				'adminSoftDeletePurgeRun',
				async () => {
					if (dryRun) {
						const preview = await listSoftDeletePurgeCandidates({
							env: ctx.env,
							batchSize: args.batchSize,
						})
						return {
							dryRun: true,
							legacyDryRun: true,
							scanned: preview.scanned,
							purged: 0,
							failed: 0,
							timeBudgetExhausted: false,
							outcomes: preview.candidates.map((candidate) => ({
								kind: candidate.kind,
								id: candidate.id,
								outcome: 'would_purge' as const,
								...(candidate.legacy ? { legacy: true as const } : {}),
							})),
						}
					}
					const result = await pruneSoftDeleted({
						env: ctx.env,
						enableWrites: true,
						batchSize: args.batchSize,
						timeBudgetMs: adminSoftDeletePurgeRunTimeBudgetMs,
					})
					return result
				},
				{
					successReason: (result) =>
						`dry_run=${result.dryRun};scanned=${result.scanned};purged=${result.purged};failed=${result.failed}`,
				},
			)
		},
	},
)
