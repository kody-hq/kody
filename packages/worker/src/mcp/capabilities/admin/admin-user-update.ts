import { z } from 'zod'
import { updateAdminUserPlan } from '#worker/admin/users-data.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { resolvePlanWrite } from '#universal/plans.ts'
import {
	adminMutationCapabilityAccess,
	adminUserMetadataSchema,
	auditAdminCapabilityInvocation,
	planNameSchema,
	stableUserIdSchema,
} from './admin-shared.ts'

const inputSchema = z
	.object({
		stableUserId: stableUserIdSchema.optional(),
		email: z.string().email().optional().describe('Email address to update.'),
		username: z.string().min(1).optional().describe('Username to update.'),
		plan: planNameSchema
			.nullable()
			.describe(
				'Manual entitlement grant to set (orgs.plan on the personal org). Null maps to free (never persists NULL). Does not change the Stripe subscription.',
			),
	})
	.refine(
		(value) =>
			[value.stableUserId, value.email, value.username].filter(
				(item) => item !== undefined,
			).length === 1,
		{ message: 'Provide exactly one of stableUserId, email, or username.' },
	)

const outputSchema = z.object({
	user: adminUserMetadataSchema,
})

export const adminUserUpdateCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminUserUpdate',
		contextRuns: 'deny',
		description:
			'Update account metadata for one user by stable user id, email, or username. Supports setting the manual entitlement grant (null maps to free; Stripe subscriptions stay on stripe_plan). Admin-only; never touches user content.',
		keywords: ['admin', 'user', 'update', 'account', 'plan', 'entitlements'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminUserUpdate',
				async () => {
					const user = await updateAdminUserPlan(ctx.env.APP_DB, {
						stableUserId: args.stableUserId,
						email: args.email,
						username: args.username,
						plan: resolvePlanWrite(args.plan),
					})
					// Missing target is caller-supplied; keep off Sentry via McpCallerError.
					if (!user) {
						throw new McpCallerError('User not found.')
					}
					return { user }
				},
				{
					successReason: ({ user }) =>
						`target_stable_user_id=${user.stableUserId};plan=${user.plan}`,
				},
			)
		},
	},
)
