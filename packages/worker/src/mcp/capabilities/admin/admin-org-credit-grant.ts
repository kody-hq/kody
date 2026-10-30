import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	AdminOrgBillingMutationError,
	grantAdminCreditsToOrg,
} from '#worker/admin/org-billing-mutations.ts'
import {
	AdminOrgLimitOverrideError,
	orgLimitOverrideReasonMaxLength,
} from '#worker/admin/org-limit-overrides.ts'
import {
	creditAdminGrantMaxCents,
	creditAdminGrantNoteMaxLength,
} from '#universal/credits.ts'
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
		amountCents: z
			.number()
			.int()
			.min(1)
			.max(creditAdminGrantMaxCents)
			.describe('House-funded prepaid credit grant, in whole US cents.'),
		reason: z
			.string()
			.min(1)
			.max(
				Math.min(
					orgLimitOverrideReasonMaxLength,
					creditAdminGrantNoteMaxLength,
				),
			),
	}),
)

const outputSchema = z.object({
	orgId: z.string(),
	entryId: z.string(),
	amountCents: z.number().int(),
})

export const adminOrgCreditGrantCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminOrgCreditGrant',
		contextRuns: 'deny',
		description:
			'Add a positive house-funded prepaid credit grant to one live organization wallet. No clawback or Stripe charge. Requires a reason and writes platform and organization audit events.',
		keywords: ['admin', 'org', 'organization', 'credits', 'wallet', 'grant'],
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
				'adminOrgCreditGrant',
				async () => {
					try {
						return await grantAdminCreditsToOrg({
							env: ctx.env,
							audit: {
								...audit,
								actorUserId: audit.actorUserId ?? admin.stableUserId,
							},
							target: { orgId: args.orgId, org: args.org },
							grantedBy: {
								stableUserId: admin.stableUserId,
								email: admin.email,
							},
							amountCents: args.amountCents,
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
						`org_id=${result.orgId};amount_cents=${result.amountCents};entry_id=${result.entryId};reason=${args.reason}`,
				},
			)
		},
	},
)
