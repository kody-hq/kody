import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { repairPackageJobAttribution } from '#worker/admin/package-job-attribution-repair.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const commitShaSchema = z
	.string()
	.trim()
	.regex(
		/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/,
		'Expected a full lowercase commit SHA.',
	)

const nullableString = z.string().nullable()

const refusalSchema = z.enum([
	'source_not_found',
	'job_not_found',
	'job_not_in_package',
	'serving_commit_unavailable',
	'serving_commit_mismatch',
	'publish_in_progress',
	'recorded_commit_mismatch',
	'write_conflict',
	'source_changed_during_apply',
])

export const adminPackageJobAttributionRepairCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminMutationCapabilityAccess,
		idempotent: true,
		name: 'adminPackageJobAttributionRepair',
		contextRuns: 'deny',
		description:
			"Repair one package job's recorded commit (jobs.published_commit) to the package's current serving commit. Dry-run by default: returns the exact metadata diff or refusal reasons. apply:true writes only that column, guarded by expectedRecordedCommit and expectedServingCommit, and refuses when a publish is in progress or the pointer moves during the write. Never rebuilds, republishes, runs the job, changes enabled state, schedule, params, or source pointers. Admin-only and audit-logged.",
		keywords: [
			'admin',
			'job attribution',
			'job pinned commit',
			'job recorded commit',
			'repair job commit',
			'stale job pin',
			'failed publish job pin',
		],
		inputSchema: z
			.object({
				packageId: z.string().trim().min(1).optional(),
				packageName: z
					.string()
					.trim()
					.regex(/^@[^/\s]+\/[^/\s]+$/, 'Expected @owner/name.')
					.optional(),
				jobId: z.string().trim().min(1).describe('Package job id.'),
				expectedRecordedCommit: commitShaSchema.describe(
					"The job's current jobs.published_commit, as read from adminPackageProvenance.",
				),
				expectedServingCommit: commitShaSchema.describe(
					"The package's current serving commit; the value the job will record.",
				),
				apply: z
					.boolean()
					.optional()
					.describe('Write the change. Omit or false for a dry run.'),
			})
			.refine(
				(value) =>
					[value.packageId, value.packageName].filter(Boolean).length === 1,
				{ message: 'Provide exactly one of packageId or packageName.' },
			),
		outputSchema: z.object({
			mode: z.enum(['dry_run', 'apply']),
			outcome: z.enum([
				'would_update',
				'updated',
				'already_current',
				'refused',
			]),
			refusalReasons: z.array(refusalSchema),
			package: z.object({
				packageId: z.string(),
				ownerId: z.string(),
				sourceId: z.string(),
			}),
			source: z
				.object({
					publishedCommit: nullableString,
					servingCommit: nullableString,
					servingArtifactCommit: nullableString,
				})
				.nullable(),
			job: z
				.object({
					jobId: z.string(),
					name: z.string(),
					enabled: z.boolean(),
					recordedCommit: nullableString,
				})
				.nullable(),
			diff: z
				.object({
					field: z.literal('jobs.published_commit'),
					from: nullableString,
					to: z.string(),
				})
				.nullable(),
			compensated: z.boolean(),
		}),
		async handler(args, ctx) {
			const target = args.packageId
				? { packageId: args.packageId }
				: { packageName: args.packageName ?? '' }
			const targetReason = target.packageId
				? `package_id=${target.packageId}`
				: `package_name=${target.packageName}`
			return auditAdminCapabilityInvocation(
				ctx,
				'adminPackageJobAttributionRepair',
				async () => {
					const result = await repairPackageJobAttribution({
						env: ctx.env,
						target,
						jobId: args.jobId,
						expectedRecordedCommit: args.expectedRecordedCommit,
						expectedServingCommit: args.expectedServingCommit,
						apply: args.apply === true,
					}).catch((error: unknown) => {
						throw new Error(`${targetReason} job_attribution_repair_failed`, {
							cause: error,
						})
					})
					if (!result) {
						throw new McpCallerError(`Package not found (${targetReason}).`)
					}
					return result
				},
				{
					successReason: (result) =>
						[
							`package_id=${result.package.packageId}`,
							`owner_id=${result.package.ownerId}`,
							`job_id=${args.jobId}`,
							`mode=${result.mode}`,
							`outcome=${result.outcome}`,
							`from=${args.expectedRecordedCommit}`,
							`to=${args.expectedServingCommit}`,
							`refusals=${result.refusalReasons.join(',') || 'none'}`,
							`compensated=${result.compensated}`,
						].join(' '),
				},
			)
		},
	})
