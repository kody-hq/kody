import { z } from 'zod'
import { cleanupOrphanedCommunityForks } from '#worker/community/service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const orphanedForkSchema = z.object({
	fork_id: z.string(),
	listing_id: z.string().nullable(),
	listing_name: z.string().nullable(),
	listing_kody_id: z.string().nullable(),
	forker_user_id: z.string(),
	forked_package_id: z.string(),
	forked_source_id: z.string(),
	target_kody_id: z.string(),
	created_at: z.string(),
})

export const adminCommunityOrphanForksCleanupCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminMutationCapabilityAccess,
		name: 'adminCommunityOrphanForksCleanup',
		contextRuns: 'deny',
		description:
			'Admin-only maintenance for leftover community_forks rows whose inert entity source and saved package are both gone. Healthy community forks stay inert (no saved_packages row) and keep an entity_sources row, so a missing package alone is not an orphan and is never deleted. apply defaults to false (preview). Optional fork_ids limits the scan to those ids and still skips any that still have a source or package. Audited.',
		keywords: [
			'admin',
			'community',
			'forks',
			'orphan',
			'cleanup',
			'maintenance',
		],
		destructive: true,
		inputSchema: z.object({
			apply: z
				.boolean()
				.optional()
				.describe(
					'When true, delete matching orphan rows. Defaults to false (preview only).',
				),
			fork_ids: z
				.array(z.string().min(1))
				.min(1)
				.max(90)
				.optional()
				.describe(
					'Optional fork row ids to inspect. When set, only those ids that are true orphans are previewed or deleted.',
				),
		}),
		outputSchema: z.object({
			applied: z.boolean(),
			deleted_count: z.number().int().nonnegative(),
			orphans: z.array(orphanedForkSchema),
		}),
		async handler(args, ctx) {
			const apply = args.apply === true
			return auditAdminCapabilityInvocation(
				ctx,
				'adminCommunityOrphanForksCleanup',
				async () => {
					const result = await cleanupOrphanedCommunityForks({
						env: ctx.env,
						apply,
						forkIds: args.fork_ids,
					})
					return {
						applied: result.applied,
						deleted_count: result.deletedCount,
						orphans: result.orphans.map((orphan) => ({
							fork_id: orphan.forkId,
							listing_id: orphan.listingId,
							listing_name: orphan.listingName,
							listing_kody_id: orphan.listingKodyId,
							forker_user_id: orphan.forkerUserId,
							forked_package_id: orphan.forkedPackageId,
							forked_source_id: orphan.forkedSourceId,
							target_kody_id: orphan.targetKodyId,
							created_at: orphan.createdAt,
						})),
					}
				},
				{
					successReason: (result) =>
						`applied=${result.applied ? 1 : 0};deleted=${result.deleted_count};orphans=${result.orphans.length}`,
				},
			)
		},
	})
