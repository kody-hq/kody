import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	applyAdminOrgLimitOverrideChanges,
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
import {
	adminOrgLimitsSchema,
	adminOrgTargetSchema,
	limitOverrideKeySchema,
	limitOverrideValueSchema,
} from './org-limit-override-shared.ts'

const inputSchema = z.intersection(
	adminOrgTargetSchema,
	z.object({
		changes: z
			.array(
				z.object({
					key: limitOverrideKeySchema,
					value: limitOverrideValueSchema
						.nullable()
						.describe(
							'New cap (whole number or "unlimited"), or null to remove the override.',
						),
					expiresAt: z
						.string()
						.nullable()
						.optional()
						.describe(
							'ISO 8601 instant the override stops applying. Omit or null for no expiry.',
						),
				}),
			)
			.min(1)
			.describe('One entry per limit key to set, change, or remove.'),
		reason: z
			.string()
			.min(1)
			.max(orgLimitOverrideReasonMaxLength)
			.describe('Why. Stored on the override and on every audit event.'),
	}),
)

const outputSchema = adminOrgLimitsSchema.extend({
	changedKeys: z
		.array(limitOverrideKeySchema)
		.describe('Keys that changed (unchanged entries are skipped).'),
})

export const adminOrgLimitOverridesSetCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminOrgLimitOverridesSet',
		contextRuns: 'deny',
		description:
			'Set, change, or remove admin limit overrides on any org (daily, weekly, and monthly caps). An override only raises: the enforced limit is the larger of the plan limit and the override. Takes effect on the next counted check. Credits and billing are unchanged. Every change writes an org audit event with the admin, old and new values, and the reason.',
		keywords: [
			'admin',
			'limits',
			'caps',
			'override',
			'raise',
			'unlimited',
			'entitlements',
			'quota',
			'org',
		],
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
				'adminOrgLimitOverridesSet',
				async () =>
					await applyAdminOrgLimitOverrideChanges({
						db: ctx.env.APP_DB,
						audit: {
							...audit,
							actorUserId: audit.actorUserId ?? admin.stableUserId,
						},
						target: { orgId: args.orgId, org: args.org },
						changes: args.changes,
						reason: args.reason,
					}),
				{
					successReason: (result) =>
						`org_id=${result.org.id};changed=${result.changedKeys.join(',') || 'none'}`,
				},
			)
		},
	},
)
