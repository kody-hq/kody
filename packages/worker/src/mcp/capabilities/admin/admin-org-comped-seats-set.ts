import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	AdminOrgBillingMutationError,
	maxCompedSeats,
	setAdminOrgCompedSeats,
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
		compedSeats: z
			.number()
			.int()
			.min(1)
			.max(maxCompedSeats)
			.nullable()
			.describe('Seats the manual plan grant covers. Null removes the cap.'),
		reason: z.string().min(1).max(orgLimitOverrideReasonMaxLength),
	}),
)

const outputSchema = z.object({
	orgId: z.string(),
	previous: z.number().int().nullable(),
	next: z.number().int().nullable(),
	changed: z.boolean(),
	liveSeats: z.number().int(),
})

export const adminOrgCompedSeatsSetCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminOrgCompedSeatsSet',
		contextRuns: 'deny',
		description:
			'Cap how many seats (live Owners, Admins, and Members) a manual plan grant covers on one live organization, or pass null to remove the cap. While the org has no paid Stripe plan, invites, joins, and role changes that would add a seat past the cap are refused with a message for the org admins. Members already in the org keep their seats. Plan, credits, and Stripe are unchanged. Repeating the same value is a no-op. Requires a reason and writes platform and organization audit events.',
		keywords: ['admin', 'org', 'organization', 'seats', 'comp', 'cap', 'plan'],
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
				'adminOrgCompedSeatsSet',
				async () => {
					try {
						return await setAdminOrgCompedSeats({
							env: ctx.env,
							audit: {
								...audit,
								actorUserId: audit.actorUserId ?? admin.stableUserId,
							},
							target: { orgId: args.orgId, org: args.org },
							compedSeats: args.compedSeats,
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
						`org_id=${result.orgId};comped_seats=${result.next ?? 'none'};previous=${result.previous ?? 'none'};changed=${result.changed};reason=${args.reason}`,
					skipSuccessAudit: (result) => !result.changed,
				},
			)
		},
	},
)
