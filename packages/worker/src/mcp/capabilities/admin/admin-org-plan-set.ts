import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	AdminOrgBillingMutationError,
	setAdminOrgPlan,
} from '#worker/admin/org-billing-mutations.ts'
import {
	AdminOrgLimitOverrideError,
	orgLimitOverrideReasonMaxLength,
} from '#worker/admin/org-limit-overrides.ts'
import { FreeOrgLimitError } from '#worker/orgs/billing.ts'
import {
	orgAuditWriterForPerson,
	orgAuditWriterFromRequest,
} from '#worker/orgs/org-audit.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	planNameSchema,
	resolveActingAdminPerson,
} from './admin-shared.ts'
import { adminOrgTargetSchema } from './org-limit-override-shared.ts'

const inputSchema = z.intersection(
	adminOrgTargetSchema,
	z.object({
		plan: planNameSchema,
		reason: z.string().min(1).max(orgLimitOverrideReasonMaxLength),
	}),
)

const outputSchema = z.object({
	orgId: z.string(),
	previous: planNameSchema,
	next: planNameSchema,
	changed: z.boolean(),
})

export const adminOrgPlanSetCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminOrgPlanSet',
		contextRuns: 'deny',
		description:
			'Set the manual plan grant on one live organization. Stripe subscriptions are unchanged. A downgrade to free is blocked when it would exceed an owner’s two-free-organization cap. Requires a reason and writes platform and organization audit events.',
		keywords: ['admin', 'org', 'organization', 'plan', 'billing', 'grant'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const admin = await resolveActingAdminPerson(ctx)
			const audit = ctx.callerContext.request
				? orgAuditWriterFromRequest(ctx.env, ctx.callerContext.request)
				: orgAuditWriterForPerson(ctx.env, {
						userId: admin.stableUserId,
						username: admin.username,
					})
			return auditAdminCapabilityInvocation(
				ctx,
				'adminOrgPlanSet',
				async () => {
					try {
						return await setAdminOrgPlan({
							env: ctx.env,
							audit: {
								...audit,
								actorUserId: audit.actorUserId ?? admin.stableUserId,
							},
							target: { orgId: args.orgId, org: args.org },
							plan: args.plan,
							reason: args.reason,
							platformAudit: false,
						})
					} catch (error) {
						if (
							error instanceof FreeOrgLimitError ||
							error instanceof AdminOrgLimitOverrideError ||
							error instanceof AdminOrgBillingMutationError
						) {
							throw new McpCallerError(error.message, { cause: error })
						}
						throw error
					}
				},
				{
					successReason: (result) =>
						`org_id=${result.orgId};plan=${result.next};previous=${result.previous};changed=${result.changed};reason=${args.reason}`,
					skipSuccessAudit: (result) => !result.changed,
				},
			)
		},
	},
)
