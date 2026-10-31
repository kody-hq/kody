import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { resolvePlanWrite } from '#universal/plans.ts'
import {
	AdminOrgBillingMutationError,
	setAdminOrgPlan,
} from '#worker/admin/org-billing-mutations.ts'
import { FreeOrgLimitError } from '#worker/orgs/billing.ts'
import {
	adminMutationCapabilityAccess,
	adminUserMetadataSchema,
	auditAdminCapabilityInvocation,
	planNameSchema,
	stableUserIdSchema,
} from './admin-shared.ts'
import {
	legacyAuditWriter,
	legacyReason,
	resolveLegacyPersonalOrg,
} from './admin-legacy-billing.ts'
import { orgLimitOverrideReasonMaxLength } from '#worker/admin/org-limit-overrides.ts'

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
		reason: z
			.string()
			.trim()
			.max(orgLimitOverrideReasonMaxLength)
			.optional()
			.describe('Why the manual plan changed.'),
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
			'Deprecated: use adminOrgPlanSet with an org handle. Update account metadata for one user by stable user id, email, or username. Supports setting the manual entitlement grant on that user’s personal organization (null maps to free; Stripe subscriptions stay on stripe_plan). Admin-only; never touches user content. Use adminOrgPlanSet for plan changes on any organization.',
		keywords: ['admin', 'user', 'update', 'account', 'plan', 'entitlements'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const reason = legacyReason('adminUserUpdate', args.reason)
			const { admin, audit } = await legacyAuditWriter(ctx)
			return auditAdminCapabilityInvocation(
				ctx,
				'adminUserUpdate',
				async () => {
					const { user: target, orgId } = await resolveLegacyPersonalOrg(
						ctx,
						args,
					)
					try {
						await setAdminOrgPlan({
							env: ctx.env,
							audit: {
								...audit,
								actorUserId: audit.actorUserId ?? admin.stableUserId,
							},
							target: { orgId },
							plan: resolvePlanWrite(args.plan),
							reason,
							platformAudit: false,
						})
					} catch (error) {
						if (
							error instanceof FreeOrgLimitError ||
							error instanceof AdminOrgBillingMutationError
						) {
							throw new McpCallerError(error.message, { cause: error })
						}
						throw error
					}
					const { user } = await resolveLegacyPersonalOrg(ctx, {
						stableUserId: target.stableUserId,
					})
					return { user }
				},
				{
					successReason: ({ user }) =>
						`target_stable_user_id=${user.stableUserId};plan=${user.plan};reason=${reason}`,
				},
			)
		},
	},
)
