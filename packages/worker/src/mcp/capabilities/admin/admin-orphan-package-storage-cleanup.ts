import { z } from 'zod'
import {
	cleanupOrphanedPackageStorageBuckets,
	orphanedPackageStorageMaxLimit,
} from '#worker/package-registry/orphan-package-storage.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const orphanedBucketSchema = z.object({
	user_id: z.string(),
	storage_id: z.string(),
	package_id: z.string(),
	estimated_bytes: z.number().nullable(),
})

export const adminOrphanPackageStorageCleanupCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminMutationCapabilityAccess,
		name: 'adminOrphanPackageStorageCleanup',
		contextRuns: 'deny',
		description:
			'Admin-only maintenance for leftover package storage buckets: live `package:<uuid>` user_storage_buckets rows whose package has no saved_packages row (soft-deleted packages count as present) and no community fork reserving the id. apply defaults to false (preview). When true, clears each bucket and removes its inventory row, the same cleanup packageDelete runs. Audited.',
		keywords: [
			'admin',
			'package',
			'storage',
			'bucket',
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
					'When true, clear the listed orphan buckets. Defaults to false (preview only).',
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(orphanedPackageStorageMaxLimit)
				.optional()
				.describe(
					`Max buckets to preview or clear in one call (default ${orphanedPackageStorageMaxLimit}).`,
				),
		}),
		outputSchema: z.object({
			applied: z.boolean(),
			cleared_count: z.number().int().nonnegative(),
			failed_count: z.number().int().nonnegative(),
			orphans: z.array(orphanedBucketSchema),
		}),
		async handler(args, ctx) {
			const apply = args.apply === true
			return auditAdminCapabilityInvocation(
				ctx,
				'adminOrphanPackageStorageCleanup',
				async () => {
					const result = await cleanupOrphanedPackageStorageBuckets({
						env: ctx.env,
						apply,
						limit: args.limit,
					})
					return {
						applied: result.applied,
						cleared_count: result.clearedCount,
						failed_count: result.failedCount,
						orphans: result.orphans.map((orphan) => ({
							user_id: orphan.userId,
							storage_id: orphan.storageId,
							package_id: orphan.packageId,
							estimated_bytes: orphan.estimatedBytes,
						})),
					}
				},
				{
					resultOf: (result) =>
						result.failed_count > 0 ? 'failure' : 'success',
					successReason: (result) =>
						`applied=${result.applied ? 1 : 0};cleared=${result.cleared_count};failed=${result.failed_count};orphans=${result.orphans.length}`,
				},
			)
		},
	})
