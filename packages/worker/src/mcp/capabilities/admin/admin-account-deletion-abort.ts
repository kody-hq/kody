import { z } from 'zod'
import { abortAccountDeletingByStableUserId } from '#worker/account/deletion-state.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	adminStableOwnerId,
	stableUserIdSchema,
} from './admin-shared.ts'

export const adminAccountDeletionAbortCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminAccountDeletionAbort',
		contextRuns: 'deny',
		description:
			'Clear a leftover account-deletion fence (D1 users.deleting_at and the UserMeter tombstone) when cleanup never started or an operator needs to restore the account. Admin-only and destructive.',
		keywords: ['admin', 'account', 'deletion', 'fence', 'abort', 'repair'],
		destructive: true,
		inputSchema: z.object({
			stable_user_id: stableUserIdSchema,
			reason: z
				.string()
				.min(10)
				.describe(
					'Audit reason for clearing the leftover deletion fence, at least 10 characters.',
				),
		}),
		outputSchema: z.object({
			aborted: z.literal(true),
		}),
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminAccountDeletionAbort',
				async () => {
					try {
						await abortAccountDeletingByStableUserId({
							db: ctx.env.APP_DB,
							stableUserId: adminStableOwnerId(args.stable_user_id),
							env: ctx.env,
						})
					} catch (error) {
						// Missing target is caller-supplied; keep off Sentry via McpCallerError.
						if (
							error instanceof Error &&
							error.message === 'User not found.' &&
							!(error instanceof McpCallerError)
						) {
							throw new McpCallerError(error.message, { cause: error })
						}
						throw error
					}
					return { aborted: true as const }
				},
				{
					successReason: () =>
						`target_stable_user_id=${args.stable_user_id};reason=${args.reason}`,
				},
			)
		},
	},
)
