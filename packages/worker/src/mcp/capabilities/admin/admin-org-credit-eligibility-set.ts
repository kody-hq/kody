import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	AdminOrgBillingMutationError,
	setAdminOrgCreditEligibility,
} from '#worker/admin/org-billing-mutations.ts'
import {
	AdminOrgLimitOverrideError,
	orgLimitOverrideReasonMaxLength,
} from '#worker/admin/org-limit-overrides.ts'
import {
	orgAuditWriterForPerson,
	orgAuditWriterFromRequest,
} from '#worker/orgs/org-audit.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	resolveActingAdminPerson,
} from './admin-shared.ts'
import { adminOrgTargetSchema } from './org-limit-override-shared.ts'

const inputSchema = z.intersection(
	adminOrgTargetSchema,
	z.object({
		creditsEligible: z.boolean(),
		reason: z.string().min(1).max(orgLimitOverrideReasonMaxLength),
	}),
)

const outputSchema = z.object({
	orgId: z.string(),
	previous: z.boolean(),
	next: z.boolean(),
	changed: z.boolean(),
})

export const adminOrgCreditEligibilitySetCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminOrgCreditEligibilitySet',
		contextRuns: 'deny',
		description:
			'Turn admin credit eligibility on or off for one live organization. Requires a reason and writes platform and organization audit events.',
		keywords: ['admin', 'org', 'organization', 'credits', 'eligibility'],
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
				'adminOrgCreditEligibilitySet',
				async () => {
					try {
						return await setAdminOrgCreditEligibility({
							env: ctx.env,
							audit: {
								...audit,
								actorUserId: audit.actorUserId ?? admin.stableUserId,
							},
							target: { orgId: args.orgId, org: args.org },
							creditsEligible: args.creditsEligible,
							reason: args.reason,
							platformAudit: false,
						})
					} catch (error) {
						if (
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
						`org_id=${result.orgId};credits_eligible=${result.next};previous=${result.previous};changed=${result.changed};reason=${args.reason}`,
					skipSuccessAudit: (result) => !result.changed,
				},
			)
		},
	},
)
