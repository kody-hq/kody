import { z } from 'zod'
import { listActiveAccountWriteLeases } from '#worker/account/deletion-state.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	adminStableOwnerId,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

export const adminAccountWriteLeaseListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminAccountWriteLeaseList',
		contextRuns: 'deny',
		description:
			'Inspect active non-expiring account write leases before manual repair. Admin-only.',
		keywords: ['admin', 'account', 'deletion', 'lease', 'repair'],
		inputSchema: z.object({
			stable_user_id: z.string().min(1),
		}),
		outputSchema: z.object({
			leases: z.array(
				z.object({
					token: z.string(),
					holder: z.string(),
					acquired_at: z.string(),
				}),
			),
		}),
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminAccountWriteLeaseList',
				async () => ({
					leases: await listActiveAccountWriteLeases(
						ctx.env,
						adminStableOwnerId(args.stable_user_id),
					),
				}),
			)
		},
	},
)
