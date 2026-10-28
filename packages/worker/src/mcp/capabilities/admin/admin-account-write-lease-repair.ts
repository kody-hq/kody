import { z } from 'zod'
import { repairAccountWriteLease } from '#worker/account/deletion-state.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	adminStableOwnerId,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

export const adminAccountWriteLeaseRepairCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminAccountWriteLeaseRepair',
		contextRuns: 'deny',
		description:
			'Manually release one inspected crashed-writer lease with an audit reason. Admin-only and destructive.',
		keywords: ['admin', 'account', 'deletion', 'lease', 'repair'],
		destructive: true,
		inputSchema: z.object({
			stable_user_id: z.string().min(1),
			token: z.string().uuid(),
			expected_acquired_at: z.string().min(1),
			reason: z.string().min(10),
		}),
		outputSchema: z.object({
			repaired: z.literal(true),
			repair_id: z.string().uuid(),
		}),
		async handler(args, ctx) {
			const repairedByUserId = ctx.callerContext.user?.userId
			if (!repairedByUserId) throw new Error('Admin user context is required.')
			return auditAdminCapabilityInvocation(
				ctx,
				'adminAccountWriteLeaseRepair',
				async () => {
					const result = await repairAccountWriteLease({
						db: ctx.env.APP_DB,
						stableUserId: adminStableOwnerId(args.stable_user_id),
						token: args.token,
						expectedAcquiredAt: args.expected_acquired_at,
						repairedByUserId,
						reason: args.reason,
						env: ctx.env,
					})
					return {
						repaired: result.repaired,
						repair_id: result.repairId,
					}
				},
				{
					successReason: () =>
						`target=${args.stable_user_id};token=${args.token};reason=${args.reason}`,
				},
			)
		},
	},
)
