import { z } from 'zod'
import { loadAdminUserByTarget } from '#worker/admin/users-data.ts'
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
	orgAuditWriterForPerson,
	orgAuditWriterFromRequest,
} from '#worker/orgs/org-audit.ts'
import {
	adminMutationCapabilityAccess,
	adminUserMetadataSchema,
	auditAdminCapabilityInvocation,
	planNameSchema,
	stableUserIdSchema,
	resolveActingAdminPerson,
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
		reason: z.string().trim().max(500).optional(),
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
			'Deprecated: use adminOrgPlanSet / adminOrgCreditGrant / adminOrgCreditEligibilitySet / adminOrgGet with an org handle. Update account metadata for one user by stable user id, email, or username.',
		keywords: ['admin', 'user', 'update', 'account', 'plan', 'entitlements'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const admin = await resolveActingAdminPerson(ctx)
			const target = await loadAdminUserByTarget(ctx.env.APP_DB, args)
			if (!target) throw new McpCallerError('User not found.')
			const org = await ctx.env.APP_DB.prepare(
				`SELECT COALESCE(NULLIF(TRIM(personal_org_id), ''), stable_user_id) AS id
					 FROM users WHERE stable_user_id = ? AND deleted_at IS NULL`,
			)
				.bind(target.stableUserId)
				.first<{ id: string }>()
			if (!org) throw new McpCallerError('Personal organization not found.')
			const baseAudit = ctx.callerContext.request
				? orgAuditWriterFromRequest(ctx.env, ctx.callerContext.request)
				: orgAuditWriterForPerson(ctx.env, {
						userId: admin.stableUserId,
						username: admin.username,
					})
			return auditAdminCapabilityInvocation(
				ctx,
				'adminUserUpdate',
				async () => {
					try {
						await setAdminOrgPlan({
							env: ctx.env,
							audit: {
								...baseAudit,
								actorUserId: baseAudit.actorUserId ?? admin.stableUserId,
							},
							target: { orgId: org.id },
							plan: resolvePlanWrite(args.plan),
							reason:
								args.reason?.trim() ??
								'No reason given (legacy adminUserUpdate)',
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
					const user = await loadAdminUserByTarget(ctx.env.APP_DB, {
						stableUserId: target.stableUserId,
					})
					if (!user) throw new McpCallerError('User not found.')
					return { user }
				},
				{
					successReason: ({ user }) =>
						`target_stable_user_id=${user.stableUserId};plan=${user.plan};reason=${args.reason?.trim() ?? 'No reason given (legacy adminUserUpdate)'}`,
				},
			)
		},
	},
)
